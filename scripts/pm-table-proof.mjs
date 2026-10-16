// Drives the built office page in a real browser against an in-process server whose machine only records, and checks the
// PM's table in the glass corner: with no PM a tap on the empty table starts one PM tab in the project folder (one per tap
// burst), the PM who arrives sits at the table, its panel's first button is Talk, and when its turn ends it shows as
// waiting for you. Saves a screenshot per state: no PM, PM working, your turn, and your turn at phone width.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/pm-table-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "pm-table-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", SCALE = scaleFor(1440);
const pmTabs = [];
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: {
    gitCommonDir: (cwd) => (cwd === "/code/shop" ? `${cwd}/.git` : null),
    liveSessions: async () => new Set(),
    startPmInIterm: async (folder) => void pmTabs.push(folder),
    backgroundId: async () => null,
    workingHires: async () => 0,
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
const officeState = () =>
  new Promise((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base } });
    ws.onmessage = (m) => (ws.close(), r(JSON.parse(String(m.data))));
  });
await send("des1", "UserPromptSubmit", { prompt: "go", agent_type: "f1rm:designer" });
await send("free1", "UserPromptSubmit", { prompt: "go" });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const tapTable = async () => {
  const s = await officeState();
  const { rooms } = layoutOffice(projectState(s, Object.keys(s.rooms)[0]), Math.floor(1440 / SCALE), Math.floor((await page.locator(".scene").evaluate((e) => e.clientHeight)) / SCALE));
  const [table] = rooms[0].desks;
  assert.equal(table.table, true, "the first seat is the PM's table");
  const box = await page.locator(".scene canvas").boundingBox();
  const [x, y] = [box.x + (table.x + 18) * SCALE, box.y + (table.y + 32) * SCALE];
  // The scene finds its click target on a frame after the pointer arrives.
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
};
const roster = (name) => page.locator(".roster button", { hasText: name });

try {
  await page.goto(`${base}/${TOKEN}/`);
  await page.locator(".door", { hasText: "shop" }).click();
  await page.locator(".scene canvas").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "01-no-pm.png") });

  await tapTable();
  await page.getByText("Starting a PM in a new iTerm tab…").waitFor();
  await tapTable();
  await page.waitForTimeout(300);
  assert.deepEqual(pmTabs, ["/code/shop"], "a tap on the empty table starts one PM tab in the project folder, and a second tap while it starts does not");
  assert.equal(await page.locator(".panel").count(), 0, "the empty table opens no panel");

  await send("pm1", "UserPromptSubmit", { prompt: "plan", agent_type: "f1rm:pm" });
  await roster(", PM,").waitFor();
  await page.getByText("Starting a PM in a new iTerm tab…").waitFor({ state: "detached" });
  assert.match(await roster(", PM,").innerText(), /, Working$/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "02-pm-working.png") });

  await tapTable();
  const panel = page.locator(".panel");
  await panel.waitFor();
  assert.equal(await panel.locator("h2").innerText(), (await roster(", PM,").innerText()).split(",")[0], "a tap on the table opens the PM");
  assert.equal(await panel.getByRole("button").nth(1).innerText(), "Talk", "Talk is the panel's first action, after Close");
  assert.equal(await panel.getByRole("button", { name: "Jump to terminal" }).count(), 0);

  await send("pm1", "Stop");
  await panel.getByText("Waiting for you").waitFor();
  assert.match(await roster(", PM,").innerText(), /, Waiting for you$/, "an idle PM waits for you, in the roster too");
  await panel.getByText("Its last message is in its terminal. Press Talk to answer.").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "03-your-turn.png") });
  assert.match(await roster(", Designer,").innerText(), /, Working$/, "other roles keep their own status words");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "04-phone.png") });

  assert.deepEqual(errors, [], "no page errors");
  console.log(`pm-table-proof: all checks passed; screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
