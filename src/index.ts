#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalCore, shapes } from "./core.js";
import { becomeOwnerOrClient } from "./owner.js";

// `npx flow-lite-mcp login` opens the window for signing in; login.js exits when done.
if (process.argv[2] === "login") await import("./login.js");

const local = new LocalCore();
const core = await becomeOwnerOrClient(local);
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "flow-lite-mcp", version });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>): Promise<Result> => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
  }
};

// Most MCP clients give up on a call after about 60 s, and the work keeps going while the app reports "timed out",
// which invites a paid retry. So nothing here holds on longer than PATIENCE_MS: a slower call returns a task id and
// keeps running, and flow_wait collects it.
const PATIENCE_MS = Number(process.env.FLOW_LITE_PATIENCE_MS ?? 45_000);
const WAIT_CAP_S = Math.max(5, Math.floor(PATIENCE_MS / 1000) - 5);
type Task = { task_id: string; tool: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };
const tasks = new Map<string, Task>();

async function patient(tool: string, work: Promise<unknown>): Promise<unknown> {
  const task: Task = { task_id: `task-${randomUUID().slice(0, 8)}`, tool, status: "running" };
  const settled = work.then(
    (result) => Object.assign(task, { status: "done", result }),
    (err) => Object.assign(task, { status: "failed", error: err instanceof Error ? err.message : String(err) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Still working; this is not a failure. Call flow_wait with job_ids ["${task.task_id}"], and do not call ${tool} again.`,
  };
}

server.registerTool(
  "flow_status",
  {
    description:
      "Call first. Shows whether the Flow Chrome window is signed in with a project open, the plan and credits left, the user's spending limits, the job queue, and prompting tips. If it returns a hint, relay it and stop.",
    inputSchema: shapes.status,
  },
  async () =>
    reply(
      patient("flow_status", core.status()).then((s) => ({
        ...(s as object),
        // Menu read live 2026-10-09 (Pro plan); Flow's own quote is what the spend guard actually uses.
        models: {
          "Nano Banana Pro": "image, 0 credits",
          "Nano Banana 2.1": "image, 0 credits (Flow's default)",
          "Nano Banana 2 Lite": "image, 0 credits",
          "Omni 1.1 Flash": "video, cheapest: 720p 7/10/12/15 credits and 360p 4/5/6/7 for 4/6/8/10 s. Only model with duration and resolution choices.",
          "Veo 3.1 - Lite": "video, 10 credits, fixed 8 s",
          "Veo 3.1 - Fast": "video, 20 credits, fixed 8 s",
          "Veo 3.1 - Quality": "video, 100 credits, fixed 8 s: raise max_credits explicitly",
        },
        tips: [
          "Stills cost 0 credits: lock the look with stills before spending on video.",
          "Tell the user the expected credit total and get their OK before queueing video.",
          "Send all scenes of a piece in ONE flow_generate call so the files are numbered in order.",
          "Prompt order: subject and action, shot size and camera move, location, style, lighting, sound.",
          "One specific action with a beginning and an end per shot; aimless continuous activity loops.",
          "If a paid file did not arrive, use flow_download (free). Never generate it again.",
        ],
      })),
    ),
);

server.registerTool(
  "flow_generate",
  {
    description:
      "Queue scenes in Google Flow. Images cost 0 credits; videos cost credits (Omni 1.1 Flash 720p: 7/10/12/15 for 4/6/8/10 s; Veo 3.1 Lite 10, Fast 20, Quality 100). Flow's own quote is read first and the scene is skipped if above max_credits (default 25). Ask the user before queueing anything that costs credits. The user may also have set hard limits per scene and per day (flow_status shows them); no argument here can raise those. Returns job ids for flow_wait.",
    inputSchema: shapes.generate,
  },
  async (args) => reply(core.generate(args)),
);

server.registerTool(
  "flow_wait",
  {
    description: `Wait for jobs (or task ids from a slow call) and return their files. Answers within about ${WAIT_CAP_S} s; call again until finished is true.`,
    inputSchema: shapes.wait,
  },
  async ({ job_ids, timeout_seconds }) => {
    const timeout = Math.min(timeout_seconds, WAIT_CAP_S);
    const mine = (job_ids ?? []).filter((id) => id.startsWith("task-"));
    const jobs = job_ids?.filter((id) => !id.startsWith("task-"));
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) await new Promise((r) => setTimeout(r, 1000));
    const taskInfo = mine.map(
      (id) => tasks.get(id) ?? { task_id: id, status: "unknown", note: "This server restarted since that call. Check flow_assets for what it did." },
    );
    const left = Math.max(1, Math.round((deadline - Date.now()) / 1000));
    const queue = mine.length && !jobs?.length ? undefined : ((await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean });
    return reply(
      Promise.resolve({
        ...queue,
        ...(mine.length && { tasks: taskInfo }),
        finished: (queue?.finished ?? true) && taskInfo.every((t) => t.status !== "running"),
      }),
    );
  },
);

server.registerTool("flow_cancel", { description: "Cancel a job that has not started yet.", inputSchema: shapes.cancel }, async (args) =>
  reply(core.cancel(args)),
);

server.registerTool(
  "flow_project",
  {
    description:
      "Pick the Flow project to work in, so the user never has to: list projects (newest first; untitled ones are named by date), open one by exact title or id, or create a new empty one. Refused while scenes are queued or running.",
    inputSchema: shapes.project,
  },
  async (args) => reply(patient("flow_project", core.project(args))),
);

server.registerTool(
  "flow_assets",
  { description: "List the images, videos and scenes already in the open Flow project, with their exact titles.", inputSchema: shapes.assets },
  async () => reply(patient("flow_assets", core.assets())),
);

server.registerTool(
  "flow_download",
  {
    description:
      "Download something already in the Flow project by its exact title. Free, including the upscaled version. Use this, never a new generation, when a paid file did not arrive.",
    inputSchema: shapes.download,
  },
  async (args) => reply(patient("flow_download", core.download(args))),
);

// When the app disconnects, the localhost API would otherwise keep this process (and the port) alive forever.
// An owner first lets its queue finish: leaving mid-render would abandon work that is already being paid for.
process.stdin.on("close", () => {
  const unfinished = () => local.queue.list().some((j) => j.status === "queued" || j.status === "running");
  const exitWhenIdle = () => (unfinished() ? setTimeout(exitWhenIdle, 2000) : process.exit(0));
  exitWhenIdle();
});

await server.connect(new StdioServerTransport());
