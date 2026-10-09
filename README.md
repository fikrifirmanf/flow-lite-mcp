# flow-lite-mcp

A small local MCP server that lets Claude (or any MCP app) drive **Google Flow** (flow.google.com) through its
real web page, spending Flow's own credits (50 free a day with any Google account) instead of the paid video API.

```
Claude ──stdio──> flow-lite-mcp ──Chrome DevTools Protocol──> Chrome (its own profile) ──> Flow
```

> **Experimental, unofficial, at your own risk.** Not affiliated with Google. It automates Flow's web page, which
> may be against Google's terms of service, and it breaks whenever Google changes that page. Tested so far on macOS
> with a Pro plan (images end to end); video, Windows and Linux are not yet verified.

Inspired by [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp), rewritten as a smaller core: generate stills
and clips, wait, download and list. No characters, agent mode, narration or FFmpeg cut yet.

## Needs

- macOS (tested), Windows or Linux (untested), Node.js 22+, Google Chrome, a Google account
- A Mac that stays awake while it runs. The Chrome window is really being driven; set `FLOW_LITE_WINDOW=minimized`
  to keep it minimised. There is no headless mode: headless Chrome can't read the saved Google login on macOS
  (and trying it signs the profile out)

## Install

Sign in once (opens a dedicated Chrome window, profile in `~/.flow-lite/chrome-profile`, separate from your own
Chrome):

```bash
npx -y flow-lite-mcp login
```

Sign in to Google **yourself** and leave the window open. That's the only manual step: Claude picks or creates the
project with `flow_project`. The program never types your password, and the login survives restarts.

## Connect

Claude Code (all projects):

```bash
claude mcp add --scope user flow-lite -e FLOW_LITE_WINDOW=minimized -- npx -y flow-lite-mcp
```

Claude Desktop, or any MCP app (`claude_desktop_config.json` on Claude Desktop):

```json
{ "mcpServers": { "flow-lite": { "command": "npx", "args": ["-y", "flow-lite-mcp"], "env": { "FLOW_LITE_WINDOW": "minimized" } } } }
```

Then ask: *"check my Flow session"*.

## Tools

| Tool | What it does |
|---|---|
| `flow_status` | Signed in? Project open? Plan, credits left, the queue, prompting tips |
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
- **Spend guard.** Flow's own quote is read before every generation.
- **Human pace.** One generation at a time, 25–70 s pause between. It does nothing to evade Flow's reCAPTCHA.
- **No automatic retries** of timeouts (they may already be charged). Only Flow's own free Retry on a
  "failed, you were not charged" tile is pressed, once.

## Settings

`FLOW_LITE_PORT` (8788) · `FLOW_LITE_CDP_PORT` (9334) · `FLOW_LITE_HOME` (~/.flow-lite) ·
`FLOW_LITE_OUTPUT` (~/flow-lite-out) · `FLOW_LITE_WINDOW` (`visible`, or `minimized` to keep the Flow window out of
sight) · `FLOW_LITE_CHROME` · `FLOW_LITE_PAUSE_MIN_S` / `_MAX_S` · `FLOW_LITE_PATIENCE_MS`

## Develop

```bash
git clone https://github.com/fikrifirmanf/flow-lite-mcp.git && cd flow-lite-mcp
npm install
npm test        # builds, then an offline check: never opens Chrome or spends credits
```

`npm test` starts five servers at once on a scratch port and checks one owner, shared queue and validation.
To run your checkout instead of the published package, point the MCP config at `node /path/to/dist/index.js`.

## Risk

This automates Flow's web interface. It breaks when Google changes the page, and automated use may be against
Google's terms of service. Use it on your own account, at your own risk.
