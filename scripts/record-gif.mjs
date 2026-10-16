// Records the README's docs/f1rm.gif from the static demo build: the lobby, the atlas-api office with its PM waiting
// at the table, the PM's panel, and the lobby again. Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome bun scripts/record-gif.mjs
// Needs ffmpeg. The demo is the scrubbed recording, so nothing private can end up in the gif.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(import.meta.dir, "../docs/f1rm.gif");
const PORT = 4398, FRAME_MS = 160;
const frames = mkdtempSync(join(tmpdir(), "f1rm-gif-"));

const files = Bun.spawn(["python3", "-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: resolve(import.meta.dir, "../office/demo/dist"), stdout: "ignore", stderr: "ignore",
});
await Bun.sleep(800);
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 800, height: 480 } })).newPage();

const list = [];
/** Screenshots for `ms`, one frame per FRAME_MS. */
async function film(ms) {
  for (let t = 0; t < ms; t += FRAME_MS) {
    const started = Date.now();
    const file = join(frames, `f${String(list.length).padStart(3, "0")}.png`);
    await page.screenshot({ path: file });
    list.push(file);
    await Bun.sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
  }
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  // All four projects have arrived about five seconds into the replay.
  await page.waitForFunction(() => document.querySelectorAll(".door").length === 4, null, { timeout: 20_000 });
  await film(1800);
  await page.locator(".door", { hasText: "atlas-api" }).click();
  await page.locator(".back").waitFor();
  // The demo's atlas PM ends its turn about six seconds in, and waits for you until about 40.
  await page.getByRole("button", { name: /, PM, atlas-api, Waiting for you$/ }).waitFor({ timeout: 20_000 });
  await film(3200);
  await page.getByRole("button", { name: /, PM, atlas-api, Waiting for you$/ }).dispatchEvent("click");
  await page.locator(".panel").waitFor();
  await film(2200);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Lobby" }).click();
  await page.locator(".door").first().waitFor();
  await film(1800);
} finally {
  await browser.close();
  files.kill();
}

writeFileSync(join(frames, "list.txt"), list.map((f) => `file '${f}'\nduration ${FRAME_MS / 1000}`).join("\n") + `\nfile '${list.at(-1)}'\n`);
const ff = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frames, "list.txt"),
  "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", OUT]);
if (ff.exitCode !== 0) throw new Error(ff.stderr.toString());
console.log(`record-gif: ${list.length} frames to ${OUT}`);
