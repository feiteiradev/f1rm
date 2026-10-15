// Drives the built office page in a real browser against a live in-process server, with hook payloads shaped like
// Claude Code's, and checks roles, freelancers at hot desks, counters and interns, saving a screenshot per state.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/roles-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "roles-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", SCALE = scaleFor(1440);
const repos = { "/code/shop": "/code/shop/.git", "/code/blog": "/code/blog/.git" };
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: { gitCommonDir: (cwd) => repos[cwd] ?? null, liveSessions: async () => new Set() },
});
const base = `http://127.0.0.1:${server.port}`;

const send = async (session_id, cwd, hook_event_name, extra = {}) => {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({
      session_id, transcript_path: `/Users/me/.claude/projects/x/${session_id}.jsonl`, cwd, permission_mode: "default",
      hook_event_name, ...extra,
    }),
  });
  assert.equal(res.status, 200);
};
const start = (id, cwd, extra = {}) => send(id, cwd, "SessionStart", { source: "startup", model: "claude-opus-5-5", ...extra });
const prompt = (id, cwd, extra = {}) => send(id, cwd, "UserPromptSubmit", { prompt: "go", ...extra });
const stop = (id, cwd) => send(id, cwd, "Stop", { stop_hook_active: false, last_assistant_message: "done", background_tasks: [], session_crons: [] });
const subStart = (id, cwd, agent_id, agent_type = "Explore") => send(id, cwd, "SubagentStart", { agent_id, agent_type });
const subStop = (id, cwd, agent_id, agent_type = "Explore") =>
  send(id, cwd, "SubagentStop", {
    stop_hook_active: false, agent_id, agent_type, agent_transcript_path: `/Users/me/.claude/projects/x/${id}/subagents/agent-${agent_id}.jsonl`,
    last_assistant_message: "Found 3 issues.", background_tasks: [], session_crons: [],
  });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
async function open(opts = {}) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/${TOKEN}/`);
  await page.waitForSelector(".counter");
  return page;
}
const page = await open();
const still = await open({ reducedMotion: "reduce" });

const settle = (ms = 500) => page.waitForTimeout(ms);
const enter = async (p, name) => {
  if (await p.locator(".back").count()) await p.getByRole("button", { name: "Lobby" }).click();
  await p.locator(".door", { hasText: name }).click();
  await p.locator(".back").waitFor();
  await p.locator(".scene canvas").waitFor();
  await p.waitForTimeout(500);
};
async function state() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base } });
  const s = await new Promise((r) => (ws.onmessage = (m) => r(JSON.parse(String(m.data)))));
  ws.close();
  return s;
}
// Everything inside the project that page `p` has open, laid out the way the page lays it out.
async function geometry(p, roomName) {
  const s = await state();
  const box = await p.locator(".scene canvas").boundingBox();
  const slice = projectState(s, Object.values(s.rooms).find((r) => r.name === roomName).id);
  const { rooms } = layoutOffice(slice, Math.floor(1440 / SCALE), Math.floor((await p.locator(".scene").evaluate((e) => e.clientHeight)) / SCALE));
  const deskOf = (id) => rooms.flatMap((r) => r.desks).find((d) => d.employee?.sessionId === id);
  const clipOf = (x, y, w, h) => ({ x: x * SCALE, y: box.y + y * SCALE, width: w * SCALE, height: h * SCALE });
  return { s, rooms, deskOf, clipOf };
}
const pixels = async (p, clip) => (await p.screenshot({ clip })).toString("base64");
const rgbAt = (p, b64, x, y) =>
  p.evaluate(async ([b64, x, y]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
  }, [b64, x, y]);
const shot = (p, name, clip) => p.screenshot({ path: join(OUT, `${name}.png`), clip });
const roster = (p) => p.locator(".roster button").allInnerTexts();
const counts = async () =>
  Object.fromEntries(await page.locator(".counter li").evaluateAll((lis) => lis.map((l) => [l.dataset.status, +l.querySelector(".count").textContent])));

// Two shifts of the Designer, one of each other role, and freelancers, in two rooms.
const shop = "/code/shop", blog = "/code/blog";
await start("pm", shop, { agent_type: "f1rm:pm", session_title: "plan-login" });
await prompt("des1", shop, { agent_type: "f1rm:designer", session_title: "login-redesign" });
await prompt("des2", shop, { agent_type: "f1rm:designer", session_title: "pricing-page" });
await prompt("fe", shop, { agent_type: "f1rm:frontend-dev", session_title: "login-form" });
await prompt("be", shop, { agent_type: "f1rm:backend-dev", session_title: "login-api" });
await prompt("rev", shop, { agent_type: "f1rm:reviewer" });
await prompt("res", shop, { agent_type: "f1rm:researcher" });
await start("free1", shop);
await start("free2", shop, { agent_type: "Explore" });
await start("free3", shop, { agent_type: "other-plugin:designer" });
await prompt("blogdes", blog, { agent_type: "f1rm:designer" });
await start("blogfree", blog);
for (const [id, cwd] of [["pm", shop], ["des1", shop], ["des2", shop], ["fe", shop], ["blogdes", blog], ["free1", shop]]) await stop(id, cwd);
await Promise.all([page, still].map((p) => p.waitForTimeout(800)));
await shot(page, "01-lobby");
await Promise.all([enter(page, "shop"), enter(still, "shop")]);
await shot(page, "01-company");

const g = await geometry(page, "shop");
const names = Object.fromEntries(Object.entries(g.s.employees).map(([id, e]) => [id, e.name]));
assert.deepEqual(
  ["pm", "des1", "des2", "fe", "be", "rev", "res", "blogdes"].map((id) => names[id]),
  ["Priya", "Maya", "Maya (2)", "Felix", "Bruno", "Ines", "Kofi", "Maya (3)"],
  "roles keep their fixed names and concurrent Designer shifts get a counter",
);
for (const id of ["free1", "free2", "free3", "blogfree"]) {
  assert.equal(g.s.employees[id].role, null);
  assert.ok(!["Priya", "Maya", "Felix", "Bruno", "Ines", "Kofi"].includes(names[id]), `freelancer ${names[id]} is not a role name`);
}
assert.equal(new Set(Object.values(names)).size, Object.keys(names).length, "every name is unique");

const labels = await roster(page);
for (const want of ["Priya, PM, shop", "Maya, Designer, shop", "Maya (2), Designer, shop", "Felix, Frontend dev, shop", "Bruno, Backend dev, shop", "Ines, Reviewer, shop", "Kofi, Researcher, shop"]) {
  assert.ok(labels.some((l) => l.startsWith(want)), `roster has "${want}": ${labels.join(" | ")}`);
}
for (const id of ["free1", "free2", "free3"]) assert.ok(labels.some((l) => l.startsWith(`${names[id]}, Freelancer`)), `${names[id]} is listed as a Freelancer`);
await enter(page, "blog");
const blogLabels = await roster(page);
assert.ok(blogLabels.some((l) => l.startsWith("Maya (3), Designer, blog")), `blog's roster has Maya (3): ${blogLabels.join(" | ")}`);
assert.ok(blogLabels.some((l) => l.startsWith(`${names.blogfree}, Freelancer`)), "and its freelancer");
assert.ok(blogLabels.every((l) => l.includes(", blog,")), "blog lists only blog");
await shot(page, "01b-blog");
await enter(page, "shop");

