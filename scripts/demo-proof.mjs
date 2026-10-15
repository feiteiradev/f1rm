// Proves the static demo build runs from a plain file server with no f1rm server, in a real browser.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/demo-proof.mjs
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "demo-proof-out");
mkdirSync(OUT, { recursive: true });
const PORT = 4399;

const files = Bun.spawn(["python3", "-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: resolve(import.meta.dir, "../office/demo/dist"), stdout: "ignore", stderr: "ignore",
});
await Bun.sleep(800);

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [], requests = [];
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("request", (r) => requests.push(r.url()));
page.on("websocket", (w) => problems.push(`websocket opened: ${w.url()}`));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const roster = () => page.locator(".roster button").evaluateAll((bs) => bs.map((b) => ({ pose: b.dataset.pose, text: b.textContent })));
  const wanted = {
    "waiting": (r) => r.some((e) => e.pose === "hand"),
    "interns": (r) => r.some((e) => /intern/.test(e.text)),
    "idle": (r) => r.some((e) => e.pose === "coffee"),
    "offline": (r) => r.some((e) => e.pose === "off") && r.some((e) => e.pose === "hand") && r.length >= 10,
  };
  const seen = {};
  let all = [];
  for (let i = 0; i < 200 && Object.keys(seen).length < Object.keys(wanted).length; i++) {
    const r = await roster();
    all = all.concat(r);
    for (const [name, test] of Object.entries(wanted)) {
      if (!seen[name] && test(r)) {
        seen[name] = r.length;
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `demo-${name}.png`) });
      }
    }
    await page.waitForTimeout(500);
  }
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(wanted).sort(), "every state showed up");

  const text = all.map((e) => e.text).join("\n");
  for (const role of ["PM", "Designer", "Frontend dev", "Backend dev", "Reviewer", "Researcher", "Freelancer"]) assert.match(text, new RegExp(`, ${role},`), role);
  for (const room of ["pixel-pet", "atlas-api", "garden-site", "notes-cli"]) assert.match(text, new RegExp(`, ${room},`), room);

  // Jump and the palette do nothing to a server that isn't there.
  await page.locator(".roster button").first().dispatchEvent("click");
  await page.getByRole("button", { name: "Jump to terminal" }).click();
  await page.getByText("Jump needs a live office").waitFor();
  await page.screenshot({ path: join(OUT, "demo-jump-note.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").press("Enter");
  await page.locator(".palette .problem").filter({ hasText: "Jump needs a live office" }).waitFor();

  assert.deepEqual(problems, []);
  const hosts = new Set(requests.filter((u) => u.startsWith("http")).map((u) => new URL(u).host));
  assert.deepEqual([...hosts], [`127.0.0.1:${PORT}`], "only the static file server was asked for anything");
  assert.ok(!requests.some((u) => /jump\/|\/ws\b/.test(u)), "no jump or socket request");
  console.log("demo proof passed:", JSON.stringify(seen));
} finally {
  await browser.close();
  files.kill();
}
