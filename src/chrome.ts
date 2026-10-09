import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_URL = "https://flow.google.com/";
const FLOW_PAGE = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;

export const HOME_DIR = process.env.FLOW_LITE_HOME ?? join(homedir(), ".flow-lite");
const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
// Not 9333, so this can sit beside the original flow-mcp without the two fighting over one Chrome.
const CDP_PORT = Number(process.env.FLOW_LITE_CDP_PORT ?? 9334);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_LITE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].filter((p): p is string => Boolean(p));

// visible: a normal window. minimized: the same window, minimised as soon as it opens.
// There is deliberately no headless mode: on macOS headless Chrome cannot read the Keychain-encrypted cookies, lands
// signed out, and running it once on the profile signed the real window out too (2026-10-09). The only ways around
// that are moving login cookies by hand or disguising the browser, and this project does neither.
export type WindowMode = "visible" | "minimized";
export const WINDOW_MODE: WindowMode = process.env.FLOW_LITE_WINDOW === "minimized" ? "minimized" : "visible";

let browser: Browser | null = null;
let minimizeOnAttach = false;

async function cdpUp(): Promise<boolean> {
  return fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
}

// Real Chrome with its own profile: Google sign-in behaves normally, the session persists between runs,
// and the user's everyday Chrome profile is never touched.
async function launchChrome(mode: WindowMode): Promise<void> {
  const chrome = CHROME_PATHS.find((p) => existsSync(p));
  if (!chrome) throw new Error("Google Chrome not found. Set FLOW_LITE_CHROME to the Chrome executable.");
  mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check"];
  if (mode === "minimized") {
    // A window nobody looks at gets its timers and rendering throttled, which stalls Flow's progress updates.
    args.push("--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows");
  }
  minimizeOnAttach = mode === "minimized";
  spawn(chrome, [...args, FLOW_URL], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but its debugging port ${CDP_PORT} never answered.`);
}

// A Flow Chrome that is already running is used as it is, whatever mode it was started in.
export async function getFlowPage(mode: WindowMode = WINDOW_MODE): Promise<Page> {
  if (!browser?.isConnected()) {
    if (!(await cdpUp())) await launchChrome(mode);
    browser = await chromium.connectOverCDP(CDP_URL);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; close the Flow Chrome window and try again.");
  let page = context.pages().find((p) => FLOW_PAGE.test(p.url()));
  if (!page) {
    page = await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  }
  if (minimizeOnAttach) {
    minimizeOnAttach = false;
    const cdp = await context.newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } }).catch(() => {});
  }
  return page;
}

// Signing in needs a window the user can see, so a minimised Flow window is brought back up.
export async function showForLogin(): Promise<Page> {
  const page = await getFlowPage("visible");
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
  await page.bringToFront();
  return page;
}
