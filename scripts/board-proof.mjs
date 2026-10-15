// Drives the real `f1rm start` (temp HOME, real git repos) and the built page in headless Chromium, and checks the
// board acceptance criteria. Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/board-proof.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "board-proof-out");
mkdirSync(OUT, { recursive: true });

const home = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-board-home-")));
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "open"), 0o755);
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };

const free = Bun.serve({ port: 0, fetch: () => new Response() });
const port = free.port;
free.stop(true);
env.F1RM_PORT = String(port);

const repo = (name) => {
  const dir = join(home, "code", name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", dir]);
  return dir;
};
const shop = repo("my shop"), blog = repo("blog");

const cli = join(import.meta.dir, "../office/cli/f1rm.ts");
assert.equal(Bun.spawnSync(["bun", cli, "install"], { env }).exitCode, 0);
const office = Bun.spawn(["bun", cli, "start"], { env, stdout: "pipe", stderr: "pipe" });
const stdout = office.stdout.getReader();
let url = "";
while (!url) url = /f1rm office: (\S+)/.exec(new TextDecoder().decode((await stdout.read()).value))?.[1] ?? "";
const base = new URL(url).origin;

const secret = /: (\S+)/.exec(readFileSync(join(home, ".f1rm", "ingest-headers"), "utf8"))[1];
const send = (id, cwd, hook_event_name = "SessionStart") =>
  fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": secret },
    body: JSON.stringify({ session_id: id, cwd, hook_event_name }),
  });

// The path a PM computes from the guidelines: the main working directory, non-alphanumerics as dashes.
const boardPath = (cwd) => {
  const common = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.toString().trim();
  return join(home, ".f1rm", "boards", common.replace(/\/\.git$/, "").replace(/[^A-Za-z0-9]/g, "-") + ".md");
};
const writeBoard = (cwd, text) => {
  const file = boardPath(cwd);
  mkdirSync(join(home, ".f1rm", "boards"), { recursive: true });
  // Written the way an editor or the PM's Write tool might: a temp file renamed over the board.
  writeFileSync(file + ".tmp", text);
  renameSync(file + ".tmp", file);
  return file;
};
const table = (rows) =>
  ["# Board: proof", "", "| id | owner | status | branch | task |", "| :- | :- | :- | :- | :- |", ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") + "\n";

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.evaluate(() => (window.__noReload = true));
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });

await send("s1", shop);
await send("b1", blog);
// A project's whiteboard exists only inside its office, so each check goes through the lobby's door.
const visit = async (room) => {
  if (await page.locator(".back").count()) await page.getByRole("button", { name: "Lobby" }).click();
  await page.locator(".door", { hasText: room }).click();
  await page.locator(`.boards button`, { hasText: `Board, ${room}:` }).waitFor({ state: "attached" });
  await page.waitForTimeout(500);
};
await page.locator(".door").first().waitFor();
await page.waitForFunction(() => document.querySelectorAll(".door").length === 2);
await visit("my shop");
const boardButton = (room) => page.locator(".boards button", { hasText: `Board, ${room}:` });
const summary = async (room) => (await boardButton(room).textContent()).replace(/^Board, [^:]+: /, "");

