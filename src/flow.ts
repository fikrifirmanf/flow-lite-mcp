import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR, getFlowPage } from "./chrome.js";
import { ONLY_USER, addSpend, overBudget } from "./limits.js";
import type { Job } from "./queue.js";

// Never guess a selector: map it from the live page first.

export interface FlowState {
  url: string;
  signed_in: boolean;
  in_project: boolean;
  plan?: string;
  credits_remaining?: number;
  hint?: string;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

export type Quality = "original" | "upscaled";

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

// --- session -----------------------------------------------------------------------------------------------

// `detailed` opens the account panel to read the balance, so never call it while a generation drives the page.
export async function getState(detailed = false): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  const signed_in = !/\/about|accounts\.google\.com/.test(url);
  const in_project = /\/project\//.test(url);
  const state: FlowState = { url, signed_in, in_project };
  if (!signed_in) state.hint = "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  else if (!in_project) state.hint = "Signed in, but no project is open. Use flow_project (list, then open; or new) to pick one.";
  else if (detailed) {
    const account = page.getByRole("button", { name: "Account details" });
    state.plan = await account.innerText().then((t) => t.trim().split("\n")[0], () => undefined);
    state.credits_remaining = await readCredits(page).catch(() => undefined);
  }
  return state;
}

async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const close = page.getByRole("button", { name: "Close account panel" });
  if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 }).catch(() => {});
}

// The balance is only shown in the account panel, which also holds "Sign out": read the one link and leave.
async function readCredits(page: Page): Promise<number | undefined> {
  await dismissOverlays(page);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Account details" }).click({ timeout: 5000 });
  try {
    const link = page.getByRole("link", { name: /Google Flow credits/ });
    await link.waitFor({ state: "visible", timeout: 5000 });
    const n = Number((await link.innerText()).replace(/\D/g, ""));
    return Number.isNaN(n) ? undefined : n;
  } finally {
    await dismissOverlays(page);
  }
}

// --- projects ----------------------------------------------------------------------------------------------

export interface FlowProject {
  id: string;
  title: string;
  current: boolean;
}

const projectIdOf = (url: string) => url.match(/\/project\/([0-9a-f-]{36})/)?.[1];

// Home lists `.project-card`s: an `a[aria-label="Open project"]` to /project/<id> and a `.project-title-label`
// (a date like "Oct 09 - 22:26" until renamed). Each card also has "Delete project": nothing here goes near it.
async function readProjects(page: Page): Promise<{ id: string; title: string }[]> {
  await page.locator(".project-card").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  return page.evaluate(() =>
    [...document.querySelectorAll(".project-card")].flatMap((card) => {
      const id = card.querySelector('a[href*="/project/"]')?.getAttribute("href")?.match(/\/project\/([0-9a-f-]{36})/)?.[1];
      const title = (card.querySelector(".project-title-label") as HTMLElement | null)?.innerText.replace(/\b(edit|delete)\b/g, "").replace(/\s+/g, " ").trim();
      return id ? [{ id, title: title ?? "" }] : [];
    }),
  );
}

// Signed out, the project list is simply empty, which used to come back as a baffling "No project".
async function goHome(page: Page): Promise<void> {
  const state = await getState();
  if (!state.signed_in) throw new Error(state.hint);
  await dismissOverlays(page);
  if (/\/project\//.test(page.url()) || !/flow\.google\.com\/?(\?.*)?$/.test(page.url())) {
    await page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded" });
  }
  await pause(page, 1500);
}

// Lists projects, newest first, then returns to the project that was open, so listing never moves the user.
export async function listProjects(): Promise<FlowProject[]> {
  const page = await getFlowPage();
  const was = page.url();
  const current = projectIdOf(was);
  await goHome(page);
  const projects = await readProjects(page);
  if (current) await page.goto(was, { waitUntil: "domcontentloaded" });
  return projects.map((p) => ({ ...p, current: p.id === current }));
}

