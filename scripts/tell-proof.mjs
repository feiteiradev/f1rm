// Live proof of Tell: a real Haiku interactive session (in a PTY) runs a long tool; the real `f1rm start` (temp HOME)
// serves the office; headless Chrome tells it a codeword through the panel while the tool runs. Checks, from timestamps
// of the target's own hooks, that the message was read after the running tool finished (not before, not by killing
// it), that the codeword came back, and that Ask and Tell look different in the panel.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome PROJ=/a/trusted/folder OUT=/some/dir bun scripts/tell-proof.mjs
// PROJ must be a folder Claude Code already trusts (an untrusted one makes the target stop at the trust dialog; this script answers it, which writes to ~/.claude.json).
// playwright-core is deliberately not a dependency of the repo.
// f1rm runs with a temp HOME and its own hooks. Claude Code needs the real login, so the `claude` that f1rm finds first
// on PATH is a one-line wrapper that restores the real HOME; the target writes its transcript there.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "tell-proof-out");
mkdirSync(OUT, { recursive: true });
const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = homedir();
const tmp = mkdtempSync(join(tmpdir(), "f1rm-tell-proof-"));
const home = join(tmp, "home"), bin = join(tmp, "bin");
const proj = resolve(process.env.PROJ ?? tmp);
for (const d of [home, bin]) mkdirSync(d, { recursive: true });
const realClaude = Bun.which("claude");
assert.ok(realClaude, "claude is on PATH");
const memoryBefore = new Set(existsSync(join(REAL_HOME, ".claude/agent-memory")) ? readdirSync(join(REAL_HOME, ".claude/agent-memory")) : []);
const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
};
const strip = (s) => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "").replace(/\s+/g, "");

