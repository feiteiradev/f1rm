// Drives the built office page in headless Chrome, keyboard only, against a live in-process server whose
// machine module is faked, and checks that ⌘K and the panel's Jump button ask for the right jumps.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/jump-proof.mjs
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "jump-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token";
const repos = { "/code/shop": "/code/shop/.git", "/code/blog": "/code/blog/.git" };
const calls = [];
const tab = (n) => `w0t${n}p0:6C2B4D3E-1A2B-4C5D-8E9F-0123456789A${n}`;
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: {
    gitCommonDir: (cwd) => repos[cwd] ?? null,
    liveSessions: async () => new Set(),
    backgroundId: async () => null,
    focusIterm: async (id) => (calls.push(id), true),
    attachInIterm: async () => {},
    openVsCode: async () => {},
  },
});
const base = `http://127.0.0.1:${server.port}`;
const send = (id, cwd, n, tool_input) =>
  fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET, "x-f1rm-iterm-session": tab(n) },
    body: JSON.stringify({ session_id: id, cwd, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input }),
  });
await send("a", "/code/shop", 1, { file_path: "/code/shop/login.ts" });
await send("b", "/code/shop", 2, { file_path: "/code/shop/cart.ts" });
await send("c", "/code/blog", 3, { file_path: "/code/blog/post.md" });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/${TOKEN}/`);
await page.locator(".counter").waitFor();
assert.equal(await page.locator(".door").count(), 2, "the page opens on the lobby");
const key = (k) => page.keyboard.press(k);
const dialog = page.getByRole("dialog", { name: "Jump to an employee" });
const jumped = async (n) => {
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && calls.length < n; i++) await page.waitForTimeout(50);
};

// Open, type, Enter.
await key("Meta+k");
await dialog.waitFor();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "the search box has focus on open");
assert.equal(await page.getByRole("option").count(), 3, "an empty query lists everyone");
await page.screenshot({ path: join(OUT, "palette-open.png") });
await page.keyboard.type("login");
assert.equal(await page.getByRole("option").count(), 1, "typing narrows to the one matching a task");
await page.screenshot({ path: join(OUT, "palette-typed.png") });
await key("Enter");
await jumped(1);
assert.deepEqual(calls, [tab(1)], "Enter jumped to the matching employee's tab");
await dialog.waitFor({ state: "hidden" });
await page.locator(".crumb", { hasText: "shop" }).waitFor();
assert.match(await page.evaluate(() => location.hash), /^#\/project\//, "the palette opened the employee's project from the lobby");
await page.screenshot({ path: join(OUT, "palette-opened-project.png") });

// A pick in another project opens that project; the jump still goes to that employee's tab.
await key("Meta+k");
await page.keyboard.type("post");
await key("Enter");
await jumped(2);
assert.equal(calls.at(-1), tab(3), "the blog employee's tab was jumped to");
await page.locator(".crumb", { hasText: "blog" }).waitFor();
assert.equal(await page.locator(".roster button").count(), 1, "only the blog's employee is in the open project");
await page.screenshot({ path: join(OUT, "palette-other-project.png") });
calls.length = 1;
await page.getByRole("button", { name: "Lobby" }).click();

// Arrow keys choose among several matches; room names search too.
await key("Meta+k");
await page.keyboard.type("shop");
assert.equal(await page.getByRole("option").count(), 2, "a room name finds its employees");
await key("ArrowDown");
assert.equal(await page.locator('[role=option][aria-selected=true]').count(), 1);
await key("Enter");
await jumped(2);
assert.deepEqual(calls.slice(1), [tab(2)], "ArrowDown then Enter jumped to the second match in the room");
await dialog.waitFor({ state: "hidden" });

// The highlight follows the employee, not the row: someone above it leaves while the palette is open.
await send("d", "/code/shop", 4, { file_path: "/code/shop/race.ts" });
await key("Meta+k");
await page.keyboard.type("shop");
const optionIds = () => page.getByRole("option").evaluateAll((els) => els.map((e) => e.id.split("-").at(-1)));
const highlighted = async () => (await page.locator("[role=option][aria-selected=true]").getAttribute("id")).split("-").at(-1);
await page.waitForFunction(() => document.querySelectorAll("[role=option]").length === 3);
const order = await optionIds();
await key("ArrowDown");
const picked = await highlighted();
assert.equal(picked, order[1]);
await fetch(`${base}/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
  body: JSON.stringify({ session_id: order[0], cwd: "/code/shop", hook_event_name: "SessionEnd", reason: "other" }),
});
await page.waitForFunction(() => document.querySelectorAll("[role=option]").length === 2);
assert.equal(await highlighted(), picked, "the highlight stayed on the same employee when the list changed");
await key("Enter");
await jumped(3);
assert.equal(calls.at(-1), tab(picked === "a" ? 1 : picked === "b" ? 2 : 4), "Enter jumped to the highlighted employee");
await dialog.waitFor({ state: "hidden" });
const raced = calls.length;

// Fuzzy letters, and a query that matches no one keeps the palette open and does nothing.
await key("Meta+k");
await page.keyboard.type("pst");
assert.equal(await page.getByRole("option").count(), 1, "scattered letters match (post.md)");
await key("Escape");
await dialog.waitFor({ state: "hidden" });
// A session's own title (`--name`) finds it too.
await fetch(`${base}/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-f1rm-secret": SECRET, "x-f1rm-iterm-session": tab(3) },
  body: JSON.stringify({ session_id: "c", cwd: "/code/blog", hook_event_name: "UserPromptSubmit", session_title: "spring launch" }),
});
await key("Meta+k");
await page.keyboard.type("spring launch");
assert.equal(await page.getByRole("option").count(), 1, "a session title finds its employee");
await key("Escape");
await dialog.waitFor({ state: "hidden" });
await key("Meta+k");
await page.keyboard.type("zzzz");
assert.equal(await page.getByText("No one matches.").count(), 1);
await key("Enter");
await page.waitForTimeout(200);
assert.equal(calls.length, raced, "Enter with no match jumps nowhere");
await key("Escape");

// Escape closes only the palette; the panel behind it stays. The panel's button jumps by keyboard.
await page.locator(".roster button").first().focus();
await key("Enter");
await page.locator(".panel").waitFor();
await key("Meta+k");
await dialog.waitFor();
await key("Escape");
await dialog.waitFor({ state: "hidden" });
assert.equal(await page.locator(".panel").count(), 1, "Escape closed the palette and left the panel open");
assert.equal(await page.evaluate(() => document.activeElement?.className), "", "focus returned to where it was");
await key("Tab");
assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Jump to terminal");
await key("Enter");
await jumped(raced + 1);
assert.equal(calls.length, raced + 1, "the panel's Jump button jumped");
await page.screenshot({ path: join(OUT, "panel-jump.png") });

assert.deepEqual(errors, [], "no page errors");
console.log(`PASS keyboard-only jumps: ${calls.length} jumps asked for tabs ${calls.map((c) => c.at(-1)).join(", ")}; screenshots in ${OUT}`);
await browser.close();
server.stop(true);