// Opens a project by id or exact title; a title shared by several projects is refused rather than guessed.
export async function openProject(which: string): Promise<FlowProject> {
  const page = await getFlowPage();
  let id = /^[0-9a-f-]{36}$/.test(which) ? which : undefined;
  let title = "";
  if (!id || projectIdOf(page.url()) !== id) {
    await goHome(page);
    const projects = await readProjects(page);
    const hits = id ? projects.filter((p) => p.id === id) : projects.filter((p) => p.title.toLowerCase() === which.trim().toLowerCase());
    if (!hits.length) throw new Error(`No project "${which}". Projects: ${projects.slice(0, 15).map((p) => p.title).join(", ")}`);
    if (hits.length > 1) throw new Error(`${hits.length} projects are titled "${which}". Open one by id: ${hits.map((p) => p.id).join(", ")}`);
    ({ id, title } = hits[0]);
  }
  await page.goto(`https://flow.google.com/project/${id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings trigger" }).waitFor({ state: "visible", timeout: 20_000 });
  return { id: id!, title, current: true };
}

// "New project" on Home creates an empty project and opens it.
export async function newProject(): Promise<FlowProject> {
  const page = await getFlowPage();
  await goHome(page);
  const before = new Set((await readProjects(page)).map((p) => p.id));
  await page.getByRole("button", { name: "New project" }).click();
  await page.waitForURL(/\/project\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const id = projectIdOf(page.url())!;
  if (before.has(id)) throw new Error("Flow opened an existing project instead of creating one.");
  await page.getByRole("button", { name: "Settings trigger" }).waitFor({ state: "visible", timeout: 20_000 });
  return { id, title: "", current: true };
}

// --- the grid ----------------------------------------------------------------------------------------------

// The grid is virtualised and the top bar hides once scrolled; new tiles appear at the top.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

async function goToGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  if (root && page.url() !== root) {
    await page.goto(root, { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  await pause(page, 800);
  await scrollToTop(page);
}

// A tile's identity: data-media-id, else a uuid in its media URL, else its title. Flow serves signed thumbnail URLs
// that get re-signed over time, so the URL itself is never used as an id.
const TILE_ID = `(tile) => {
  const m = tile.querySelector("[data-media-id], img[src], video[src]");
  const id = m && (m.getAttribute("data-media-id") || (m.getAttribute("src") || "").match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]);
  if (id) return id;
  const title = tile.getAttribute("aria-label");
  return title ? "title:" + title : undefined;
}`;

type TileInfo = { id?: string; name: string; kind: FlowAsset["kind"]; error: boolean; progress?: string };

async function visibleTiles(page: Page): Promise<TileInfo[]> {
  return page.evaluate(
    (js) =>
      [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
        id: (eval(js) as (t: Element) => string | undefined)(t),
        name: t.getAttribute("aria-label") ?? "",
        kind: t.querySelector("flow-scene-tile") ? ("scene" as const) : t.querySelector("flow-video-tile") ? ("video" as const) : ("image" as const),
        error: Boolean(t.querySelector("flow-error-tile")),
        progress: (t as HTMLElement).innerText.match(/\d+%/)?.[0],
      })),
    TILE_ID,
  );
}

const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function tileFor(page: Page, id: string): Locator {
  const css = id.startsWith("title:")
    ? `flow-grid-tile-container[aria-label="${quote(id.slice(6))}"]`
    : `flow-grid-tile-container:has([data-media-id="${quote(id)}"]), flow-grid-tile-container:has([src*="${quote(id)}"])`;
  return page.locator(css).first();
}

// Flow only reveals a tile's toolbar for a real pointer move; Playwright's hover() does not trigger it.
async function hoverTile(page: Page, tile: Locator): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.hover();
  await pause(page, 900);
}

// The toolbar's "More options" beats a right-click, which can hit the <video> and raise Chrome's own menu.
async function openTileMenu(page: Page, tile: Locator): Promise<void> {
  await hoverTile(page, tile);
  const more = tile.getByRole("button", { name: "More options" });
  if (await more.isVisible({ timeout: 3000 }).catch(() => false)) await more.click();
  else await tile.click({ button: "right" });
}

// Walks the virtual grid from the top, collecting every tile it passes.
export async function listAssets(): Promise<FlowAsset[]> {
  const page = await getFlowPage();
  await goToGrid(page);
  const seen = new Map<string, FlowAsset>();
  let stale = 0;
  for (let step = 0; step < 200 && stale < 3; step++) {
    const before = seen.size;
    for (const t of await visibleTiles(page)) {
      if (!t.id && !t.name) continue;
      const key = t.name || t.id!;
      seen.set(key, { name: t.name, kind: t.kind, id: t.id ?? seen.get(key)?.id });
    }
    stale = seen.size === before ? stale + 1 : 0;
    await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop += e.clientHeight * 0.8)));
    await pause(page, 600);
  }
  await scrollToTop(page);
  return [...seen.values()];
}

// --- generating --------------------------------------------------------------------------------------------

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// The trigger sometimes ignores a click, so it is retried until the popover's radios show.
async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let i = 0; i < 3 && !(await probe.isVisible().catch(() => false)); i++) {
    await settingsTrigger(page).click();
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings.");
}

async function pickRadio(page: Page, name: string | RegExp): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  if (!(await radio.isVisible().catch(() => false))) throw new Error(`Flow offers no "${name}" option for this mode and model.`);
  if (!(await radio.isChecked())) {
    await radio.click();
    await pause(page, 500);
  }
}

// Menu labels carry an emoji or a Material icon ligature ("🍌 Nano Banana 2.1", "volume_up Omni 1.1 Flash",
// "... arrow_drop_down"), so names are compared with those stripped.
export const modelName = (text: string) =>
  text
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// An exact name wins; otherwise the request must match exactly one model. Substring-first picked "Nano Banana 2 Lite"
// for "Nano Banana 2" once Flow renamed 2 to 2.1 (seen live 2026-10-09).
export function chooseModel(names: string[], wanted: string): number {
  const w = wanted.trim().toLowerCase();
  const exact = names.findIndex((n) => n.toLowerCase() === w);
  if (exact >= 0) return exact;
  const partial = names.flatMap((n, i) => (n.toLowerCase().includes(w) ? [i] : []));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${wanted}" matches several models: ${partial.map((i) => names[i]).join(", ")}. Use the full name.`);
  throw new Error(`Model "${wanted}" not found. Flow offers: ${names.join(", ")}`);
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  const current = modelName(await button.innerText());
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map(modelName);
  let i: number;
  try {
    i = chooseModel(names, model);
  } catch (err) {
    await page.keyboard.press("Escape");
    throw err;
  }
  if (names[i] === current) await page.keyboard.press("Escape");
  else await items.nth(i).click();
  await pause(page, 700);
}

