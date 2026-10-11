# flow-lite-mcp

A small local MCP server that lets an AI agent (Claude, Antigravity, Gemini CLI, Codex, Cursor, any MCP app) drive **Google Flow** (flow.google.com) through its
real web page, spending Flow's own credits (50 free a day with any Google account) instead of the paid video API.

```
agent ──stdio──> flow-lite-mcp ──Chrome DevTools Protocol──> Chrome (its own profile) ──> Flow
```

> **Experimental, unofficial, at your own risk.** Not affiliated with Google. It automates Flow's web page, which
> may be against Google's terms of service, and it breaks whenever Google changes that page. Tested on macOS with
> Claude Code (images end to end) and confirmed working on Windows. Video and Linux are not yet verified.

Inspired by [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp), rewritten as a smaller core: generate stills
and clips, wait, download and list. No characters, agent mode, narration or FFmpeg cut yet.

## Needs

- macOS or Windows (both tested), or Linux (untested), Node.js 22+, Google Chrome, a Google account
- A Mac that stays awake while it runs. The Chrome window is really being driven; set `FLOW_LITE_WINDOW=minimized`
  to keep it minimised. There is no headless mode: headless Chrome can't read the saved Google login on macOS
  (and trying it signs the profile out)

## Install

Sign in once (opens a dedicated Chrome window, profile in `~/.flow-lite/chrome-profile`, separate from your own
Chrome):

```bash
npx -y flow-lite-mcp login
```

Sign in to Google **yourself** and leave the window open. That's the only manual step: your agent picks or creates the
project with `flow_project`. The program never types your password, and the login survives restarts.

## Connect

It is a plain MCP server over stdio, so every MCP app starts it the same way: `npx -y flow-lite-mcp`. Most apps use
this JSON; only the file differs:

```json
{
  "mcpServers": {
    "flow-lite": {
      "command": "npx",
      "args": ["-y", "flow-lite-mcp"],
      "env": { "FLOW_LITE_WINDOW": "minimized", "FLOW_LITE_MAX_CREDITS": "25", "FLOW_LITE_DAILY_CREDITS": "100" }
    }
  }
}
```

| App | Where it goes |
|---|---|
| Antigravity (desktop and CLI) | `~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json` in one project. Desktop: `…` in the agent panel → MCP Servers → Manage MCP Servers → View raw config. CLI: `/mcp` shows status and reloads |
| Gemini CLI | `~/.gemini/settings.json` (check with `/mcp`) |
| Claude Desktop | `claude_desktop_config.json` (Settings → Developer → Edit Config) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Apps with their own command or format:

```bash
claude mcp add --scope user flow-lite -e FLOW_LITE_WINDOW=minimized -e FLOW_LITE_MAX_CREDITS=25 -e FLOW_LITE_DAILY_CREDITS=100 -- npx -y flow-lite-mcp
```

```bash
codex mcp add flow-lite --env FLOW_LITE_WINDOW=minimized --env FLOW_LITE_MAX_CREDITS=25 --env FLOW_LITE_DAILY_CREDITS=100 -- npx -y flow-lite-mcp
```

VS Code (`.vscode/mcp.json`, or the command *MCP: Open User Configuration*) uses `servers` instead of `mcpServers`:

```json
{ "servers": { "flow-lite": { "type": "stdio", "command": "npx", "args": ["-y", "flow-lite-mcp"], "env": { "FLOW_LITE_WINDOW": "minimized" } } } }
```

Restart the app, then ask: *"check my Flow session"*.

- **Tested:** Claude Code. The other entries follow each app's own documentation (October
  2026) and have not been run by this project; if one is wrong, the app's MCP settings page has the current form.
- **Windows:** if an app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "flow-lite-mcp"]`.
- **Several apps at once** is fine: they share one Chrome window and one queue, and the tightest spending limit
  among them applies.

## Spending limits

Two settings that only you can change, because they live in the app's MCP configuration and not in anything the
agent can pass:

- `FLOW_LITE_MAX_CREDITS`: the most one scene may cost. The agent's own `max_credits` (default 25) cannot go above it.
- `FLOW_LITE_DAILY_CREDITS`: the most flow-lite may submit per day (local date). Counted when a generation is
  submitted, kept in `~/.flow-lite/spend.json` so restarting the app does not reset it, and given back only when
  Flow itself says a failed render was not charged.

Both are checked against the price Flow quotes, before anything is generated. Unset means no limit; a value that
is not a whole number counts as 0. Images cost 0 credits and are never blocked. Tool descriptions also tell the
agent to ask you before spending, but not every model obeys text: these two hold whatever the model does.
`flow_status` shows the limits and what is left today. They are a guard against a careless agent, not a sandbox:
an agent with shell access to your machine could edit its own configuration.

## Tools

| Tool | What it does |
|---|---|
| `flow_status` | Signed in? Project open? Plan, credits left, your spending limits, the queue, prompting tips |
| `flow_generate` | Queue scenes (image or video, model, aspect, duration, resolution, x1–x4). Reads Flow's own price first and skips a scene above `max_credits` (default 25) |
| `flow_wait` | Collect results. Answers within ~40 s; call again until `finished` |
| `flow_cancel` | Drop a job that hasn't started |
| `flow_project` | List your Flow projects, open one by title or id, or create a new one, so you never pick it by hand |
| `flow_assets` | List what's in the Flow project |
| `flow_download` | Download something already in Flow, free (including upscaled). Use it whenever a paid file didn't arrive |

Files land in `~/flow-lite-out/<project>/scene-NN.ext` (downloads as `clip-NN`). Numbers continue, never overwrite.

## How it stays safe

- **One driver.** Apps start several copies of an MCP server at once. The first to bind `127.0.0.1:8788` owns
  Chrome and the queue; the rest forward to it (token in `~/.flow-lite/token`). Never two queues spending credits.
- **No call over ~45 s.** MCP apps give up after ~60 s while the work carries on, which invites a paid retry.
  Slow calls return a `task_id`; `flow_wait` collects it.
- **Spend guard.** Flow's own quote is read before every generation and checked against the agent's `max_credits`
  and your own limits (above).
- **Human pace.** One generation at a time, 25–70 s pause between. It does nothing to evade Flow's reCAPTCHA.
- **No automatic retries** of timeouts (they may already be charged). Only Flow's own free Retry on a
  "failed, you were not charged" tile is pressed, once.

## Settings

`FLOW_LITE_PORT` (8788) · `FLOW_LITE_CDP_PORT` (9334) · `FLOW_LITE_HOME` (~/.flow-lite) ·
`FLOW_LITE_OUTPUT` (~/flow-lite-out) · `FLOW_LITE_MAX_CREDITS` / `FLOW_LITE_DAILY_CREDITS` (spending limits) · `FLOW_LITE_WINDOW` (`visible`, or `minimized` to keep the Flow window out of
sight) · `FLOW_LITE_CHROME` · `FLOW_LITE_PAUSE_MIN_S` / `_MAX_S` · `FLOW_LITE_PATIENCE_MS`

## Develop

From a checkout of the source: `npm install`, then `npm test` (builds, then an offline check that starts five
servers at once on a scratch port and checks one owner, shared queue and validation; it never opens Chrome or
spends credits). To run a checkout instead of the published package, point the MCP config at
`node /path/to/dist/index.js`.

## Risk

This automates Flow's web interface. It breaks when Google changes the page, and automated use may be against
Google's terms of service. Use it on your own account, at your own risk.