writeFileSync(join(bin, "open"), "#!/bin/sh\n");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME='${REAL_HOME}' exec '${realClaude}' "$@"\n`);
chmodSync(join(bin, "open"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

const port = 41900 + Math.floor(Math.random() * 100);
const f1rmEnv = { ...process.env, HOME: home, F1RM_PORT: String(port), PATH: `${bin}:${process.env.PATH}` };
const cli = (...args) => Bun.spawn(["bun", join(ROOT, "office/cli/f1rm.ts"), ...args], { env: f1rmEnv, cwd: ROOT, stdout: "pipe", stderr: "inherit" });
await cli("install").exited;
const f1rmHooks = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks;

// The target's own record of when each hook fired, next to f1rm's hooks.
const timing = join(tmp, "timing.jsonl");
const record = {
  type: "command",
  command: `python3 -c "import sys,time,json;print(json.dumps({'t':time.time(),'p':json.load(sys.stdin)}))" >> '${timing}'`,
};
const targetSettings = join(tmp, "target-settings.json");
const hooks = { ...f1rmHooks };
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]) {
  hooks[event] = [...(hooks[event] ?? []), { hooks: [record] }];
}
writeFileSync(targetSettings, JSON.stringify({ hooks }));
const seen = () => (existsSync(timing) ? readFileSync(timing, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const server = cli("start");
let url, target, raw = "", trusted = false;
const cleanup = () => {
  target?.kill();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
  const mem = join(REAL_HOME, ".claude/agent-memory");
  if (existsSync(mem)) for (const d of readdirSync(mem)) if (d.startsWith("f1rm-") && !memoryBefore.has(d)) rmSync(join(mem, d), { recursive: true, force: true });
};
process.on("SIGINT", () => (cleanup(), process.exit(130)));
const type = async (text) => {
  target.terminal.write(text);
  await Bun.sleep(400);
  target.terminal.write("\r");
};

try {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of server.stdout) {
    out += decoder.decode(chunk);
    url = /f1rm office: (\S+)/.exec(out)?.[1];
    if (url) break;
  }
  assert.ok(url, "f1rm start printed the office URL");

  const sid = randomUUID();
  target = Bun.spawn(
    [realClaude, "--model", "haiku", "--session-id", sid, "--settings", targetSettings, "--allowedTools", "Bash(sleep *)"],
    {
      cwd: proj,
      env: { ...claudeEnv(), TERM: "xterm-256color" },
      terminal: {
        cols: 160, rows: 50,
        data: (_t, d) => {
          raw += typeof d === "string" ? d : decoder.decode(d);
          if (!trusted && strip(raw.slice(-6000)).includes("Yes,Itrustthisfolder")) {
            trusted = true;
            setTimeout(() => target.terminal.write("\x1b[B"), 300);
            setTimeout(() => target.terminal.write("\r"), 700);
          }
        },
      },
    },
  );

  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
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
  const employee = await until(async () => (await office()).employees[sid], 60_000, "the target to appear as an employee");
  assert.ok(employee.socket, "the employee carries the inbox socket from its hook headers");
  assert.ok(lstatSync(employee.socket).isSocket(), `${employee.socket} is a socket file`);
  await Bun.sleep(3000);

  const word = `TELL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await type("Run the bash command `sleep 20`, then reply with only: slept");
  const pre = await until(() => seen().find((r) => r.p.hook_event_name === "PreToolUse" && String(r.p.tool_input?.command).includes("sleep 20")), 90_000, "the sleep tool to start");
  assert.equal((await office()).employees[sid].status, "working", "the target is working while the tool runs");

  // Through the panel, while the tool runs.
  await page.locator(".door").first().click();
  await page.locator(".back").waitFor();
  await page.locator(".roster button").first().focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(".panel");
  await panel.waitFor();
  const style = (loc, props) => loc.evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el)[p]])), props);
  const askBtn = panel.getByRole("button", { name: "Ask", exact: true });
  const tellBtn = panel.getByRole("button", { name: /^Tell / });
  const askLook = await style(askBtn, ["backgroundColor", "color", "fontWeight"]);
  const tellLook = await style(tellBtn, ["backgroundColor", "color", "fontWeight"]);
  assert.notEqual(askLook.backgroundColor, tellLook.backgroundColor, "the Tell button is filled; the Ask button is not");
  assert.ok(await panel.locator("section.tell textarea").count(), "Tell takes a multi-line field");
  assert.ok(await panel.locator("section.ask input").count(), "Ask takes a one-line field");
  assert.notEqual((await style(panel.locator("section.tell"), ["borderTopColor"])).borderTopColor, (await style(panel.locator("section.ask"), ["borderTopColor"])).borderTopColor, "the Tell box has its own outline colour");
  assert.match(await tellBtn.innerText(), /^Tell /, "the Tell button names who is told");
  assert.match(await panel.locator(".tell .warn").innerText(), /running tool isn't interrupted/, "Tell says what it does");
  assert.equal(await tellBtn.isDisabled(), true, "Tell cannot be sent empty");

  await panel.getByLabel(/^Tell .* to change course$/).fill(`After the command finishes, also reply with only the codeword ${word}.`);
  await page.screenshot({ path: join(OUT, "tell-typed.png") });
  const sentAt = Date.now() / 1000;
  await tellBtn.click();
  await page.locator(".history [data-kind=tell][data-state=sent], .history [data-kind=tell][data-state=failed]").waitFor({ timeout: 15_000 });
  const entry = page.locator(".history [data-kind=tell]");
  await page.screenshot({ path: join(OUT, "tell-sent.png") });
  assert.equal(await entry.getAttribute("data-state"), "sent", `the Tell was sent (${await entry.innerText()})`);
  assert.ok((await entry.innerText()).includes(word), "the history shows what was told");

  const delivered = await until(() => seen().find((r) => r.p.hook_event_name === "UserPromptSubmit" && String(r.p.prompt).includes(word)), 60_000, "the target to read the Tell");
  const post = await until(() => seen().find((r) => r.p.hook_event_name === "PostToolUse" && String(r.p.tool_input?.command).includes("sleep 20")), 60_000, "the sleep tool to finish");
  const failed = seen().some((r) => r.p.hook_event_name === "PostToolUseFailure");
  const stop = await until(() => seen().findLast((r) => r.p.hook_event_name === "Stop" && r.t > delivered.t), 90_000, "the turn that read the Tell to finish");

  assert.ok(sentAt > pre.t && sentAt < post.t, "the Tell was sent while the sleep ran");
  assert.ok(!failed, "the running tool did not fail or get interrupted");
  assert.ok(post.t - pre.t >= 19, `the tool ran its full 20 s (${(post.t - pre.t).toFixed(1)} s)`);
  assert.ok(delivered.t >= post.t, "the target read the Tell only after the running tool finished");
  assert.ok(delivered.p.session_id === sid, "the Tell reached the session it was addressed to");

  await page.screenshot({ path: join(OUT, "tell-after.png") });
  assert.deepEqual(errors, [], "no page errors");
  console.log(
    `PASS Tell: sleep 20 started at +0.0s, Tell sent at +${(sentAt - pre.t).toFixed(1)}s, tool finished at +${(post.t - pre.t).toFixed(1)}s, ` +
      `target read the Tell at +${(delivered.t - pre.t).toFixed(1)}s (${(delivered.t - post.t).toFixed(1)}s after the tool), then replied "${String(stop.p.last_assistant_message).trim().slice(0, 80)}"; screenshots in ${OUT}`,
  );
  await browser.close();
} finally {
  cleanup();
}
process.exit(0);