// Applies the scene's settings and returns the price Flow itself quotes for them.
async function applySettings(page: Page, job: Job): Promise<number> {
  const s = job.scene;
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, "Ingredients");
  if (s.aspect_ratio) await pickRadio(page, s.aspect_ratio);
  if (s.model) await pickModel(page, s.model);
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`));
  if (s.type === "video" && s.duration) await pickRadio(page, `${s.duration}s`);
  await pickRadio(page, `x${s.variants ?? 1}`);
  await pause(page, 600);
  const text = await page.getByRole("link", { name: /credits?$/ }).innerText();
  await page.keyboard.press("Escape");
  await pause(page, 400);
  const cost = Number(text.match(/\d+/)?.[0] ?? NaN);
  if (Number.isNaN(cost)) throw new Error(`Could not read Flow's credit quote ("${text}"). Nothing was generated.`);
  return cost;
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  // Enter submits, so the prompt goes in as one line.
  await page.keyboard.type(prompt.replace(/\s*\n+\s*/g, " ").trim(), { delay: 8 });
  await pause(page, 500);
}

// Flow's own "failed, you have not been charged": the only failure that gives the credits back to the daily budget.
class NotCharged extends Error {}

// Waits until `count` tiles that were not there before have finished. A <flow-error-tile> above the known tiles
// is Flow's own "failed, you have not been charged", so it gets one free press of Flow's Retry before giving up.
async function waitForNew(page: Page, before: Set<string>, count: number, timeoutMs: number, job: Job): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let retried = false;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    const tiles = await visibleTiles(page);
    const fresh: string[] = [];
    let newErrors = 0;
    const progress: string[] = [];
    for (const t of tiles) {
      if (t.id && before.has(t.id)) break;
      if (t.progress) progress.push(t.progress);
      else if (t.error) newErrors++;
      else if (t.id && !fresh.includes(t.id)) fresh.push(t.id);
    }
    job.progress = progress.join(", ") || undefined;
    if (fresh.length >= count) return fresh.slice(0, count);
    if (progress.length || !newErrors) continue;
    if (!retried) {
      retried = true;
      job.progress = "Flow failed the render; pressing its Retry";
      const tile = page.locator("flow-grid-tile-container:has(flow-error-tile)").first();
      await hoverTile(page, tile);
      const retry = tile.getByRole("button", { name: "Retry" });
      if (await retry.isVisible({ timeout: 2000 }).catch(() => false)) {
        await retry.click();
        await scrollToTop(page);
        continue;
      }
    }
    if (fresh.length) return fresh;
    throw new NotCharged("Flow failed this generation (it says you were not charged). Try again later or reword the prompt.");
  }
  throw new Error(`No result after ${Math.round(timeoutMs / 1000)} s. It may still finish in Flow: check flow_assets before generating again.`);
}

