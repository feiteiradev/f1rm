// Live proof of raised-hand approvals: a real Haiku interactive session (in a PTY, default permission mode) asks to run
// `touch`; the real `f1rm serve` (temp HOME, short approval timeout) holds its PermissionRequest hook; headless Chrome
// approves it, denies it, or leaves it to time out from the top-bar tray. Checks that the file was created only when it
// should be, that after the timeout the terminal's own prompt still works, and that with the office stopped the session never waits on it.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/approvals-proof.mjs
// PROJ defaults to a throwaway folder; Claude Code then shows its trust dialog, which this script answers (Claude Code records that in ~/.claude.json).
// playwright-core is deliberately not a dependency of the repo.
// f1rm runs with a temp HOME and its own hooks. Claude Code needs the real login, so the `claude` that f1rm finds first
// on PATH is a one-line wrapper that restores the real HOME; the target writes its transcript there.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "approvals-proof-out");
mkdirSync(OUT, { recursive: true });
const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = homedir();
const tmp = mkdtempSync(join(tmpdir(), "f1rm-approvals-proof-"));
const home = join(tmp, "home"), bin = join(tmp, "bin");
const proj0 = resolve(process.env.PROJ ?? join(tmp, "proj"));
for (const d of [home, bin, proj0]) mkdirSync(d, { recursive: true });
const proj = realpathSync(proj0);
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
const nonce = () => Math.random().toString(36).slice(2, 8).toUpperCase();