// Freelancers sit at hot desks behind the staff desks; staff do not.
const shopRoom = g.rooms.find((r) => r.room.name === "shop");
const staffDesks = shopRoom.desks.filter((d) => d.employee?.role);
const hotDesks = shopRoom.desks.filter((d) => d.hot);
assert.ok(staffDesks.length === 7 && staffDesks.every((d) => !d.hot), "7 staff at front desks");
assert.ok(hotDesks.length >= 3 && hotDesks.every((d) => !d.employee?.role), "hot desks seat no staff");
assert.ok(["free1", "free2", "free3"].every((id) => g.deskOf(id).hot), "freelancers are on hot desks");
assert.ok(Math.min(...hotDesks.map((d) => d.y)) > Math.max(...staffDesks.map((d) => d.y)), "hot desks are behind the staff desks");
const mat = [63, 95, 102];
const hotPx = await rgbAt(page, await pixels(page, g.clipOf(hotDesks[0].x, hotDesks[0].y, 36, 64)), 1, 20 * SCALE);
const staffPx = await rgbAt(page, await pixels(page, g.clipOf(staffDesks[0].x, staffDesks[0].y, 36, 64)), 1, 20 * SCALE);
assert.deepEqual(hotPx, mat, "a hot desk stands on the mat");
assert.notDeepEqual(staffPx, mat, "a staff desk does not");
await shot(page, "02-shop-room", g.clipOf(shopRoom.x, shopRoom.y, shopRoom.w, shopRoom.h));

// Same role, same sprite, everywhere; different roles, different sprites. Compared on a motion-free page.
const headIn = async (room, id) => {
  const gs = await geometry(still, room);
  return pixels(still, gs.clipOf(gs.deskOf(id).x + 15, gs.deskOf(id).y + 11, 16, 16));
};
const [mayaShop, priya, felix] = [await headIn("shop", "des1"), await headIn("shop", "pm"), await headIn("shop", "fe")];
const head = (id) => headIn("shop", id);
await enter(still, "blog");
const mayaBlog = await headIn("blog", "blogdes");
await shot(still, "03-maya-blog-motion-free");
await enter(still, "shop");
assert.equal(mayaShop, mayaBlog, "Maya looks the same in both rooms");
assert.equal(await head("des2"), mayaShop, "and for the second shift");
assert.equal(new Set([mayaShop, priya, felix]).size, 3, "roles look different from each other");
await shot(still, "03-maya-shop-motion-free");