// Flow reuses its own titles, so each finished tile is renamed to the scene's stem. Best effort only.
async function renameTile(page: Page, tile: Locator, title: string): Promise<boolean> {
  try {
    await openTileMenu(page, tile);
    const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
    if (!(await rename.isVisible({ timeout: 4000 }).catch(() => false))) {
      await page.keyboard.press("Escape");
      return false;
    }
    await rename.click();
    await pause(page, 1200);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(title, { delay: 8 });
    await page.keyboard.press("Enter");
    await pause(page, 1500);
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getState();
  if (!state.signed_in || !state.in_project) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.scene;

  await goToGrid(page);
  // Agent mode is conversational and asks for confirmation; the plain composer is what this drives.
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if ((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") await agent.click();
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  job.credits = await applySettings(page, job);
  if (job.credits > s.max_credits) {
    const userLimit = s.max_credits === s.limits.per_scene ? ` That is the user's limit per scene (FLOW_LITE_MAX_CREDITS). ${ONLY_USER}` : "";
    throw new Error(`Flow quotes ${job.credits} credits, above max_credits=${s.max_credits}. Nothing was generated.${userLimit}`);
  }
  const budget = overBudget(job.credits, s.limits);
  if (budget) throw new Error(budget);

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt was not accepted.");
  await scrollToTop(page);
  const before = new Set((await visibleTiles(page)).map((t) => t.id).filter((id): id is string => Boolean(id)));
  await start.click();
  // Counted as spent the moment it is submitted: a render that times out here may still be charged.
  if (job.credits) addSpend(job.credits);

  const fresh = await waitForNew(page, before, s.variants ?? 1, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, job).catch((err) => {
    if (err instanceof NotCharged && job.credits) addSpend(-job.credits);
    throw err;
  });

  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  for (const [i, id] of fresh.entries()) {
    const label = fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem;
    // A video tile at rest may have no media id, only its title; after the rename that title is the new one.
    const title = `flow-lite-${label}-${job.id}`;
    const renamed = await renameTile(page, tileFor(page, id), title);
    files.push(...(await downloadTile(page, renamed && id.startsWith("title:") ? `title:${title}` : id, join(s.output_dir, label), "original")));
  }
  return files;
}

// --- downloading -------------------------------------------------------------------------------------------

// Chrome writes straight into a folder we own. The override is browser-wide and resets whenever another debugging
// client attaches, so it is re-sent before every download, and Chrome's own Downloads folder is watched as well.
async function ownDownloadDir(page: Page): Promise<void> {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true }).catch(() => {});
}

function filesNow(): Set<string> {
  const all = new Set<string>();
  for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) if (existsSync(dir)) for (const f of readdirSync(dir)) all.add(join(dir, f));
  return all;
}

