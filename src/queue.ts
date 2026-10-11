import { randomUUID } from "node:crypto";
import type { Limits } from "./limits.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Scene {
  prompt: string;
  type: "image" | "video";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  variants?: number;
  max_credits: number;
  // The user's limits in force when this was queued (see limits.ts).
  limits: Limits;
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  scene: Scene;
  files: string[];
  credits?: number;
  progress?: string;
  error?: string;
  created: string;
  finished?: string;
}

const PAUSE_MIN_MS = Number(process.env.FLOW_LITE_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_LITE_PAUSE_MAX_S ?? 70) * 1000;

// One generation at a time with a random pause between them, the pace a person would work at.
// Nothing is retried automatically: a timed-out generation may still have been charged.
export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  waiting: string | null = null;

  constructor(private run: (job: Job) => Promise<string[]>) {}

  add(scene: Scene): Job {
    const job: Job = { id: randomUUID().slice(0, 8), status: "queued", scene, files: [], created: new Date().toISOString() };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job?.status === "queued") {
      job.status = "cancelled";
      job.finished = new Date().toISOString();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let job = this.next(); job; job = this.next()) {
        if (this.lastFinished) {
          const wait = this.lastFinished + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS) - Date.now();
          if (wait > 0) {
            this.waiting = `pacing: next generation in ${Math.ceil(wait / 1000)} s`;
            await new Promise((r) => setTimeout(r, wait));
            this.waiting = null;
          }
          // It may have been cancelled during the pause.
          if (job.status !== "queued") continue;
        }
        job.status = "running";
        try {
          job.files = await this.run(job);
          job.status = "done";
        } catch (err) {
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);
        }
        job.progress = undefined;
        job.finished = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }

  private next(): Job | undefined {
    return this.list().find((j) => j.status === "queued");
  }
}
