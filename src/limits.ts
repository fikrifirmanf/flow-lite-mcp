import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HOME_DIR } from "./chrome.js";

// Spending limits come only from the environment the user configured the server with. No tool argument can raise
// them, so an agent that ignores "ask before spending" still cannot spend past them.
export const limitsShape = z.object({
  per_scene: z.number().int().min(0).optional(),
  daily: z.number().int().min(0).optional(),
});
export type Limits = z.infer<typeof limitsShape>;

export const ONLY_USER = "Only the user can change this, in the MCP server's configuration. Tell them; do not work around it.";

const problems: string[] = [];
function fromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  // A limit that cannot be read must not quietly become "no limit".
  problems.push(`${name}="${raw}" is not a whole number, so it counts as 0 until the user fixes it.`);
  return 0;
}

export const ENV_LIMITS: Limits = { per_scene: fromEnv("FLOW_LITE_MAX_CREDITS"), daily: fromEnv("FLOW_LITE_DAILY_CREDITS") };

// Several apps can share one owner process, each configured differently. The tightest limit applies, so the app
// that happened to start first cannot loosen what the user set in another.
const least = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
export const strictest = (a: Limits, b: Limits = {}): Limits => ({ per_scene: least(a.per_scene, b.per_scene), daily: least(a.daily, b.daily) });

// What flow-lite itself has submitted today (local date). It is kept on disk so restarting the app does not reset
// the budget. Flow's own balance (flow_status) remains the real record of what was charged.
const LEDGER = join(HOME_DIR, "spend.json");
const today = () => new Date().toLocaleDateString("sv");
let memory = { day: today(), credits: 0 };

export function spentToday(): number {
  let onDisk = 0;
  try {
    const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as { day?: string; credits?: number };
    if (ledger.day === today() && Number.isFinite(ledger.credits)) onDisk = Math.max(0, Number(ledger.credits));
  } catch {
    // No ledger yet.
  }
  return Math.max(onDisk, memory.day === today() ? memory.credits : 0);
}

// Negative amounts give back a charge Flow itself says it did not make.
export function addSpend(credits: number): void {
  memory = { day: today(), credits: Math.max(0, spentToday() + credits) };
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${LEDGER}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(memory));
    renameSync(tmp, LEDGER);
  } catch {
    // The in-memory count still holds for this process.
  }
}

export function overBudget(credits: number, limits: Limits): string | null {
  if (!credits || limits.daily === undefined) return null;
  const spent = spentToday();
  if (spent + credits <= limits.daily) return null;
  return `Flow quotes ${credits} credits, but only ${Math.max(0, limits.daily - spent)} of the user's daily budget of ${limits.daily} is left (FLOW_LITE_DAILY_CREDITS; ${spent} spent today through flow-lite). Nothing was generated. ${ONLY_USER}`;
}

export function describeLimits(limits: Limits) {
  const spent = spentToday();
  return {
    max_credits_per_scene: limits.per_scene ?? "not set",
    daily_credits: limits.daily ?? "not set",
    spent_today: spent,
    ...(limits.daily !== undefined && { left_today: Math.max(0, limits.daily - spent) }),
    note: "Set by the user (FLOW_LITE_MAX_CREDITS, FLOW_LITE_DAILY_CREDITS). No tool can change them. If one blocks a job, tell the user instead of working around it.",
    ...(problems.length && { problems }),
  };
}
