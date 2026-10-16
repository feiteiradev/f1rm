// Drives the built office page in a real browser against an in-process server with a throwaway settings folder, and checks
// editions: the question on entering a project with none (Not now and Escape bring it back on the next entry, a choice saves
// it), the badge on each door, and the top-bar select switching a project. Saves a screenshot per state.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/editions-proof.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../office/server/server.ts";
import { projectFile, readEdition, writeEdition } from "../office/server/editions.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "editions-proof-out");
mkdirSync(OUT, { recursive: true });

const SECRET = "proof-secret", TOKEN = "proof-token";
const projectsDir = mkdtempSync(join(tmpdir(), "f1rm-projects-"));
const SHOP = "/code/shop/.git", BLOG = "/code/blog/.git";
writeEdition(projectFile(projectsDir, BLOG), "founder");
const server = startServer({
  port: 0, secret: SECRET, token: TOKEN, projectsDir, boardPollMs: 50, clientDir: resolve(import.meta.dir, "../office/client/dist"),
  machine: { gitCommonDir: (cwd) => ({ "/code/shop": SHOP, "/code/blog": BLOG })[cwd] ?? null, liveSessions: async () => new Set() },
});
const base = `http://127.0.0.1:${server.port}`;
for (const [id, cwd] of [["s1", "/code/shop"], ["b1", "/code/blog"]]) {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id: id, transcript_path: `/x/${id}.jsonl`, cwd, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "go" }),
  });
  assert.equal(res.status, 200);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const door = (name) => page.locator(".door", { hasText: name });
const ask = page.locator("dialog.edition-ask");
const enter = async (name) => {
  await door(name).click();
  await page.locator(".back").waitFor();
};
const lobby = async () => {
  await page.getByRole("button", { name: "Lobby" }).click();
  await page.locator(".door").first().waitFor();
};

try {
  await page.goto(`${base}/${TOKEN}/`);
  await door("blog").locator(".edition").waitFor();
  assert.equal(await door("blog").locator(".edition").innerText(), "Founder", "a chosen edition shows on its door");
  assert.equal(await door("shop").locator(".edition").count(), 0, "a door shows nothing before a choice");
  await page.screenshot({ path: join(OUT, "01-lobby.png") });

  await enter("blog");
  assert.equal(await ask.count(), 0, "a project with an edition asks nothing");
  assert.equal(await page.getByLabel("Edition", { exact: true }).inputValue(), "founder");
  await lobby();

  await enter("shop");
  await ask.waitFor();
  assert.equal(await ask.evaluate((d) => d.open), true, "entering a project with no edition asks");
  assert.match(await ask.locator("h2").innerText(), /What kind of project is shop\?/);
  await page.screenshot({ path: join(OUT, "02-ask.png") });
  await ask.getByRole("button", { name: "Not now" }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(await page.getByLabel("Edition", { exact: true }).inputValue(), "", "still not chosen");
  await lobby();
  await enter("shop");
  await ask.waitFor();
  await page.keyboard.press("Escape");
  await ask.waitFor({ state: "detached" });
  await lobby();
  await enter("shop");
  await ask.waitFor();
  await ask.getByRole("button", { name: "Founder", exact: true }).click();
  await ask.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector(".edition-select select")?.value === "founder");
  assert.equal(readEdition(projectFile(projectsDir, SHOP)), "founder", "the choice is saved in the project's file");
  await page.screenshot({ path: join(OUT, "03-founder.png") });

  await page.getByLabel("Edition", { exact: true }).selectOption("work");
  await page.waitForFunction(() => document.querySelector(".edition-select select")?.value === "work");
  assert.equal(readEdition(projectFile(projectsDir, SHOP)), "work", "the top bar switches it");
  await lobby();
  assert.equal(await door("shop").locator(".edition").innerText(), "Work");
  await page.screenshot({ path: join(OUT, "04-switched.png") });
  assert.deepEqual(errors, [], "no page errors");
  console.log(`editions-proof: all checks passed; screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
