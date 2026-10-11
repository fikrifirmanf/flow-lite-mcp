import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { HOME_DIR } from "./chrome.js";
import { shapes, type Core } from "./core.js";
import { ENV_LIMITS, limitsShape } from "./limits.js";

// Some MCP apps start several copies of an MCP server at once. Two copies driving one Flow tab with two
// queues is how the original flow-mcp paid for a shot twice, so exactly one process owns Flow: whoever binds this
// port. Everyone else forwards calls to it over localhost, authenticated with a per-run token.
const PORT = Number(process.env.FLOW_LITE_PORT ?? 8788);
const TOKEN_FILE = join(HOME_DIR, "token");
const BASE = `http://127.0.0.1:${PORT}`;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) req.destroy(new Error("Body too large."));
      else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString()));
    req.on("error", fail);
  });
}

export async function becomeOwnerOrClient(local: Core): Promise<Core> {
  const token = randomBytes(24).toString("hex");
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      // Host check stops DNS rebinding; the token stops other local pages and programs from spending credits.
      if (!hosts.has(req.headers.host ?? "")) return send(403, { error: "Bad host." });
      if (req.url === "/health") return tokenReady ? send(200, { name: "flow-lite-mcp" }) : send(503, { starting: true });
      if (req.headers["x-flow-lite-token"] !== token) return send(401, { error: "Missing or wrong token." });
      const method = req.url?.match(/^\/api\/(\w+)$/)?.[1];
      if (req.method !== "POST" || !method || !(method in shapes)) return send(404, { error: "Not found." });
      const args = z.object(shapes[method as keyof typeof shapes]).parse(JSON.parse((await body(req)) || "{}"));
      // The calling app's own limits ride along, and the owner applies whichever is tighter.
      const caller = limitsShape.parse(JSON.parse(String(req.headers["x-flow-lite-limits"] ?? "{}")));
      send(200, await (local[method as keyof Core] as (a: unknown, caller: unknown) => Promise<unknown>)(args, caller));
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String((err as Error)?.message ?? err);
      send(400, { error: message });
    }
  });

  // The token must be on disk before the port answers, or a fast client reads a missing (or stale) token. Each
  // process writes its own file; only the one that wins the port moves it into place.
  mkdirSync(HOME_DIR, { recursive: true });
  const mine = `${TOKEN_FILE}.${process.pid}`;
  writeFileSync(mine, token, { mode: 0o600 });
  let tokenReady = false;
  const bound = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => {
      renameSync(mine, TOKEN_FILE);
      tokenReady = true;
      ok(true);
    });
  });
  if (bound) return local;
  rmSync(mine, { force: true });

  // The port is taken. A sibling that is still booting, or busy inside a browser call, can miss one health check,
  // so keep asking for a while. Only a clear answer from some OTHER program makes driving Flow ourselves safe.
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json(), () => null)) as {
      name?: string;
      starting?: boolean;
    } | null;
    if (other?.name === "flow-lite-mcp") return remote();
    if (other && !other.starting) {
      server.close();
      throw new Error(`Port ${PORT} belongs to another program. Set FLOW_LITE_PORT to a free port.`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port: most likely a busy sibling. A client whose calls fail loudly
  // is far better than a second driver quietly spending credits.
  return remote();
}

function remote(): Core {
  const call = async (method: string, args: unknown = {}) => {
    const res = await fetch(`${BASE}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flow-lite-token": readFileSync(TOKEN_FILE, "utf8").trim(),
        "x-flow-lite-limits": JSON.stringify(ENV_LIMITS),
      },
      body: JSON.stringify(args),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  return Object.fromEntries(Object.keys(shapes).map((m) => [m, (a: unknown) => call(m, a)])) as unknown as Core;
}