// Where each room's whiteboard is on screen, from the layout of the state the server pushes.
async function whiteboardAt(room) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${new URL(url).pathname.split("/")[1]}/ws`, { headers: { origin: base } });
  const state = await new Promise((r) => (ws.onmessage = (m) => r(JSON.parse(String(m.data)))));
  ws.close();
  const id = Object.values(state.rooms).find((r) => r.name === room).id;
  const scale = scaleFor(1440);
  const r = layoutOffice(projectState(state, id), Math.floor(1440 / scale), Math.floor((await page.locator(".scene").evaluate((e) => e.clientHeight)) / scale)).rooms[0];
  const box = await page.locator(".scene canvas").boundingBox();
  return { x: (r.x + r.w - 62 + 20) * scale, y: box.y + (r.y + 2 + 8) * scale };
}
const clickBoard = async (room) => {
  const { x, y } = await whiteboardAt(room);
  await page.mouse.click(x, y);
};

// A missing board: an empty whiteboard, no panel rows, no error.
await page.waitForTimeout(800);
assert.equal(await summary("my shop"), "No tasks");
await visit("blog");
assert.equal(await summary("blog"), "No tasks");
await visit("my shop");
await shot("01-missing-board");
await clickBoard("my shop");
const panel = page.locator(".board-panel");
await panel.waitFor();
assert.match(await panel.innerText(), /my shop board\s+No tasks/);
assert.equal(await panel.locator("tr").count(), 0);
await shot("02-missing-board-panel");
await page.keyboard.press("Escape");
assert.equal(await panel.count(), 0, "Escape closes the board panel");
assert.deepEqual(errors, [], "a missing board raises no error");

// Edits appear without a reload.
const rows = [
  ["T1", "researcher-auth-options", "done", "worktree-auth-options", "Compare session and token auth"],
  ["T2", "backend-dev-auth-api", "doing", "worktree-auth-api", "Add login endpoint"],
  ["T3", "-", "todo", "-", "Build the login form"],
];
const file = writeBoard(shop, table(rows));
await page.waitForFunction(() => document.querySelector(".boards button")?.textContent?.includes("1 of 3"));
assert.equal(await summary("my shop"), "1 of 3 tasks done");
await visit("blog");
assert.equal(await summary("blog"), "No tasks", "another room's board is its own");
await visit("my shop");
await page.waitForTimeout(300);
await shot("03-board-written");
await clickBoard("my shop");
await panel.waitFor();
const text = await panel.innerText();
for (const want of ["Add login endpoint", "backend-dev-auth-api", "worktree-auth-api", "doing", "Build the login form"]) {
  assert.ok(text.includes(want), `panel shows ${want}`);
}
await shot("04-board-panel");

rows[1][2] = "blocked";
rows[2][2] = "review";
rows.push(["T4", "-", "todo", "-", "Added while the page is open"]);
writeBoard(shop, table(rows));
await page.waitForFunction(() => document.querySelector(".board-panel")?.textContent?.includes("Added while the page is open"));
assert.match(await panel.innerText(), /1 of 4 tasks done, 1 blocked/);
assert.equal(await panel.locator("tr[data-board-status=blocked]").count(), 1);
await page.waitForTimeout(300);
await shot("05-board-edited-live");
assert.equal(await page.evaluate(() => window.__noReload), true, "the page was never reloaded");

// A hostile board: markup, a bidi override, huge rows and a huge file.
const hostile = [
  ["T1", "<img src=x onerror=\"window.__pwned=1\">", "doing", "<b>bold</b>", "<script>window.__pwned=1</script><style>body{display:none}</style>‮evil"],
  ["T2", "-", "todo", "-", "WIDE".repeat(2500)],
  ...Array.from({ length: 300 }, (_, i) => [`T${i + 3}`, "-", ["todo", "doing", "review", "done", "blocked", "weird"][i % 6], "-", "WIDE".repeat(75)]),
];
const hostileFile = writeBoard(shop, table(hostile) + "x".repeat(2_000_000));
await page.waitForFunction(() => document.querySelector(".board-panel")?.textContent?.includes("<script>"));
const rendered = await page.locator(".board-panel tbody tr").count();
assert.ok(rendered <= 100, `rows are capped (${rendered})`);
assert.equal(await panel.locator("script, style, img, b").count(), 0, "board text creates no elements");
assert.equal(await page.evaluate(() => window.__pwned), undefined, "no board script ran");
assert.ok((await panel.innerText()).includes("<img src=x"), "markup shows as text");
assert.ok(await page.locator("body").isVisible());
const box = await panel.boundingBox();
assert.ok(box.width <= 640 && box.y + box.height <= 900, `the panel stays on screen (${box.width}x${box.height})`);
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll");
assert.ok(Bun.file(hostileFile).size > 1_000_000);
await page.waitForTimeout(300);
await shot("06-hostile-board");
await page.keyboard.press("Escape");
await shot("07-hostile-board-wall");

// The board is gone again: an empty whiteboard, no error.
rmSync(hostileFile);
await page.waitForFunction(() => document.querySelector(".boards button")?.textContent?.includes("No tasks"));
await page.waitForTimeout(300);
await shot("08-board-removed");

assert.deepEqual(errors, [], "no page errors");
await browser.close();
office.kill();
rmSync(home, { recursive: true, force: true });
console.log(`ok, screenshots in ${OUT}`);
