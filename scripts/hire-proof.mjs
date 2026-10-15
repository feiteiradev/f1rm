// Drives the built office page in a real browser against an in-process server whose machine only records the spawn, and
// checks the Hire dialog: the Hire button and an empty desk open it, the roles come from the plugin folder, the hire
// leaves the server as the exact claude argv, the cap shows, and the static demo explains that hiring needs a live office.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/hire-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "hire-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", SCALE = scaleFor(1440);
const spawned = [];
let working = 1;
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: {
    gitCommonDir: (cwd) => (cwd === "/code/shop" ? "/code/shop/.git" : null),
    liveSessions: async () => new Set(),
    workingHires: async () => working,
    spawnBackground: async (argv, cwd) => (spawned.push({ argv, cwd }), "backgrounded"),
  },
});
const base = `http://127.0.0.1:${server.port}`;
const send = async (session_id, hook_event_name, extra = {}) => {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, transcript_path: `/x/${session_id}.jsonl`, cwd: "/code/shop", permission_mode: "default", hook_event_name, ...extra }),
  });
  assert.equal(res.status, 200);
};
await send("pm1", "UserPromptSubmit", { prompt: "plan", agent_type: "f1rm:pm" });
await send("des1", "UserPromptSubmit", { prompt: "go", agent_type: "f1rm:designer" });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
};
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
watch(page);
try {
  await page.goto(`${base}/${TOKEN}/`);
  await page.locator(".door", { hasText: "shop" }).click();
  await page.locator(".scene canvas").waitFor();
  const dialog = page.locator("dialog.hire");
  assert.equal(await dialog.count(), 0, "no dialog until asked");

  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.evaluate((d) => d.open), true, "the dialog is open and modal");
  const names = await dialog.locator(".role .name").allInnerTexts();
  assert.deepEqual([...names].sort(), ["Bruno", "Felix", "Ines", "Kofi", "Maya"], "five roles, each with its fixed name, and no PM");
  const maya = dialog.locator(".role", { hasText: "Maya" });
  assert.match(await maya.innerText(), /1 working/, "Maya's row counts the Designer already working");
  assert.match(await maya.innerText(), /sonnet.*design-pipeline/s, "the row names the model and skills");
  await page.screenshot({ path: join(OUT, "01-dialog.png") });

  await maya.click();
  assert.equal(await page.getByRole("button", { name: "Hire Maya" }).isDisabled(), true, "no brief, no hire");
  await page.getByLabel("Brief", { exact: true }).fill("Design the login page. Reply OK and stop.");
  assert.equal(await page.getByLabel("Task name", { exact: true }).inputValue(), "design-the-login-page", "the task name comes from the brief");
  await page.getByLabel("Task name", { exact: true }).fill("login-page");
  await page.getByLabel("Brief", { exact: true }).fill("Design the login page. Reply OK and stop. More.");
  assert.equal(await page.getByLabel("Task name", { exact: true }).inputValue(), "login-page", "an edited task name stays put");
  assert.deepEqual(await page.getByLabel("Model", { exact: true }).locator("option").allInnerTexts(), ["sonnet (the role's own)", "haiku", "opus"]);
  await page.getByLabel("Model", { exact: true }).selectOption("haiku");
  await page.getByLabel("Task name", { exact: true }).fill("Login Page");
  assert.equal(await page.getByRole("button", { name: "Hire Maya" }).isDisabled(), true, "a bad task name blocks the hire");
  await page.getByLabel("Task name", { exact: true }).fill("login-page");
  await page.screenshot({ path: join(OUT, "02-filled.png") });
  await page.getByRole("button", { name: "Hire Maya" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(spawned, [
    {
      cwd: "/code/shop",
      argv: [
        "claude", "--bg", "--agent", "f1rm:designer", "--name", "designer-login-page", "--worktree", "login-page",
        "/design-pipeline Report to: pm-shop\n\nDesign the login page. Reply OK and stop. More.", "--model", "haiku",
      ],
    },
  ]);

  const s = await new Promise((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base } });
    ws.onmessage = (m) => (ws.close(), r(JSON.parse(String(m.data))));
  });
  const room = Object.values(s.rooms)[0];
  const { rooms } = layoutOffice(projectState(s, room.id), Math.floor(1440 / SCALE), Math.floor((await page.locator(".scene").evaluate((e) => e.clientHeight)) / SCALE));
  const empty = rooms[0].desks.find((d) => !d.employee);
  const box = await page.locator(".scene canvas").boundingBox();
  await page.mouse.click((empty.x + 18) * SCALE, box.y + (empty.y + 40) * SCALE);
  await dialog.locator(".role").first().waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator(".panel").count(), 0, "an empty desk opens no employee panel");

  working = 4;
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await page.getByLabel("Brief", { exact: true }).fill("One more");
  await page.getByRole("button", { name: /^Hire / }).click();
  await page.getByText("4 hires are already working (the cap is 4).").waitFor();
  await page.screenshot({ path: join(OUT, "03-cap.png") });
  assert.equal(spawned.length, 1, "nothing spawned at the cap");
  await page.keyboard.press("Escape");

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage();
  watch(phone);
  await phone.goto(`${base}/${TOKEN}/`);
  await phone.locator(".door", { hasText: "shop" }).click();
  await phone.getByRole("button", { name: "Hire", exact: true }).click();
  await phone.locator("dialog.hire .role").first().waitFor();
  const fits = await phone.locator("dialog.hire").evaluate((d) => d.scrollWidth <= d.clientWidth);
  assert.ok(fits, "the dialog needs no sideways scroll on a phone");
  await phone.screenshot({ path: join(OUT, "04-phone.png") });
  // A page behind another one stops getting animation frames, which Playwright waits on.
  await page.context().close();
  await phone.context().close();

  const files = Bun.spawn(["python3", "-m", "http.server", "4398", "--bind", "127.0.0.1"], { cwd: resolve(import.meta.dir, "../office/demo/dist"), stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(800);
  try {
    const demo = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    watch(demo);
    const asked = [];
    demo.on("request", (r) => asked.push(new URL(r.url()).pathname));
    await demo.goto("http://127.0.0.1:4398/");
    await demo.waitForFunction(() => document.querySelectorAll(".door").length === 4, null, { timeout: 60_000 });
    await demo.locator(".door").first().click();
    await demo.getByRole("button", { name: "Hire", exact: true }).click();
    await demo.getByText("Hiring needs a live office; this is a recording.").waitFor();
    assert.ok(!asked.some((p) => p.includes("roles") || p.includes("hire")), "the demo asks no server for roles");
    await demo.screenshot({ path: join(OUT, "05-demo.png") });
  } finally {
    files.kill();
  }

  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 409 (Conflict)"], "no page errors but the browser's own note of the cap's 409");
  console.log(`PASS Hire dialog: opens from the button and an empty desk, lists ${names.length} roles from the plugin folder, hires with the exact argv, shows the cap, fits a phone, explains itself in the demo; screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
process.exit(0);
