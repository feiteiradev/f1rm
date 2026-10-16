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
  const ROOMS = ["pixel-pet", "atlas-api", "garden-site", "notes-cli", "lemonade"];
  const roster = () => page.locator(".roster button").evaluateAll((bs) => bs.map((b) => ({ pose: b.dataset.pose, text: b.textContent })));
  const lobby = async () => {
    if (await page.locator(".back").count()) await page.getByRole("button", { name: "Lobby" }).click();
    await page.locator(".door").first().waitFor();
  };
  const visit = async (name) => {
    await lobby();
    await page.locator(".door", { hasText: name }).click();
    await page.locator(".back").waitFor();
    await page.waitForTimeout(150);
    return roster();
  };

  // The demo opens on the same lobby: one door per project.
  await page.locator(".door").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".door").length === 5, null, { timeout: 60_000 });
  assert.deepEqual(await page.locator(".door .name").allInnerTexts(), ROOMS.slice().sort());
  // Every door shows its edition; lemonade is the Founder project.
  assert.deepEqual(await page.locator(".door .edition").allInnerTexts(), ROOMS.slice().sort().map((r) => (r === "lemonade" ? "Founder" : "Work")));
  assert.equal(await page.evaluate(() => location.hash), "", "the demo lands in the lobby");
  await page.screenshot({ path: join(OUT, "demo-lobby.png") });

  const wanted = {
    "waiting": (r) => r.some((e) => e.pose === "hand"),
    "interns": (r) => r.some((e) => /intern/.test(e.text)),
    "idle": (r) => r.some((e) => e.pose === "coffee"),
    "offline": (r) => r.some((e) => e.pose === "off"),
  };
  const seen = {};
  let all = [], lobbyHand = false;
  for (let i = 0; i < 120 && !(lobbyHand && Object.keys(seen).length === Object.keys(wanted).length); i++) {
    await lobby();
    if (!lobbyHand && (await page.locator(".door[data-waiting]").count())) {
      lobbyHand = true;
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, "demo-lobby-waiting.png") });
    }
    for (const name of ROOMS) {
      const r = await visit(name);
      all = all.concat(r);
      for (const [state, test] of Object.entries(wanted)) {
        if (!seen[state] && test(r)) {
          seen[state] = name;
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(OUT, `demo-${state}.png`) });
        }
      }
    }
  }
  assert.ok(lobbyHand, "a door showed someone waiting for permission");
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(wanted).sort(), "every state showed up inside some project");

  const text = all.map((e) => e.text).join("\n");
  for (const role of ["PM", "Team lead", "Designer", "Frontend dev", "Backend dev", "Reviewer", "Researcher", "Marketer", "SEO specialist", "Freelancer"]) assert.match(text, new RegExp(`, ${role},`), role);
  for (const room of ROOMS) assert.match(text, new RegExp(`, ${room},`), room);
  const one = await visit("pixel-pet");
  assert.ok(one.every((e) => e.text.includes(", pixel-pet,")), "a project shows only its own employees");

  // Jump and the palette do nothing to a server that isn't there.
  // The first in the roster is the PM, whose Jump is called Talk.
  await page.locator(".roster button").first().dispatchEvent("click");
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await page.getByText("Jump needs a live office").waitFor();
  await page.screenshot({ path: join(OUT, "demo-jump-note.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("garden");
  await page.getByRole("dialog", { name: "Jump to an employee" }).getByRole("combobox").press("Enter");
  await page.locator(".palette .problem").filter({ hasText: "Jump needs a live office" }).waitFor();
  await page.locator(".crumb", { hasText: "garden-site" }).waitFor();
  await page.screenshot({ path: join(OUT, "demo-palette-other-project.png") });

  assert.deepEqual(problems, []);
  const hosts = new Set(requests.filter((u) => u.startsWith("http")).map((u) => new URL(u).host));
  assert.deepEqual([...hosts], [`127.0.0.1:${PORT}`], "only the static file server was asked for anything");
  assert.ok(!requests.some((u) => /jump\/|\/ws\b/.test(u)), "no jump or socket request");
  // The Founder project: its launch team's pod, the brick wall, and nothing that asks a question the recording can't answer.
  await page.getByRole("dialog", { name: "Jump to an employee" }).getByRole("combobox").press("Escape");
  await page.locator(".palette-backdrop").waitFor({ state: "detached" });
  await visit("lemonade");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("dialog.edition-ask").count(), 0, "the demo never asks an edition");
  assert.ok((await page.locator(".boards button").allTextContents()).some((t) => /lemonade: .*2 to publish/.test(t)), "the Founder board counts what waits to be published");
  await page.screenshot({ path: join(OUT, "demo-founder.png") });
  console.log("demo proof passed:", JSON.stringify(seen));
} finally {
  await browser.close();
  files.kill();
}
