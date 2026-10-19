// Drives the real `f1rm serve` (temp HOME, real git repos) and the built page in headless Chromium, and checks the
// lobby acceptance criteria. Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/lobby-proof.mjs
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scaleFor } from "../office/client/layout.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "lobby-proof-out");
mkdirSync(OUT, { recursive: true });

const home = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-lobby-home-")));
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "open"), 0o755);
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
const free = Bun.serve({ port: 0, fetch: () => new Response() });
env.F1RM_PORT = String(free.port);
free.stop(true);

const repo = (name) => {
  const dir = join(home, "code", name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", dir]);
  return dir;
};
const shop = repo("my shop"), blog = repo("blog"), docs = repo("docs"), atlas = repo("atlas-api");

const cli = join(import.meta.dir, "../office/cli/f1rm.ts");
assert.equal(Bun.spawnSync(["bun", cli, "install"], { env }).exitCode, 0);
const office = Bun.spawn(["bun", cli, "serve"], { env, stdout: "pipe", stderr: "pipe" });
const stdout = office.stdout.getReader();
let url = "";
while (!url) url = /f1rm office: (\S+)/.exec(new TextDecoder().decode((await stdout.read()).value))?.[1] ?? "";

const secret = /: (\S+)/.exec(readFileSync(join(home, ".f1rm", "ingest-headers"), "utf8"))[1];
const send = (id, cwd, hook_event_name = "SessionStart", extra = {}) =>
  fetch(`${new URL(url).origin}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": secret },
    body: JSON.stringify({ session_id: id, cwd, hook_event_name, ...extra }),
  });
const edit = (id, cwd) => send(id, cwd, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: `${cwd}/a.ts` } });
// The server holds a PermissionRequest until it is decided, so this does not wait for the answer.
const ask = (id, cwd) => void send(id, cwd, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }).catch(() => {});

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const open = async (viewport) => {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // The jump to an employee with no terminal answers 409 on purpose; the page shows why.
  page.on("console", (m) => m.type() === "error" && !m.text().includes("409") && errors.push(m.text()));
  return page;
};
const page = await open({ width: 1440, height: 900 });
const shot = (name, p = page) => p.screenshot({ path: join(OUT, `${name}.png`) });
const door = (name, p = page) => p.locator(".door", { hasText: name });
const hash = (p = page) => p.evaluate(() => location.hash);
const settle = (ms = 500) => page.waitForTimeout(ms);

const pixelStats = (p, clip) =>
  p.screenshot({ clip }).then((buf) =>
    p.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let luma = 0, amber = 0;
      for (let i = 0; i < d.length; i += 4) {
        luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (d[i] > 225 && d[i + 1] > 150 && d[i + 1] < 195 && d[i + 2] < 90) amber++;
      }
      return { luma: luma / (d.length / 4), amber };
    }, buf.toString("base64")),
  );

// The drawn room's bounds, as the share of the scene area that is not the office's outer background.
const coverage = async (p) => {
  const buf = await p.locator(".scene").screenshot();
  return p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 21 && d[i + 1] === 24 && d[i + 2] === 34) continue;
      const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    return { w: (x1 - x0 + 1) / c.width, h: (y1 - y0 + 1) / c.height };
  }, buf.toString("base64"));
};

// The office is empty: a hallway with no doors, and the way to fill it.
await page.goto(url);
await page.locator(".hall").waitFor();
assert.match(await page.locator("main").innerText(), /office is empty/);
assert.equal(await page.locator(".door").count(), 0);
await shot("00-empty-lobby");
await page.evaluate(() => (window.__noReload = true));

await edit("s1", shop);
await ask("s2", shop);
await edit("b1", blog);
await send("d1", docs);
await send("d1", docs, "SessionEnd");
await edit("a1", atlas);
await door("my shop").waitFor();
await page.waitForFunction(() => document.querySelectorAll(".door").length === 4);
await settle();

// The landing view is the lobby: one door per project, labelled with its name, with a summary.
assert.equal(await hash(), "", "the lobby has no fragment");
assert.deepEqual(await page.locator(".door .name").allInnerTexts(), ["atlas-api", "blog", "docs", "my shop"]);
const meta = (name) => door(name).locator(".meta").innerText();
assert.equal(await meta("my shop"), "2 inside\nwaiting");
assert.equal(await meta("blog"), "1 inside");
assert.equal(await meta("atlas-api"), "1 inside");
assert.equal(await meta("docs"), "empty");
assert.equal(await page.locator(".door[data-waiting]").count(), 1);
assert.equal(await page.locator(".door[data-empty]").count(), 1);
assert.equal(await page.locator(".roster").count(), 0, "no project's roster in the lobby");
assert.equal(await page.locator("main").innerText().then((t) => /office is empty/.test(t)), false);
const counter = () => page.locator(".counter li").evaluateAll((l) => Object.fromEntries(l.map((i) => [i.dataset.status, +i.querySelector(".count").textContent])));
assert.deepEqual(await counter(), { working: 3, waiting: 1, idle: 0 }, "the lobby counts everyone");
await shot("01-lobby");

// A raised hand over the door with someone waiting, and a dimmed door for the empty project.
const scale = scaleFor(1440);
const region = async (name, [x, y, w, h]) => {
  const b = await door(name).boundingBox();
  return pixelStats(page, { x: b.x + x * scale, y: b.y + y * scale, width: w * scale, height: h * scale });
};
const hand = (name) => region(name, [41, 2, 11, 11]);
const slab = (name) => region(name, [12, 12, 32, 50]);
const sample = async (name) => {
  const seen = [];
  for (let i = 0; i < 4; i++) (seen.push(await hand(name)), await settle(130));
  return Math.max(...seen.map((s) => s.amber));
};
assert.ok((await sample("my shop")) > 40, "an amber raised hand is drawn over the shop door");
assert.equal(await sample("blog"), 0, "no hand over a door with nobody waiting");
const lit = await slab("blog"), dim = await slab("docs");
assert.ok(dim.luma < lit.luma * 0.7, `the empty project's door is dimmed (lit ${lit.luma.toFixed(1)}, dim ${dim.luma.toFixed(1)})`);
await shot("02-lobby-hand-and-dimmed-door");

// Live updates in the lobby.
await edit("d2", docs);
await page.waitForFunction(() => [...document.querySelectorAll(".door")].some((d) => d.textContent.includes("docs1 inside")));
assert.equal(await door("docs").getAttribute("data-empty"), null);
await send("s2", shop, "PostToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
await page.waitForFunction(() => document.querySelectorAll(".door[data-waiting]").length === 0);
await ask("s2", shop);
await page.waitForFunction(() => document.querySelectorAll(".door[data-waiting]").length === 1);
await send("d2", docs, "SessionEnd");
await page.waitForFunction(() => document.querySelector(".door[data-empty]")?.textContent.includes("docs"));

// Enter on a door opens that project full screen: only its employees and whiteboard.
await door("my shop").focus();
await page.keyboard.press("Enter");
await page.locator(".back").waitFor();
// The first entry asks the project's edition; this office keeps settings, so answer it once.
await page.locator("dialog.edition-ask").getByRole("button", { name: "Work", exact: true }).click();
await page.locator("dialog.edition-ask").waitFor({ state: "detached" });
await page.waitForFunction(() => document.querySelectorAll(".door").length === 0);
const shopHash = await hash();
assert.match(shopHash, /^#\/project\/.+/);
await page.locator(".roster button").first().waitFor({ state: "attached" });
const rosterText = () => page.locator(".roster button").allTextContents();
assert.equal((await rosterText()).length, 2);
assert.ok((await rosterText()).every((t) => t.includes(", my shop,")), "only shop's employees");
assert.equal(await page.locator(".boards button").count(), 1, "only shop's whiteboard");
assert.equal(await page.locator(".crumb").innerText(), "my shop");
assert.deepEqual(await counter(), { working: 1, waiting: 1, idle: 0 }, "the project's own counts");
await settle();
await shot("03-project-shop");
const full = await coverage(page);
assert.ok(full.w >= 0.85 && full.h >= 0.85, `the open project fills the 1440x900 screen (${(full.w * 100).toFixed(0)}% wide, ${(full.h * 100).toFixed(0)}% tall)`);

// Live updates in the project, the panel with Ask and Jump, and an intern.
await send("s3", shop, "SessionStart");
await page.waitForFunction(() => document.querySelectorAll(".roster button").length === 3);
await send("s1", shop, "SubagentStart", { agent_id: "i1", agent_type: "Explore" });
await page.waitForFunction(() => [...document.querySelectorAll(".roster button")].some((b) => /1 intern/.test(b.textContent)));
await page.locator(".roster button").first().focus();
await page.keyboard.press("Enter");
const panel = page.locator(".panel");
await panel.waitFor();
await panel.getByLabel("Ask a side question").waitFor();
await panel.getByRole("button", { name: "Ask", exact: true }).waitFor();
await panel.getByRole("button", { name: "Jump to terminal" }).waitFor();
await settle();
await shot("04-project-panel-ask");
for (const i of [1, 2, 0, 1, 2]) {
  await page.locator(".roster button").nth(i).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
}
assert.equal(await page.getByRole("button", { name: "Jump to terminal" }).count(), 1, "one Jump button after switching employees with the panel open");
assert.equal(await page.getByLabel("Ask a side question").count(), 1, "one Ask box after switching employees with the panel open");
assert.equal(await page.getByLabel(/^Tell .* to change course$/).count(), 1, "one Tell box after switching employees with the panel open");
await page.keyboard.press("Escape");

// The Lobby control and the browser's Back both return to the lobby; Forward goes back in.
await page.getByRole("button", { name: "Lobby" }).click();
await page.locator(".door").first().waitFor();
assert.equal(await hash(), "");
assert.equal(await page.locator(".door").count(), 4);
assert.equal(await page.evaluate(() => document.activeElement?.dataset.room !== undefined), true, "focus returned to a door");
await door("my shop").click();
await page.locator(".back").waitFor();
assert.equal(await hash(), shopHash);
await page.goBack();
await page.locator(".door").first().waitFor();
assert.equal(await hash(), "", "browser Back returned to the lobby");
await page.goForward();
await page.locator(".back").waitFor();
assert.equal(await hash(), shopHash);
assert.equal(await page.evaluate(() => window.__noReload), true, "navigation never reloaded the page");

// A reload with a project open reopens it.
await page.reload();
await page.locator(".back").waitFor();
await page.locator(".roster button").first().waitFor({ state: "attached" });
assert.equal(await page.locator(".crumb").innerText(), "my shop");
assert.equal((await rosterText()).length, 3);
await settle();
await shot("05-after-reload");

// ⌘K searches every project; picking someone elsewhere opens that project.
await page.keyboard.press("Meta+k");
const dialog = page.getByRole("dialog", { name: "Jump to an employee" });
await dialog.waitFor();
assert.equal(await dialog.getByRole("option").count(), 5, "⌘K lists everyone in every project");
await page.keyboard.type("blog");
assert.equal(await dialog.getByRole("option").count(), 1);
await shot("06-palette-other-project");
await page.keyboard.press("Enter");
await page.locator(".crumb", { hasText: "blog" }).waitFor();
assert.match(await hash(), /^#\/project\/.+/);
assert.notEqual(await hash(), shopHash);
assert.ok((await rosterText()).every((t) => t.includes(", blog,")) && (await rosterText()).length === 1, "now inside blog");
await page.locator(".palette .problem").filter({ hasText: "No iTerm2 tab or VS Code window" }).waitFor();
await shot("07-after-palette-jump");
await page.keyboard.press("Escape");
await page.goBack();
await page.locator(".crumb", { hasText: "my shop" }).waitFor();

// A link to a project the office doesn't have lands in the lobby with a note.
await page.goto(`${url}#/project/nowhere`);
await page.reload();
await page.getByText("That project isn't in the office right now.").waitFor();
assert.equal(await page.locator(".door").count(), 4);

// A 390px-wide phone: no sideways scroll in the lobby or inside a project.
const phone = await open({ width: 390, height: 844 });
await phone.goto(url);
await phone.waitForFunction(() => document.querySelectorAll(".door").length === 4);
await phone.waitForTimeout(500);
const fits = () => phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".scene")].every((s) => s.scrollWidth <= s.clientWidth));
assert.ok(await fits(), "no horizontal scroll in the lobby at 390px");
const boxes = await phone.locator(".door").evaluateAll((ds) => ds.map((d) => d.getBoundingClientRect().toJSON()));
assert.ok(boxes.every((b) => b.left >= 0 && b.right <= 390), "every door is on screen");
assert.ok(boxes.every((a, i) => boxes.every((b, j) => i === j || a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5)), "doors do not overlap");
await shot("08-phone-lobby", phone);
await phone.locator(".door", { hasText: "my shop" }).click();
await phone.locator(".back").waitFor();
await phone.locator(".roster button").first().waitFor({ state: "attached" });
await phone.waitForTimeout(500);
assert.ok(await fits(), "no horizontal scroll in a project at 390px");
const phoneFull = await coverage(phone);
assert.ok(phoneFull.w >= 0.85 && phoneFull.h >= 0.85, `the project fills the 390px screen (${(phoneFull.w * 100).toFixed(0)}% wide, ${(phoneFull.h * 100).toFixed(0)}% tall)`);
await shot("09-phone-project", phone);
await phone.locator(".roster button").first().focus();
await phone.keyboard.press("Enter");
await phone.getByLabel("Ask a side question").waitFor();
assert.ok(await fits(), "no horizontal scroll with the panel open");
await shot("10-phone-panel", phone);

assert.deepEqual(errors, [], "no page errors");
await browser.close();
office.kill();
rmSync(home, { recursive: true, force: true });
console.log(`ok, screenshots in ${OUT}`);
