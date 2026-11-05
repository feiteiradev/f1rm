// Drives the built office page in a real browser against an in-process server on a temp HOME, and checks the weekly gauge
// ahead of pace: the notch, the note "Ahead of pace", the aria-label ending ", ahead of pace" and the polite announcement
// "Weekly usage is ahead of pace." when the reading turns ahead, with no "1 team per project" anywhere. Screenshots the top bar.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/gauges-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "gauges-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", DAY = 86400;
// A temp HOME keeps this machine's own reading out; `week(pct)` writes a weekly window with 6 days left (14% of the week gone).
const HOME = (process.env.HOME = mkdtempSync(join(tmpdir(), "f1rm-proof-home-")));
const file = join(HOME, ".f1rm", "usage.json");
const week = (pct) => {
  const now = Date.now() / 1000;
  writeFileSync(file, JSON.stringify({ fiveHour: { usedPct: 30, resetsAt: now + 3 * 3600 }, sevenDay: { usedPct: pct, resetsAt: now + 6 * DAY }, readAt: now }));
};

let server, browser;
try {
  mkdirSync(join(HOME, ".f1rm"), { recursive: true });
  week(10); // on pace
  server = startServer({
    port: 0, secret: SECRET, token: TOKEN, usageFile: file, clientDir: resolve(import.meta.dir, "../office/client/dist"),
    machine: { liveSessions: async () => new Set(), workingHires: async () => 0, backgroundSessions: async () => [], backgroundId: async () => null },
  });
  const base = `http://127.0.0.1:${server.port}`;
  // Any event pushes a fresh snapshot, which re-reads the usage file.
  const nudge = async () => {
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
      body: JSON.stringify({ session_id: "s1", transcript_path: "/x/s1.jsonl", cwd: "/code/elsewhere", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "go" }),
    });
    assert.equal(res.status, 200);
  };

  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/${TOKEN}/`);
  const weekly = page.locator(".gauge", { has: page.locator(".name", { hasText: "Weekly" }) });
  await weekly.waitFor();
  assert.equal(await weekly.locator(".pace-note").count(), 0, "on pace: no note");
  assert.doesNotMatch(await weekly.getAttribute("aria-label"), /ahead of pace/);

  week(50); // 50% used with 14% of the week gone: ahead of pace
  await nudge();
  await weekly.locator(".pace-note").waitFor();
  assert.equal(await weekly.locator(".pace-note").innerText(), "Ahead of pace");
  assert.match(await weekly.getAttribute("aria-label"), /^Weekly window: 50% used, resets .+, ahead of pace$/);
  assert.equal(await weekly.locator(".pace").count(), 1, "the notch at the elapsed share");
  // The status region is set in an effect after the render that shows the note: wait for it rather than read it once.
  const said = "Weekly usage is ahead of pace.";
  await page.waitForFunction((t) => document.querySelector(".usage [role=status]")?.textContent === t, said, { timeout: 5000 }).catch(() => {});
  assert.equal(await page.locator(".usage [role=status]").textContent(), said);
  assert.doesNotMatch(await page.content(), /team per project/);
  assert.deepEqual(errors, []);
  await page.locator("header.bar").screenshot({ path: join(OUT, "top-bar.png") });
  await page.locator(".usage").screenshot({ path: join(OUT, "gauges.png") });
  console.log(`PASS gauges-proof: weekly gauge ahead of pace says "Ahead of pace", no "1 team per project"; screenshots in ${OUT}`);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(HOME, { recursive: true, force: true });
}
