import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { downloadAsset, getState, listAssets, listProjects, newProject, openProject, runGeneration } from "./flow.js";
import { JobQueue, type Job } from "./queue.js";

export const OUTPUT_ROOT = process.env.FLOW_LITE_OUTPUT ?? join(homedir(), "flow-lite-out");

const project = z
  .string()
  .regex(/^[\w.-]+$/, "letters, digits, dot, dash and underscore only")
  .describe("Local folder under ~/flow-lite-out for the files (not the Flow project; flow_project picks that)");

const scene = z.object({
  prompt: z.string().min(1).describe("One continuous shot. Repeat a recurring character's full description in every scene."),
  type: z.enum(["image", "video"]).default("image").describe("Images cost 0 credits on a Pro plan (all three Nano Banana models); videos cost credits"),
  model: z
    .string()
    .optional()
    .describe(
      'Model as Flow names it. Image: "Nano Banana Pro", "Nano Banana 2.1", "Nano Banana 2 Lite". Video: "Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality". The exact name wins; a partial name must match only one model ("Pro", "Fast"). Omit to keep what Flow has selected. An unknown or ambiguous name fails with the list Flow offers.',
    ),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video: 16:9 or 9:16 only"),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Seconds; Omni models only"),
  resolution: z.enum(["360p", "720p"]).optional().describe("Omni models only"),
  variants: z.number().int().min(1).max(4).optional(),
  max_credits: z.number().int().min(0).optional().describe("Skip the scene if Flow's own quote is higher. Default 25"),
});

// Shapes are shared by the MCP tools and the localhost API, so both validate the same way.
export const shapes = {
  status: {},
  generate: {
    project,
    scenes: z.array(scene).min(1).max(50).describe("Scenes in order; files are named scene-01, scene-02, ..."),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Jobs to wait for; omit for all"),
    timeout_seconds: z.number().int().min(1).max(600).default(40),
  },
  cancel: { job_id: z.string() },
  project: {
    action: z.enum(["list", "open", "new"]).describe("list = projects newest first; open = switch to one; new = create an empty one and open it"),
    project: z.string().optional().describe("For open: the project's exact title or its id from list"),
  },
  assets: {},
  download: {
    project,
    name: z.string().describe("Exact title as flow_assets lists it"),
    quality: z.enum(["original", "upscaled"]).default("original").describe("upscaled = free 1080p / 2K, can take minutes"),
  },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export interface Core {
  status(a?: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  project(a: Args<"project">): Promise<unknown>;
  assets(a?: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
}

const summary = (j: Job) => ({
  id: j.id,
  status: j.status,
  prompt: j.scene.prompt.slice(0, 80),
  credits: j.credits,
  progress: j.progress,
  files: j.files,
  error: j.error,
});

// Next free number in a folder, so a later call never overwrites an earlier file.
function nextNumber(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir)
    .map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1]))
    .filter((n) => !Number.isNaN(n));
  return used.length ? Math.max(...used) + 1 : 1;
}

export class LocalCore implements Core {
  readonly queue = new JobQueue(runGeneration);

  // The browser is shared, so anything that clicks around waits until no generation is running.
  private idle() {
    if (this.queue.busy) throw new Error("A generation is running in Flow right now. Try again when flow_wait says it has finished.");
  }

  async status() {
    const flow = await getState(!this.queue.busy).catch((err: Error) => ({ error: err.message }));
    return { flow, queue: this.queue.list().map(summary), pacing: this.queue.waiting, output_root: OUTPUT_ROOT };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const dir = join(OUTPUT_ROOT, project);
    const first = nextNumber(dir, "scene");
    const jobs = scenes.map((s, i) =>
      this.queue.add({
        ...s,
        max_credits: s.max_credits ?? 25,
        output_dir: dir,
        file_stem: `scene-${String(first + i).padStart(2, "0")}`,
      }),
    );
    return { queued: jobs.map(summary), note: "Scenes run one at a time with a 25-70 s pause between them. Call flow_wait for results." };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => this.queue.list().filter((j) => !job_ids?.length || job_ids.includes(j.id));
    const open = () => pick().some((j) => j.status === "queued" || j.status === "running");
    const deadline = Date.now() + timeout_seconds * 1000;
    while (open() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    const unknown = (job_ids ?? []).filter((id) => !this.queue.get(id));
    return {
      finished: !open(),
      jobs: pick().map(summary),
      pacing: this.queue.waiting,
      ...(unknown.length && {
        unknown,
        note: "Those ids are not in this queue (the server restarted?). The work may still have happened: check flow_assets before running anything again.",
      }),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job ${job_id}.`);
    return summary(job);
  }

  // Switching projects mid-generation would strand the render, so it waits for an idle browser and an empty queue.
  async project({ action, project }: Args<"project">) {
    if (action === "list") {
      this.idle();
      return listProjects();
    }
    if (this.queue.list().some((j) => j.status === "queued" || j.status === "running")) {
      throw new Error("Scenes are still queued or running in this project. Wait for them (flow_wait) or cancel them first.");
    }
    if (action === "new") return newProject();
    if (!project) throw new Error('action "open" needs project: a title or id from flow_project list.');
    return openProject(project);
  }

  async assets() {
    this.idle();
    return listAssets();
  }

  async download({ project, name, quality }: Args<"download">) {
    this.idle();
    const dir = join(OUTPUT_ROOT, project);
    const stem = join(dir, `clip-${String(nextNumber(dir, "clip")).padStart(2, "0")}`);
    return { files: await downloadAsset(name, stem, quality) };
  }
}
