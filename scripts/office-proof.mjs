// Drives the built office page in a real browser against a live in-process server and checks each visual
// acceptance criterion, saving a screenshot per state. Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/office-proof.mjs
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { layoutOffice, scaleFor } from "../office/client/layout.ts";
import { projectState } from "../office/client/lobby.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "office-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token", SCALE = scaleFor(1440);
const repos = { "/code/shop": "/code/shop/.git", "/code/blog": "/code/blog/.git", "/code/docs": "/code/docs/.git" };
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: { gitCommonDir: (cwd) => repos[cwd] ?? null, backgroundId: async () => null },
});
const base = `http://127.0.0.1:${server.port}`;

const send = (id, cwd, hook_event_name, extra = {}) =>
  fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id: id, cwd, hook_event_name, ...extra }),
  });
const tool = (id, cwd, tool_name, tool_input, hook_event_name = "PreToolUse") => send(id, cwd, hook_event_name, { tool_name, tool_input });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/${TOKEN}/`);

const shot = (name, clip) => page.screenshot({ path: join(OUT, `${name}.png`), clip });
const pixels = async (clip) => (await page.screenshot({ clip })).toString("base64");
const meanLuma = (b64) =>
  page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  }, b64);
const settle = (ms = 450) => page.waitForTimeout(ms);

const canvasBox = async () => (await page.locator(".scene canvas").boundingBox());
async function state() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base } });
  const s = await new Promise((r) => (ws.onmessage = (m) => r(JSON.parse(String(m.data)))));
  ws.close();
  return s;
}
// Where things are on screen inside the open project, from the layout of the slice the page itself draws.
async function rects(roomName) {
  const s = await state(), box = await canvasBox();
  const id = Object.values(s.rooms).find((r) => r.name === roomName).id;
  const slice = projectState(s, id);
  const { rooms } = layoutOffice(slice, Math.floor(1440 / SCALE), Math.floor((await page.locator(".scene").evaluate((e) => e.clientHeight)) / SCALE));
  const room = rooms[0];
  const deskOf = (sid) => room.desks.find((d) => d.employee?.sessionId === sid);
  const clipOf = (x, y, w, h) => ({ x: x * SCALE, y: box.y + y * SCALE, width: w * SCALE, height: h * SCALE });
  return { s, room, deskOf, clipOf };
}
const enter = async (name) => {
  await page.locator(".door", { hasText: name }).click();
  await page.locator(".back").waitFor();
  await page.locator(".scene canvas").waitFor();
  await settle();
};
const toLobby = async () => {
  await page.getByRole("button", { name: "Lobby" }).click();
  await page.locator(".door").first().waitFor();
};

await page.waitForSelector(".counter");
assert.match(await page.locator("main").innerText(), /office is empty/);
await shot("00-empty");

await send("s1", "/code/shop", "SessionStart");
await tool("s1", "/code/shop", "Edit", { file_path: "/code/shop/src/login.ts" });
await tool("s2", "/code/shop", "Read", { file_path: "/code/shop/README.md" });
await tool("s3", "/code/shop", "Bash", { command: "bun test" });
// The server holds a PermissionRequest until it is decided, so this does not wait for the answer.
void tool("s4", "/code/shop", "Bash", { command: "rm -rf build" }, "PermissionRequest").catch(() => {});
await send("s5", "/code/shop", "SessionStart");
await tool("b1", "/code/blog", "Write", { file_path: "/code/blog/post.md" });
await send("b2", "/code/blog", "SessionStart");
await send("d1", "/code/docs", "SessionStart");
await settle();
await shot("01-lobby");

const counts = async () =>
  Object.fromEntries(await page.locator(".counter li").evaluateAll((lis) => lis.map((l) => [l.dataset.status, +l.querySelector(".count").textContent])));
assert.deepEqual(await counts(), { working: 4, waiting: 1, idle: 3 }, "the lobby counts everyone");
assert.ok(await page.locator(".counter").isVisible());

await enter("shop");
assert.deepEqual(await counts(), { working: 3, waiting: 1, idle: 1 }, "a project counts its own");
await shot("01-office");
const { s: office, deskOf, clipOf } = await rects("shop");
const poses = { typing: "s1", reading: "s2", running: "s3", hand: "s4", coffee: "s5" };
const roster = await page.locator(".roster button").evaluateAll((bs) => bs.map((b) => [b.textContent, b.dataset.pose]));
const crops = {};
for (const [pose, id] of Object.entries(poses)) {
  const d = deskOf(id);
  const clip = clipOf(d.x, d.y, 36, 64);
  const who = `${office.employees[id].name},`;
  assert.equal(roster.find(([t]) => t.startsWith(who))?.[1], pose, `${who} should be ${pose}`);
  crops[pose] = await pixels(clip);
  await shot(`02-${pose}`, clip);
  if (pose !== "hand") {
    // Two samples at offsets that no pose's frame cycle divides evenly, so a moving pose differs from the first.
    const later = [(await settle(130), await pixels(clip)), (await settle(110), await pixels(clip))];
    assert.ok(later.some((p) => p !== crops[pose]), `${pose} animates`);
  }
}
assert.ok(new Set(Object.values(crops)).size === 5, "five poses look different");

await toLobby();
await enter("docs");
const docs = (await rects("docs")).room;
const docsClip = (await rects("docs")).clipOf(docs.x, docs.y, docs.w, docs.h);
const lit = await meanLuma(await pixels(docsClip));
await shot("03-room-lit", docsClip);
await send("d1", "/code/docs", "SessionEnd");
await settle(1500);
const dim = await meanLuma(await pixels(docsClip));
await shot("04-room-dimmed", docsClip);
assert.ok(dim < lit * 0.7, `empty room dims (lit ${lit.toFixed(1)}, dim ${dim.toFixed(1)})`);
await shot("05-office-with-dimmed-room");
await toLobby();
assert.equal(await page.locator(".door[data-empty]").count(), 1, "the empty project's door is dimmed in the lobby");
await enter("shop");

const d4 = deskOf("s4"), box = await canvasBox();
await page.mouse.click((d4.x + 18) * SCALE, box.y + (d4.y + 24) * SCALE);
const panel = page.locator(".panel");
await panel.waitFor();
const text = await panel.innerText();
for (const want of [office.employees.s4.name, "Freelancer", "shop", "Waiting for permission", "Bash: rm -rf build"]) {
  assert.ok(text.includes(want), `panel shows ${want}: ${text}`);
}
await shot("06-panel");
await page.keyboard.press("Escape");
assert.equal(await panel.count(), 0, "Escape closes the panel");

const before = await pixels(clipOf(deskOf("s2").x, deskOf("s2").y, 36, 64));
await send("s2", "/code/shop", "Stop");
await settle();
assert.deepEqual(await counts(), { working: 2, waiting: 1, idle: 2 }, "shop after s2 stops");
assert.ok((await pixels(clipOf(deskOf("s2").x, deskOf("s2").y, 36, 64))) !== before, "s2's desk changed");
await shot("07-after-stop");

assert.deepEqual(errors, [], "no page errors");
await browser.close();
server.stop(true);
console.log(`ok, screenshots in ${OUT}`);
