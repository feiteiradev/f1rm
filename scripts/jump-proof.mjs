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

// Fuzzy letters, and a query that matches no one keeps the palette open and does nothing.
await key("Meta+k");
await page.keyboard.type("pst");
assert.equal(await page.getByRole("option").count(), 1, "scattered letters match (post.md)");
await key("Escape");
await dialog.waitFor({ state: "hidden" });
await key("Meta+k");
await page.keyboard.type("zzzz");
assert.equal(await page.getByText("No one matches.").count(), 1);
await key("Enter");
await page.waitForTimeout(200);
assert.equal(calls.length, 2, "Enter with no match jumps nowhere");
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
await jumped(3);
assert.equal(calls.length, 3, "the panel's Jump button jumped");
await page.screenshot({ path: join(OUT, "panel-jump.png") });

assert.deepEqual(errors, [], "no page errors");
console.log(`PASS keyboard-only jumps: ${calls.length} jumps asked for tabs ${calls.map((c) => c.at(-1)).join(", ")}; screenshots in ${OUT}`);
await browser.close();
server.stop(true);
