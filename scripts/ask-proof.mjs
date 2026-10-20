// Live proof of Ask: a real Haiku session holds a codeword; the real `f1rm serve` (temp HOME) serves the office;
// headless Chrome asks it through the panel. Checks the answer streams in, the target's transcript is
// byte-identical afterwards, and the fork never becomes an employee or leaves a transcript.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/ask-proof.mjs
// playwright-core is deliberately not a dependency of the repo.
// f1rm itself runs with a temp HOME and its own hooks. Claude Code needs the real login, so the `claude` that f1rm
// finds first on PATH is a one-line wrapper that restores the real HOME; the target session writes its transcript there.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "ask-proof-out");
mkdirSync(OUT, { recursive: true });
const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = homedir();
const tmp = mkdtempSync(join(tmpdir(), "f1rm-ask-proof-"));
const home = join(tmp, "home"), proj = join(tmp, "proj"), bin = join(tmp, "bin");
for (const d of [home, proj, bin]) mkdirSync(d, { recursive: true });
const realClaude = Bun.which("claude");
assert.ok(realClaude, "claude is on PATH");
const memoryBefore = new Set(existsSync(join(REAL_HOME, ".claude/agent-memory")) ? readdirSync(join(REAL_HOME, ".claude/agent-memory")) : []);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
};

writeFileSync(join(bin, "open"), "#!/bin/sh\n");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME='${REAL_HOME}' exec '${realClaude}' "$@"\n`);
chmodSync(join(bin, "open"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

const port = 41700 + Math.floor(Math.random() * 200);
const f1rmEnv = { ...process.env, TMPDIR: "", HOME: home, F1RM_PORT: String(port), PATH: `${bin}:${process.env.PATH}` };
const cli = (...args) => Bun.spawn(["bun", join(ROOT, "office/cli/f1rm.ts"), ...args], { env: f1rmEnv, cwd: ROOT, stdout: "pipe", stderr: "inherit" });
await cli("install").exited;
const hooks = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks;
const targetSettings = join(tmp, "target-settings.json");
writeFileSync(targetSettings, JSON.stringify({ hooks }));

const server = cli("serve");
let url, target;
const cleanup = () => {
  target?.kill();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
  const mem = join(REAL_HOME, ".claude/agent-memory");
  if (existsSync(mem)) for (const d of readdirSync(mem)) if (d.startsWith("f1rm-") && !memoryBefore.has(d)) rmSync(join(mem, d), { recursive: true, force: true });
};
process.on("SIGINT", () => (cleanup(), process.exit(130)));

try {
  const decoder = new TextDecoder();
  // serve prints the link only to a terminal; it also writes it to office-url
  const urlFile = join(home, ".f1rm/office-url");
  for (let i = 0; i < 400 && !existsSync(urlFile); i++) await Bun.sleep(25);
  url = existsSync(urlFile) ? readFileSync(urlFile, "utf8") : undefined;
  assert.ok(url, "f1rm serve wrote the office URL");

  const word = `MANGO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const sid = randomUUID();
  // A `claude -p` that stays open on its input stream: one live session, idle after its first turn.
  target = Bun.spawn(
    [realClaude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--session-id", sid, "--settings", targetSettings],
    { cwd: proj, env: claudeEnv(), stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  target.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: `Remember the codeword ${word}. Reply with only: stored` } }) + "\n");
  target.stdin.flush();
  let targetOut = "";
  const targetReader = target.stdout.getReader();
  while (!targetOut.includes('"type":"result"')) {
    const r = await targetReader.read();
    if (r.done) break;
    targetOut += decoder.decode(r.value);
  }
  assert.match(targetOut, /stored/i, "the target session stored the codeword");

  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  // The office state as the page's own socket receives it.
  const office = () =>
    page.evaluate(
      () =>
        new Promise((res) => {
          const u = new URL("ws", location.href);
          u.protocol = "ws:";
          const w = new WebSocket(u);
          w.onmessage = (m) => (res(JSON.parse(m.data)), w.close());
        }),
    );
  const employee = await until(async () => (await office()).employees[sid], 20_000, "the target to appear as an employee");
  assert.ok(employee.transcript && existsSync(employee.transcript), "the employee carries its transcript path");
  const transcript = employee.transcript;
  const before = sha(transcript);
  const projectDir = join(transcript, "..");
  const filesBefore = readdirSync(projectDir).sort();

  // The page opens on the lobby; Ask lives in the project's office behind the door.
  await page.locator(".door").first().click();
  await page.locator(".back").waitFor();
  // The first entry asks the project's edition; this office keeps settings, so answer it once.
  await page.locator("dialog.edition-ask").getByRole("button", { name: "Work", exact: true }).click();
  await page.locator("dialog.edition-ask").waitFor({ state: "detached" });
  await page.locator(".roster button").first().focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(".panel");
  await panel.waitFor();
  assert.match(await panel.locator(".hint").innerText(), /can't see the turn being written right now/, "the panel notes what Ask can't see");

  // Samples the answer while it streams, to show it grows in steps rather than landing at once.
  await page.evaluate(() => {
    window.__answers = [];
    setInterval(() => {
      const a = document.querySelector(".history [data-kind=ask] .a")?.textContent ?? "";
      const last = window.__answers.at(-1);
      if (a && a !== last) window.__answers.push(a);
    }, 20);
  });
  await panel.getByLabel("Ask a side question").fill(`What codeword did I ask you to remember? Answer in one sentence that quotes the codeword, then add two sentences on why a short, unique codeword is easy to recall.`);
  await page.screenshot({ path: join(OUT, "ask-typed.png") });
  await panel.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".history [data-kind=ask][data-state=done], .history [data-kind=ask][data-state=failed]").waitFor({ timeout: 120_000 });
  const entry = page.locator(".history [data-kind=ask]");
  const answer = await entry.locator(".a").innerText();
  const steps = (await page.evaluate(() => window.__answers)).filter((a) => !a.startsWith("Reading its session"));
  await page.screenshot({ path: join(OUT, "ask-answered.png") });
  assert.equal(await entry.getAttribute("data-state"), "done", `the Ask succeeded (${await entry.innerText()})`);
  assert.ok(answer.includes(word), `the answer quotes the codeword ${word}: ${answer}`);
  assert.ok(steps.length >= 2 && steps.every((s, i) => i === 0 || s.startsWith(steps[i - 1])), `the answer grew in ${steps.length} steps while streaming`);

  await panel.getByRole("button", { name: "Close panel" }).click();
  await page.locator(".roster button").first().focus();
  await page.keyboard.press("Enter");
  await panel.waitFor();
  assert.ok((await panel.locator(".history li").innerText()).includes(word), "the shift's history is still in the panel after closing and reopening it");

  await Bun.sleep(3000);
  assert.equal(sha(transcript), before, "the target's transcript is byte-identical after the Ask");
  assert.deepEqual(readdirSync(projectDir).sort(), filesBefore, "the fork left no transcript of its own");
  assert.deepEqual(Object.keys((await office()).employees), [sid], "no new employee appeared for the fork");
  assert.deepEqual(errors, [], "no page errors");
  console.log(`PASS Ask: ${steps.length} streamed steps, answer "${answer.replace(/\s+/g, " ").slice(0, 120)}", transcript sha256 ${before.slice(0, 12)} unchanged, 1 employee, screenshots in ${OUT}`);
  await browser.close();
} finally {
  cleanup();
}
process.exit(0);
