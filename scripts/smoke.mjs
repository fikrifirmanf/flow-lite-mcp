// Offline smoke test: never opens Chrome and never spends credits.
// Starts several servers at once on a scratch port and home, like Claude Desktop does, and checks that exactly one
// owns Flow while the rest forward to it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "flow-lite-smoke-"));
const env = { ...process.env, FLOW_LITE_HOME: home, FLOW_LITE_PORT: "8798", FLOW_LITE_CDP_PORT: "9398" };
const entry = new URL("../dist/index.js", import.meta.url).pathname;

const clients = await Promise.all(
  Array.from({ length: 5 }, async (_, i) => {
    const c = new Client({ name: `smoke-${i}`, version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
    return c;
  }),
);
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = r.content[0].text;
  try {
    return { error: r.isError, body: JSON.parse(text) };
  } catch {
    return { error: true, body: { error: text } };
  }
};
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const tools = (await clients[0].listTools()).tools.map((t) => t.name).sort();
check(tools.join() === "flow_assets,flow_cancel,flow_download,flow_generate,flow_project,flow_status,flow_wait", `tools: ${tools.join(", ")}`);

// Every client must see the same (empty) queue: one owner, the rest forwarding.
const waits = await Promise.all(clients.map((c) => call(c, "flow_wait", { timeout_seconds: 1 })));
check(waits.every((w) => !w.error && w.body.finished === true && w.body.jobs.length === 0), "all 5 processes answer flow_wait from one queue");
for (const w of waits) if (w.error) console.log("     ", w.body.error);

const bad = await call(clients[1], "flow_generate", { project: "../escape", scenes: [{ prompt: "x" }] });
check(bad.error, "project names that leave the output folder are refused");

const unknown = await call(clients[2], "flow_cancel", { job_id: "nope" });
check(unknown.error && /No job/.test(unknown.body.error), "cancelling an unknown job is an error");

const task = await call(clients[3], "flow_wait", { job_ids: ["task-deadbeef"], timeout_seconds: 1 });
check(task.body.tasks?.[0]?.status === "unknown", "an unknown task id says the server restarted instead of claiming success");

const noName = await call(clients[4], "flow_project", { action: "open" });
check(noName.error && /needs project/.test(noName.body.error), "opening a project without a name is refused before touching Chrome");

// Model matching against the menu Flow showed live on 2026-10-09.
const { chooseModel, modelName } = await import(new URL("../dist/flow.js", import.meta.url).href);
const menu = ["🍌 Nano Banana Pro", "🍌 Nano Banana 2 Lite", "🍌 Nano Banana 2.1"].map(modelName);
check(modelName("volume_up Omni 1.1 Flash") === "Omni 1.1 Flash" && modelName("🍌 Nano Banana 2.1\narrow_drop_down") === "Nano Banana 2.1", "icons and ligatures are stripped from model names");
check(menu[chooseModel(menu, "nano banana pro")] === "Nano Banana Pro" && menu[chooseModel(menu, "Pro")] === "Nano Banana Pro", "Nano Banana Pro by full or partial name");
check(menu[chooseModel(menu, "Nano Banana 2.1")] === "Nano Banana 2.1", "exact name beats a longer partial match");
let ambiguous = "";
try { chooseModel(menu, "Nano Banana 2"); } catch (e) { ambiguous = e.message; }
check(/several models/.test(ambiguous), "an ambiguous name is refused instead of silently picking 2 Lite");

await Promise.all(clients.map((c) => c.close()));
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
