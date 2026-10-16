// Drives the built office page in a real browser against an in-process server whose machine only records, and checks
// teams in the office: two pods with their leads at the head and their signs, a team's board on its sign and in its panel,
// "Team" in the panel, and the Hire dialog's Team choice and Team lead card, which hire a specialist into a team and a lead
// past the 2-teams cap only after Hire anyway. Saves a screenshot per state, and one at phone width.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/teams-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { teamBoardFile } from "../office/server/board.ts";
import { CELL, layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "teams-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", SCALE = scaleFor(1440), ROOM = "/code/shop/.git";
const boardsDir = mkdtempSync(join(tmpdir(), "f1rm-boards-"));
writeFileSync(teamBoardFile(boardsDir, ROOM, "checkout"), "# Board: shop / checkout\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | checkout.designer-landing | done | worktree-landing | Design the cart page |\n| T2 | checkout.frontend-dev-form | doing | worktree-form | Build the cart form |\n| T3 | - | todo | - | Wire the payment step |\n");
const spawned = [];
const live = [{ name: "lead-checkout", state: "done", cwd: "/code/shop" }, { name: "lead-search", state: "working", cwd: "/code/shop" }];
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, boardsDir, boardPollMs: 50, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: {
    gitCommonDir: (cwd) => (cwd === "/code/shop" ? ROOM : null),
    liveSessions: async () => new Set(),
    backgroundId: async () => null,
    workingHires: async () => 1,
    backgroundSessions: async () => live,
    spawnBackground: async (argv, cwd) => (spawned.push({ argv, cwd }), "backgrounded"),
  },
});
const base = `http://127.0.0.1:${server.port}`;
const send = async (session_id, agent_type, session_title) => {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, transcript_path: `/x/${session_id}.jsonl`, cwd: "/code/shop", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "go", ...(agent_type && { agent_type }), ...(session_title && { session_title }) }),
  });
  assert.equal(res.status, 200);
};
await send("pm1", "f1rm:pm", "pm-shop");
await send("lc", "f1rm:lead", "lead-checkout");
await send("cd", "f1rm:designer", "checkout.designer-landing");
await send("cf", "f1rm:frontend-dev", "checkout.frontend-dev-form");
await send("ls", "f1rm:lead", "lead-search");
await send("sb", "f1rm:backend-dev", "search.backend-dev-api");
await send("solo", "f1rm:designer", "designer-logo");
await send("free", null, null);

const officeState = () =>
  new Promise((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base } });
    ws.onmessage = (m) => (ws.close(), r(JSON.parse(String(m.data))));
  });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const tap = async (x, y) => {
  const box = await page.locator(".scene canvas").boundingBox();
  // The scene finds its click target on a frame after the pointer arrives.
  await page.mouse.move(box.x + x * SCALE, box.y + y * SCALE);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + x * SCALE, box.y + y * SCALE);
};

try {
  await page.goto(`${base}/${TOKEN}/`);
  await page.locator(".door", { hasText: "shop" }).click();
  await page.locator(".scene canvas").waitFor();
  const s = await officeState();
  assert.equal(s.teamBoards?.[ROOM]?.checkout?.length, 3, "the checkout board reaches the office");
  const [room] = layoutOffice(projectState(s, ROOM), Math.floor(1440 / SCALE), Math.floor((await page.locator(".scene").evaluate((e) => e.clientHeight)) / SCALE)).rooms;
  assert.deepEqual(room.pods.map((p) => p.team), ["checkout", "search"], "two pods");
  const deskOf = (id) => room.desks.find((d) => d.employee?.sessionId === id);
  const row = (id) => room.desks.filter((d) => d.y === deskOf(id).y).map((d) => d.employee?.sessionId);
  assert.deepEqual(row("lc"), ["lc", "cd", "cf", undefined, undefined, undefined], "the checkout lead heads its pod, its members beside it");
  assert.equal(row("ls")[0], "ls", "and the search lead heads its own");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, "01-teams.png") });

  const lead = deskOf("lc");
  await tap(lead.x + CELL.w / 2, lead.y + 30);
  const panel = page.locator(".panel");
  await panel.waitFor();
  assert.match(await panel.innerText(), /Team lead[\s\S]*Team\s+checkout/, "the lead's panel names its role and team");
  await page.screenshot({ path: join(OUT, "02-lead-panel.png") });
  await page.keyboard.press("Escape");

  const sign = room.pods[0];
  await tap(sign.x + 30, sign.y + 6);
  const boardPanel = page.locator(".board-panel");
  await boardPanel.waitFor();
  assert.match(await boardPanel.locator("h2").innerText(), /shop \/ checkout board/);
  assert.match(await boardPanel.innerText(), /1 of 3 tasks done/);
  await page.screenshot({ path: join(OUT, "03-team-board.png") });
  await boardPanel.getByRole("button", { name: "Close board" }).click();

  await page.getByRole("button", { name: "Hire", exact: true }).click();
  const dialog = page.locator("dialog.hire");
  await dialog.locator(".role").first().waitFor();
  const teamSelect = page.getByLabel("Team", { exact: true });
  assert.deepEqual(await teamSelect.locator("option").allInnerTexts(), ["No team (reports to the PM)", "checkout (reports to lead-checkout)", "search (reports to lead-search)"]);
  await page.getByLabel("Brief", { exact: true }).fill("Write the cart copy. Acceptance criteria: it reads well.");
  await page.getByLabel("Task name", { exact: true }).fill("cart-copy");
  await teamSelect.selectOption("checkout");
  await page.screenshot({ path: join(OUT, "04-team-select.png") });
  await page.getByRole("button", { name: "Hire a designer" }).click();
  await dialog.waitFor({ state: "detached" });
  const hired = spawned.at(-1).argv;
  assert.deepEqual(hired.slice(0, 8), ["claude", "--bg", "--agent", "f1rm:designer", "--name", "checkout.designer-cart-copy", "--worktree", "cart-copy"]);
  assert.match(hired[8], /^\/design-pipeline Report to: lead-checkout\n\n/, "it reports to its lead");

  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await dialog.locator(".role").first().waitFor();
  await dialog.locator(".role", { hasText: "Team lead" }).click();
  assert.equal(await page.getByLabel("Team", { exact: true }).count(), 0, "a lead joins no team");
  await page.getByLabel("Brief", { exact: true }).fill("Team: cart: the cart slice.");
  await page.getByLabel("Team name", { exact: true }).fill("cart");
  assert.match(await dialog.locator(".help").first().innerText(), /its lead lead-cart/);
  await page.getByRole("button", { name: "Hire a team lead" }).click();
  await page.getByText("this project already has 2 teams (the cap is 2).").waitFor();
  assert.equal(spawned.length, 1, "a third team is refused");
  await page.screenshot({ path: join(OUT, "05-teams-cap.png") });
  await dialog.getByRole("button", { name: "Hire anyway", exact: true }).click();
  await dialog.getByRole("button", { name: "Yes, hire anyway", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(spawned.at(-1).argv.slice(0, 6), ["claude", "--bg", "--agent", "f1rm:lead", "--name", "lead-cart"]);
  assert.ok(!spawned.at(-1).argv.includes("--worktree"), "a lead gets no worktree");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, "06-phone.png") });
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 409 (Conflict)"], "no page errors but the browser's own note of the cap's 409");
  console.log(`teams-proof: all checks passed; screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