async function waitForFile(page: Page, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(page, 1000);
    for (const path of filesNow()) {
      const name = path.split(/[\\/]/).pop()!;
      if (before.has(path) || name.endsWith(".crdownload") || name.startsWith(".")) continue;
      const size = statSync(path).size;
      if (last?.path === path && last.size === size && size > 0) return path;
      last = { path, size };
    }
  }
  throw new Error("Flow started the download but no file arrived. The media is still in Flow: flow_download fetches it for free.");
}

// "allowAndName" saves under a bare id with no extension, so the file type is read from its first bytes.
function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (a: number, b: number) => head.subarray(a, b).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8) return ".jpeg";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(4, 8) === "ftyp") return ".mp4";
  if (ascii(0, 4) === "GIF8") return ".gif";
  if (ascii(0, 4) === "PK\x03\x04") return ".zip";
  return ".bin";
}

// A tile holding several takes downloads as a ZIP; unpack it into <stem>.mp4, <stem>-v2.mp4, ...
function unpackTakes(zip: string, stem: string): string[] {
  const work = mkdtempSync(join(tmpdir(), "flow-lite-"));
  // bsdtar on macOS and Windows 10+ reads ZIPs; unzip covers Linux.
  try {
    execFileSync("tar", ["-xf", zip, "-C", work], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", work], { stdio: "ignore" });
  }
  const takes = readdirSync(work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out = takes.map((f, i) => {
    const dest = `${stem}${i ? `-v${i + 1}` : ""}${extensionOf(join(work, f))}`;
    renameSync(join(work, f), dest);
    return dest;
  });
  renameSync(zip, `${stem}-takes.zip`);
  return out;
}

async function downloadTile(page: Page, id: string, stem: string, quality: Quality): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // A tile that just finished is still being re-mounted by the grid; settle, then find it again.
      await scrollToTop(page);
      await pause(page, 2000);
      const tile = tileFor(page, id);
      await tile.waitFor({ state: "visible", timeout: 30_000 });
      await ownDownloadDir(page);
      const before = filesNow();
      await openTileMenu(page, tile);
      const download = page.getByRole("menuitem", { name: "Download", exact: true });
      if (!(await download.isVisible({ timeout: 8000 }).catch(() => false))) throw new Error("Flow's tile menu has no Download item.");
      await download.click();
      // Images: "1K Original size" / "2K Upscaled". Videos: "720p Original size" / "1080p Upscaled". Scenes: no submenu.
      const original = page.getByRole("menuitem", { name: /original/i }).first();
      if (await original.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
        const upscaled = page.locator('[role="menuitem"]:not([aria-disabled="true"])').filter({ hasText: /upscaled/i }).first();
        await (quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original).click();
      }
      // Upscales render on demand and can take minutes (or never arrive: then take the original).
      const file = await waitForFile(page, before, quality === "upscaled" ? 600_000 : 180_000);
      await page.keyboard.press("Escape");
      const ext = extensionOf(file);
      if (ext === ".zip") return unpackTakes(file, stem);
      renameSync(file, `${stem}${ext}`);
      return [`${stem}${ext}`];
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(page, 2000);
    }
  }
  throw lastError;
}

// Fetches media that is already in the project. Free, and the right answer whenever a paid file "went missing".
export async function downloadAsset(name: string, stem: string, quality: Quality): Promise<string[]> {
  const page = await getFlowPage();
  const matches = (await listAssets()).filter((a) => a.name === name);
  if (!matches.length) throw new Error(`No item titled "${name}" in this Flow project. flow_assets lists them.`);
  if (matches[0].kind === "scene") throw new Error("Scenes are not supported by flow-lite yet; download it from Flow's scene view.");
  mkdirSync(join(stem, ".."), { recursive: true });
  return downloadTile(page, `title:${name}`, stem, quality);
}