// The panel carries the session title.
const des2 = g.deskOf("des2"), box = await page.locator(".scene canvas").boundingBox();
await page.mouse.click((des2.x + 18) * SCALE, box.y + (des2.y + 24) * SCALE);
await page.locator(".panel").waitFor();
const panelText = await page.locator(".panel").innerText();
for (const want of ["Maya (2)", "Designer", "pricing-page"]) assert.ok(panelText.includes(want), `panel shows ${want}: ${panelText}`);
await shot(page, "04-panel");
await page.keyboard.press("Escape");

// Interns: walk out on SubagentStart, listed under the parent, walk back and leave on SubagentStop.
const before = await counts();
const parent = g.deskOf("des2");
const frontClip = g.clipOf(parent.x, parent.y + 38, 36, 20);
const baseFront = await pixels(page, frontClip);
await subStart("des2", shop, "agent-aaa", "Explore");
const walking = [];
// A screenshot takes about 35 ms, so 20 of them span the 700 ms walk.
for (let i = 0; i < 20; i++) {
  walking.push(await pixels(page, frontClip));
  if (i === 6) await shot(page, "05-intern-walking", g.clipOf(parent.x - 36, parent.y - 8, 108, 80));
}
assert.ok(new Set(walking).size >= 3, `the intern moves while walking out (${new Set(walking).size} distinct frames)`);
assert.notEqual(walking.at(-1), baseFront, "the intern has entered the front of the desk");
await settle(900);
const arrived = await pixels(page, frontClip);
assert.notEqual(arrived, baseFront, "the intern has arrived in front of its parent's desk");
await shot(page, "06-intern-arrived", g.clipOf(parent.x - 36, parent.y - 8, 108, 80));
const withIntern = await state();
assert.deepEqual(withIntern.interns, { "agent-aaa": { agentId: "agent-aaa", parent: "des2", type: "Explore" } });
assert.equal(Object.keys(withIntern.employees).length, Object.keys(g.s.employees).length, "an intern is not an employee");
assert.ok((await roster(page)).some((l) => l.startsWith("Maya (2), Designer, shop") && l.endsWith("1 intern")));
const duringCounts = await counts();
assert.equal(Object.values(duringCounts).reduce((a, b) => a + b), Object.values(before).reduce((a, b) => a + b), "the counter counts employees only");

await subStart("des2", shop, "agent-bbb", "f1rm:reviewer");
await settle(900);
assert.equal((await state()).employees.des2.role, "designer", "a sub-agent's type does not change its parent's role");
await shot(page, "07-two-interns", g.clipOf(parent.x - 36, parent.y - 8, 108, 80));

await subStop("des2", shop, "agent-aaa");
await subStop("des2", shop, "agent-bbb", "f1rm:reviewer");
const leaving = [];
for (let i = 0; i < 6; i++) leaving.push(await pixels(page, frontClip));
await shot(page, "08-interns-leaving", g.clipOf(parent.x - 36, parent.y - 8, 108, 80));
assert.ok(new Set(leaving).size >= 2, "the interns walk back before they vanish");
await settle(1200);
assert.deepEqual((await state()).interns, {});
assert.equal(await pixels(page, frontClip), baseFront, "the interns are gone");
await shot(page, "09-interns-gone", g.clipOf(parent.x - 36, parent.y - 8, 108, 80));

// An intern on a motion-free page appears and disappears without walking.
await subStart("des1", shop, "agent-ccc");
await still.waitForTimeout(300);
await shot(still, "10-intern-motion-free");
await subStop("des1", shop, "agent-ccc");
await still.waitForTimeout(300);

// A parent that ends takes its interns with it.
await subStart("res", shop, "agent-ddd");
await settle(300);
assert.ok("agent-ddd" in (await state()).interns);
await send("res", shop, "SessionEnd", { reason: "prompt_input_exit" });
await settle(300);
assert.deepEqual((await state()).interns, {});

// Forty more freelancers: every roster name stays unique and none is a role's name.
for (let i = 0; i < 40; i++) await start(`crowd-${i}`, i % 2 ? shop : blog);
await settle(900);
const all = Object.values((await state()).employees).map((e) => e.name);
assert.equal(new Set(all).size, all.length, `unique names across ${all.length} employees`);
const shopRoster = (await roster(page)).map((l) => l.split(",")[0]);
assert.equal(new Set(shopRoster).size, shopRoster.length, "and in the project on screen");
assert.ok(all.length >= 48);
await shot(page, "11-crowd");

assert.deepEqual(errors, [], "no page errors");
await browser.close();
server.stop(true);
console.log(`ok, screenshots in ${OUT}`);
