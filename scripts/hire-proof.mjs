// Drives the built office page in a real browser against an in-process server whose machine only records the spawn, and
// checks the Hire dialog: the Hire button and an empty desk open it, the roles come from the plugin folder, the hire
// leaves the server as the exact claude argv, the working-hire count shows, a plain hire at the cap spawns nothing, Hire anyway needs a confirm that can be cancelled,
// the PM section (Let the PM decide tells the PM the need, Start PM opens a PM tab in the repo folder only when there is no PM),
// the panel's Give them an intern (a Tell with the subtask) and Let go (only for a background hire, behind a confirm that can be cancelled),
// and the static demo explains that hiring needs a live office.
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
const spawned = [], told = [], pmTabs = [], letGone = [];
const backgroundIds = { des1: "7c5dcf5d" };
let working = 1;
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: {
    gitCommonDir: (cwd) => (["/code/shop", "/code/blog"].includes(cwd) ? `${cwd}/.git` : null),
    liveSessions: async () => new Set(),
    workingHires: async () => working,
    tell: async (socket, sessionId, message) => void told.push({ socket, sessionId, message }),
    backgroundId: async (sessionId) => backgroundIds[sessionId] ?? null,
    letGo: async (id) => void letGone.push(id),
    startPmInIterm: async (folder) => void pmTabs.push(folder),
    spawnBackground: async (argv, cwd) => (spawned.push({ argv, cwd }), "backgrounded"),
  },
});
const base = `http://127.0.0.1:${server.port}`;
const send = async (session_id, hook_event_name, extra = {}, headers = {}, cwd = "/code/shop") => {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET, ...headers },
    body: JSON.stringify({ session_id, transcript_path: `/x/${session_id}.jsonl`, cwd, permission_mode: "default", hook_event_name, ...extra }),
  });
  assert.equal(res.status, 200);
};
await send("pm1", "UserPromptSubmit", { prompt: "plan", agent_type: "f1rm:pm" }, { "x-f1rm-messaging-socket": "/tmp/cc-socks/pm1.sock" });
await send("des1", "UserPromptSubmit", { prompt: "go", agent_type: "f1rm:designer" });
await send("des2", "UserPromptSubmit", { prompt: "go", agent_type: "f1rm:designer" }, {}, "/code/blog");

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
  assert.equal(await dialog.locator(".count").innerText(), "1 of 4 hires working.", "the dialog counts the working hires against the cap");
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
  const empty = rooms[0].desks.find((d) => !d.employee && !d.table);
  const box = await page.locator(".scene canvas").boundingBox();
  const [x, y] = [(empty.x + 18) * SCALE, box.y + (empty.y + 40) * SCALE];
  // The scene finds its click target on a frame after the pointer arrives, so a move-and-click in one breath can miss.
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
  await dialog.locator(".role").first().waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator(".panel").count(), 0, "an empty desk opens no employee panel");

  working = 3;
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.locator(".count").innerText(), "3 of 4 hires working.");
  await page.getByLabel("Brief", { exact: true }).fill("One more");
  working = 4;
  await page.getByRole("button", { name: /^Hire / }).click();
  await page.getByText("4 hires are already working (the cap is 4).").waitFor();
  assert.equal(await dialog.locator(".count").innerText(), "4 of 4 hires working. That is the cap, so a plain hire is refused.", "a refusal corrects a stale count");
  assert.equal(spawned.length, 1, "nothing spawned at the cap");
  assert.equal(await dialog.getByRole("group", { name: "Confirm hiring past the cap" }).count(), 0, "no confirm until Hire anyway is pressed");
  await page.screenshot({ path: join(OUT, "03-cap.png") });

  await dialog.getByRole("button", { name: "Hire anyway", exact: true }).click();
  const confirm = dialog.getByRole("group", { name: "Confirm hiring past the cap" });
  assert.match(await confirm.innerText(), /Hire Maya past the cap\? That makes 5 hires working/);
  await page.screenshot({ path: join(OUT, "03b-confirm.png") });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await confirm.count(), 0, "Cancel closes the confirm");
  assert.equal(await dialog.evaluate((d) => d.open), true, "Cancel leaves the dialog and the brief alone");
  assert.equal(await page.getByLabel("Brief", { exact: true }).inputValue(), "One more");
  assert.equal(spawned.length, 1, "a cancelled confirm spawns nothing");

  await dialog.getByRole("button", { name: "Hire anyway", exact: true }).click();
  await dialog.getByRole("button", { name: "Yes, hire anyway", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(spawned.length, 2, "a confirmed Hire anyway spawns past the cap");
  assert.equal(spawned[1].argv[spawned[1].argv.indexOf("--agent") + 1], "f1rm:designer");
  assert.match(spawned[1].argv.at(-1), /\n\nOne more$/);

  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.locator(".count").innerText(), "4 of 4 hires working. That is the cap, so a plain hire is refused.", "the count at the cap shows on opening");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  const pm = dialog.locator(".pm");
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start PM", exact: true }).count(), 0, "a project with a PM offers no Start PM");
  assert.equal(await pm.getByRole("button", { name: "Jump to terminal", exact: true }).count(), 1, "it offers a Jump to the PM instead");
  assert.equal(await pm.getByRole("button", { name: "Let the PM decide", exact: true }).isDisabled(), true, "no need, nothing to send");
  await page.getByLabel("Brief", { exact: true }).fill("Passkey login for the shop.");
  await page.screenshot({ path: join(OUT, "06-pm.png") });
  await pm.getByRole("button", { name: "Let the PM decide", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(told.length, 1, "one Tell");
  assert.deepEqual([told[0].socket, told[0].sessionId], ["/tmp/cc-socks/pm1.sock", "pm1"], "it went to the PM's inbox");
  assert.match(told[0].message, /per the f1rm guidelines[\s\S]*\nPasskey login for the shop\.$/, "it names the need and asks for hiring per the guidelines");
  assert.equal(spawned.length, 2, "the PM decides, so the office hired nobody");
  assert.deepEqual(pmTabs, [], "a project with a PM opens no PM tab");

  await page.getByRole("button", { name: /Lobby/ }).click();
  await page.locator(".door", { hasText: "blog" }).click();
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Let the PM decide", exact: true }).count(), 0, "no PM, no Let the PM decide");
  await page.screenshot({ path: join(OUT, "07-start-pm.png") });
  await dialog.getByRole("button", { name: "Start PM", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(pmTabs, ["/code/blog"], "Start PM opens one PM tab in the project's folder");
  assert.equal(told.length, 1, "Start PM tells nobody");

  await page.getByRole("button", { name: /Lobby/ }).click();
  await page.locator(".door", { hasText: "shop" }).click();
  const panel = page.locator(".panel");
  const told0 = told.length;
  const fromPm = page.waitForResponse((r) => r.url().includes("/background/pm1"));
  await page.locator(".roster button", { hasText: "PM," }).dispatchEvent("click");
  await fromPm;
  assert.equal(await panel.getByRole("button", { name: "Let go", exact: true }).count(), 0, "a session that is not a background hire has no Let go");
  await panel.getByLabel("Give Priya an intern", { exact: true }).fill("Check the staging logs.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await panel.getByText("Sent to its inbox.").waitFor();
  assert.equal(told.length, told0 + 1, "Give them an intern sends one Tell");
  assert.deepEqual([told.at(-1).socket, told.at(-1).sessionId], ["/tmp/cc-socks/pm1.sock", "pm1"], "it went to that employee's inbox");
  assert.match(told.at(-1).message, /sub-agent[\s\S]*\nCheck the staging logs\.$/, "it asks for a sub-agent and carries the subtask");
  assert.match(await panel.locator(".history").innerText(), /Hand to an intern: Check the staging logs\./, "the history shows the shortcut");
  await page.screenshot({ path: join(OUT, "08-intern.png") });

  const fromBg = page.waitForResponse((r) => r.url().includes("/background/des1"));
  await page.locator(".roster button", { hasText: "Designer," }).dispatchEvent("click");
  await fromBg;
  const letGo = panel.getByRole("button", { name: "Let go", exact: true });
  await letGo.waitFor();
  await page.screenshot({ path: join(OUT, "09-let-go.png") });
  await letGo.click();
  const sure = panel.getByRole("group", { name: "Confirm letting Maya go" });
  assert.match(await sure.innerText(), /Let Maya go\? This stops the session and removes it from Claude Code/);
  await page.screenshot({ path: join(OUT, "10-let-go-confirm.png") });
  await sure.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await sure.count(), 0, "Cancel closes the confirm");
  assert.deepEqual(letGone, [], "a cancelled confirm lets nobody go");
  await letGo.click();
  await sure.getByRole("button", { name: "Yes, let go", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.deepEqual(letGone, ["7c5dcf5d"], "a confirmed Let go stops and removes the session by its short id");
  assert.equal(await page.locator(".roster button", { hasText: "Designer," }).count(), 0, "Maya has left the office");

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
  console.log(`PASS Hire dialog: opens from the button and an empty desk, lists ${names.length} roles from the plugin folder, hires with the exact argv, shows the count and the cap, refuses a plain hire there, hires anyway only after a confirm, tells an intern's subtask, lets a background hire go only after a confirm, fits a phone, explains itself in the demo; screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
process.exit(0);
