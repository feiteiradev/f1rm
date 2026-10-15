// Live proof of Hire: the real `f1rm start` (temp HOME, its own port) serves the office; headless Chrome hires one Haiku
// Designer through the dialog; a real background session starts in its own worktree. Checks that `claude agents --json`
// lists it by name and that its hooks, which come from the real ~/.claude/settings.json, reach the real office
// (read from ~/.f1rm/office-url), then stops it, removes it, its worktree, its branch and the agent-memory it created.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome PROJ=/a/trusted/repo OUT=/some/dir bun scripts/hire-live-proof.mjs
// PROJ must be a git repo whose exact folder Claude Code already trusts (a background session needs that trust).
// The `claude` that f1rm finds first on PATH is a one-line wrapper that restores the real HOME, so the hire logs in and loads the real hooks.
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "hire-live-proof-out");
mkdirSync(OUT, { recursive: true });
const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = homedir();
const PROJ = resolve(process.env.PROJ ?? ROOT);
const tmp = mkdtempSync(join(tmpdir(), "f1rm-hire-proof-"));
const home = join(tmp, "home"), bin = join(tmp, "bin");
for (const d of [home, bin]) mkdirSync(d, { recursive: true });
const realClaude = Bun.which("claude");
assert.ok(realClaude, "claude is on PATH");
const TASK = `live-proof-${Math.random().toString(36).slice(2, 6)}`;
const NAME = `designer-${TASK}`;
const memory = join(REAL_HOME, ".claude/agent-memory");
const memoryBefore = new Set(existsSync(memory) ? readdirSync(memory) : []);

const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
};
const claude = async (...args) => {
  const p = Bun.spawn([realClaude, ...args], { env: claudeEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
};
const listed = async () => JSON.parse((await claude("agents", "--json", "--all")).out);
const git = (...args) => Bun.spawnSync(["git", "-C", PROJ, ...args], { stdout: "pipe", stderr: "pipe" });

writeFileSync(join(bin, "open"), "#!/bin/sh\n");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME='${REAL_HOME}' exec '${realClaude}' "$@"\n`);
chmodSync(join(bin, "open"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

const port = 41900 + Math.floor(Math.random() * 100);
const f1rmEnv = { ...process.env, HOME: home, F1RM_PORT: String(port), PATH: `${bin}:${process.env.PATH}` };
const cli = (...args) => Bun.spawn(["bun", join(ROOT, "office/cli/f1rm.ts"), ...args], { env: f1rmEnv, cwd: ROOT, stdout: "pipe", stderr: "inherit" });
await cli("install").exited;
const secret = /X-F1rm-Secret: (\S+)/i.exec(readFileSync(join(home, ".f1rm/ingest-headers"), "utf8"))?.[1];
assert.ok(secret, "install wrote the ingest secret into the temp home");

const server = cli("start");
let hired;
const cleanup = async () => {
  server.kill();
  if (hired) {
    // `stop` and `rm` can race the session's own exit, so retry until the session is gone from `--all`.
    for (let i = 0; i < 30 && (await listed()).some((a) => a.sessionId === hired.sessionId); i++) {
      await claude("stop", hired.id ?? hired.sessionId);
      await claude("rm", hired.id ?? hired.sessionId);
      await Bun.sleep(1000);
    }
    const gone = !(await listed()).some((a) => a.sessionId === hired.sessionId);
    console.log(`cleanup: session ${gone ? "gone from `claude agents --all`" : "STILL LISTED"}`);
  }
  // Claude Code locks the worktree of a background session, and a locked one needs --force twice.
  git("worktree", "remove", "--force", "--force", join(PROJ, ".claude/worktrees", TASK));
  git("worktree", "prune");
  git("branch", "-D", `worktree-${TASK}`);
  if (existsSync(memory)) for (const d of readdirSync(memory)) if (d.startsWith("f1rm-") && !memoryBefore.has(d)) rmSync(join(memory, d), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
};
process.on("SIGINT", async () => (await cleanup(), process.exit(130)));

try {
  const decoder = new TextDecoder();
  let out = "";
  let url;
  for await (const chunk of server.stdout) {
    out += decoder.decode(chunk);
    url = /f1rm office: (\S+)/.exec(out)?.[1];
    if (url) break;
  }
  assert.ok(url, "f1rm start printed the office URL");
  const base = new URL(url).origin;

  // A hook event with the repo as its cwd makes the repo's room, the way any session in it would.
  const seed = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": secret },
    body: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", transcript_path: join(tmp, "seed.jsonl"), cwd: PROJ, hook_event_name: "SessionStart", source: "startup" }),
  });
  assert.equal(seed.status, 200);

  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.locator(".door").first().click();
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  const dialog = page.locator("dialog.hire");
  await dialog.locator(".role").first().waitFor();
  await dialog.locator(".role", { hasText: "Maya" }).click();
  await page.getByLabel("Brief", { exact: true }).fill("This is an automated test of the office's Hire dialog. Reply with only the word OK and stop. Do not read or change any file.");
  await page.getByLabel("Task name", { exact: true }).fill(TASK);
  await page.getByLabel("Model", { exact: true }).selectOption("haiku");
  await page.screenshot({ path: join(OUT, "live-1-filled.png") });
  await page.getByRole("button", { name: "Hire Maya" }).click();
  await dialog.waitFor({ state: "detached", timeout: 60_000 });
  console.log(`hired from the browser: ${NAME}`);

  hired = await until(async () => (await listed()).find((a) => a.name === NAME), 60_000, `${NAME} in claude agents`);
  assert.equal(hired.kind, "background", "it is a background session");
  await until(() => git("worktree", "list").stdout.toString().includes(`.claude/worktrees/${TASK}`), 60_000, "its own worktree");
  console.log(`claude agents lists it: ${JSON.stringify({ name: hired.name, kind: hired.kind, state: hired.state, cwd: hired.cwd })}`);

  const real = readFileSync(join(REAL_HOME, ".f1rm/office-url"), "utf8").trim();
  const realOrigin = new URL(real).origin;
  const realSocket = new URL("ws", real.endsWith("/") ? real : `${real}/`);
  realSocket.protocol = "ws:";
  const realOffice = () =>
    new Promise((res, rej) => {
      const ws = new WebSocket(realSocket, { headers: { origin: realOrigin } });
      ws.onmessage = (m) => (ws.close(), res(JSON.parse(String(m.data))));
      ws.onerror = () => rej(new Error("the real office isn't reachable"));
    });
  const arrived = await until(async () => Object.values((await realOffice()).employees).find((e) => e.sessionId === hired.sessionId), 120_000, "the hire to appear in the real office");
  assert.equal(arrived.role, "designer", "it arrived as the Designer");
  console.log(`the real office shows it: ${JSON.stringify({ name: arrived.name, role: arrived.role, title: arrived.title, status: arrived.status })}`);

  assert.deepEqual(errors, [], "no page errors");
  console.log(`PASS Hire live: ${NAME} started from the dialog, listed by claude agents, and arrived in the real office`);
  await browser.close();
} finally {
  await cleanup();
}
process.exit(0);