writeFileSync(join(bin, "open"), "#!/bin/sh\n");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME='${REAL_HOME}' exec '${realClaude}' "$@"\n`);
chmodSync(join(bin, "open"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

const TIMEOUT_S = 15;
const port = 41900 + Math.floor(Math.random() * 100);
const f1rmEnv = { ...process.env, HOME: home, F1RM_PORT: String(port), F1RM_APPROVAL_TIMEOUT: String(TIMEOUT_S), PATH: `${bin}:${process.env.PATH}` };
const cli = (...args) => Bun.spawn(["bun", join(ROOT, "office/cli/f1rm.ts"), ...args], { env: f1rmEnv, cwd: ROOT, stdout: "pipe", stderr: "inherit" });
await cli("install").exited;
const f1rmHooks = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks;
const secret = /: (\S+)/.exec(readFileSync(join(home, ".f1rm/ingest-headers"), "utf8"))[1];
assert.ok(f1rmHooks.PermissionRequest[0].hooks[0].timeout > TIMEOUT_S, "the installed permission hook outlasts the broker");

// The target's own record of when each hook fired, next to f1rm's hooks. The record hooks return no decision.
const timing = join(tmp, "timing.jsonl");
const record = { type: "command", command: `python3 -c "import sys,time,json;print(json.dumps({'t':time.time(),'p':json.load(sys.stdin)}))" >> '${timing}'` };
const targetSettings = join(tmp, "target-settings.json");
const hooks = { ...f1rmHooks };
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop"]) {
  hooks[event] = [...(hooks[event] ?? []), { hooks: [record] }];
}
writeFileSync(targetSettings, JSON.stringify({ hooks }));
const seen = () => (existsSync(timing) ? readFileSync(timing, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const count = (name) => seen().filter((r) => r.p.hook_event_name === name && r.p.session_id === sid).length;

const server = cli("serve");
let url, target, raw = "", trusted = false, sid;
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
const dialog = /Doyouwantto|Yes,and|1\.Yes|Allowthis/;

try {
  const decoder = new TextDecoder();
  // serve prints the link only to a terminal; it also writes it to office-url
  const urlFile = join(home, ".f1rm/office-url");
  for (let i = 0; i < 400 && !existsSync(urlFile); i++) await Bun.sleep(25);
  url = existsSync(urlFile) ? readFileSync(urlFile, "utf8") : undefined;
  assert.ok(url, "f1rm serve wrote the office URL");
  const origin = new URL(url).origin;

  sid = randomUUID();
  target = Bun.spawn(
    [realClaude, "--model", "haiku", "--session-id", sid, "--permission-mode", "default", "--settings", targetSettings],
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
  const employee = await until(async () => (await office()).employees[sid], 90_000, "the target to appear as an employee");
  await Bun.sleep(3000);
  const roomName = (await office()).rooms[employee.room].name;

  const badge = () => page.locator(".tray-button .badge").innerText();
  const openTray = async () => {
    if ((await page.locator(".tray-button").getAttribute("aria-expanded")) !== "true") await page.locator(".tray-button").click();
    await page.locator(".tray-panel").waitFor();
  };

  // Untrusted text: a made-up session asks for a very long command full of markup. It must show whole and as plain text.
  const hostile = `echo '<img src=x onerror="window.__xss=1">' && ${"printf long-argument; ".repeat(150)}&& rm -rf ./build`;
  const fake = fetch(`${origin}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": secret },
    body: JSON.stringify({ session_id: "hostile", cwd: proj, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: hostile } }),
  });
  await page.locator(".tray-button[data-waiting]").waitFor();
  assert.equal(await badge(), "1", "the badge counts the raised hand");
  await openTray();
  const args = page.locator(".hand .args");
  assert.equal(await args.innerText(), hostile, "the whole command shows, not a shortened one");
  assert.equal(await page.locator(".hand .args img").count(), 0, "the arguments are text, not HTML");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "markup in the arguments did not run");
  assert.ok(await args.evaluate((el) => el.scrollHeight <= el.clientHeight), "no part of the command is hidden inside its block");
  const [argsBox, approveBox] = [await args.boundingBox(), await page.locator(".hand .approve").boundingBox()];
  assert.ok(approveBox.y >= argsBox.y + argsBox.height, "the approve button sits below the whole command");
  const order = await page.locator(".hand").evaluate((li) => [...li.querySelectorAll("pre, button")].map((e) => e.tagName + (e.className || "")));
  assert.deepEqual(order, ["PRE" + "args", "BUTTONapprove", "BUTTONdeny"], "the command comes before the approve button");
  await page.screenshot({ path: join(OUT, "hostile-tray.png") });
  await page.locator(".hand .deny").click();
  const answered = await (await fake).json();
  assert.equal(answered.hookSpecificOutput.decision.behavior, "deny", "denying answers the held hook");
  await until(async () => (await badge()) === "0", 5000, "the tray to empty");

  // One round: ask the target to run touch, wait for its hand in the tray, then let `act` decide.
  async function round(name, act) {
    const file = join(proj, `f1rm-${name}-${nonce()}`);
    const mark = raw.length, stops = count("Stop");
    await type(`Run exactly this bash command and then reply done: /usr/bin/touch ${file}`);
    const hand = await until(async () => (await office()).approvals?.find((a) => a.sessionId === sid), 90_000, `${name}: the target's hand`);
    const raisedAt = Date.now();
    assert.equal(hand.tool, "Bash");
    assert.ok(hand.input.command.includes(file), `the hand carries the command (${hand.input.command})`);
    await until(() => dialog.test(strip(raw.slice(mark))), 20_000, `${name}: the terminal dialog`);
    assert.equal((await office()).approvals.length, 1, "the terminal dialog is up while the hand is raised");
    await openTray();
    const item = page.locator(".hand");
    assert.equal(await badge(), "1");
    const text = await item.innerText();
    for (const want of [employee.name, roomName, "Bash"]) assert.ok(text.includes(want), `the tray shows ${want}: ${text}`);
    assert.equal(await item.locator(".args").innerText(), hand.input.command, "the tray shows the full command");
    await page.screenshot({ path: join(OUT, `${name}-tray.png`) });
    await act({ file, raisedAt, mark });
    await until(() => count("Stop") > stops, 90_000, `${name}: the turn to end`);
    return file;
  }

  await round("approve", async ({ file }) => {
    await page.locator(".hand .approve").click();
    await until(() => existsSync(file), 30_000, "the approved command to run");
    await until(async () => (await badge()) === "0", 5000, "the tray to empty");
  });
  const approved = readdirSync(proj).filter((f) => f.startsWith("f1rm-approve-"));
  assert.equal(approved.length, 1, "the approved command ran");
  await Bun.sleep(2000);

  const denied = await round("deny", async ({ file }) => {
    await page.locator(".hand .deny").click();
    await until(async () => (await badge()) === "0", 5000, "the tray to empty");
    await Bun.sleep(3000);
    assert.ok(!existsSync(file), "the denied command did not run");
  });
  assert.ok(!existsSync(denied), "the denied command still has not run once the turn ended");
  await Bun.sleep(2000);

  await round("timeout", async ({ file, raisedAt, mark }) => {
    await until(async () => (await office()).approvals.length === 0, (TIMEOUT_S + 10) * 1000, "the hold to time out");
    const held = (Date.now() - raisedAt) / 1000;
    assert.ok(held >= TIMEOUT_S - 1, `the hold lasted until the timeout (${held.toFixed(1)} s of ${TIMEOUT_S} s)`);
    await page.waitForFunction(() => document.querySelector(".tray-button .badge")?.textContent === "0");
    await page.screenshot({ path: join(OUT, "timeout-tray-empty.png") });
    assert.ok(!existsSync(file), "no decision was returned, so the command has not run");
    assert.ok(dialog.test(strip(raw.slice(-8000))), "the terminal prompt is still showing");
    assert.equal((await office()).employees[sid].status, "waiting", "the employee is still waiting");
    target.terminal.write("\r");
    await until(() => existsSync(file), 30_000, "the command to run after answering in the terminal");
  });
  assert.equal(readdirSync(proj).filter((f) => f.startsWith("f1rm-timeout-")).length, 1, "answering in the terminal after the timeout ran the command");

  assert.deepEqual(errors, [], "no page errors");

  // With the office closed the hooks fail to connect; the session must go on to its own prompt without waiting.
  server.kill();
  await server.exited;
  const downFile = join(proj, `f1rm-down-${nonce()}`), downMark = raw.length, downStops = count("Stop"), downPerms = count("PermissionRequest");
  await type(`Run exactly this bash command and then reply done: /usr/bin/touch ${downFile}`);
  await until(() => count("PermissionRequest") > downPerms, 90_000, "the permission hook to fire with the office down");
  const firedAt = Date.now();
  await until(() => dialog.test(strip(raw.slice(downMark))), 20_000, "the terminal dialog with the office down");
  const shownIn = (Date.now() - firedAt) / 1000;
  assert.ok(shownIn < 5, `the terminal prompt showed straight away with the office down (${shownIn.toFixed(1)} s after the hook fired)`);
  target.terminal.write("\r");
  await until(() => existsSync(downFile), 30_000, "the command to run with the office down");
  await until(() => count("Stop") > downStops, 90_000, "the turn to end with the office down");

  console.log(
    `PASS approvals: approve from the tray ran touch (${approved[0]}); deny from the tray did not run touch; a ${TIMEOUT_S} s timeout returned no decision, ` +
      `left the terminal prompt up, and answering it there ran touch; with the office stopped the terminal prompt showed ${shownIn.toFixed(1)} s after the hook fired and the turn finished; ` +
      `the tray showed employee ${employee.name}, project ${roomName}, tool Bash, the whole command as text; screenshots in ${OUT}`,
  );
  await browser.close();
} finally {
  cleanup();
}
process.exit(0);
