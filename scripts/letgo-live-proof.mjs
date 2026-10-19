// Live proof of Let go: `f1rm hire` starts one real Haiku background session (hooks off, so it never reaches any office);
// the real `f1rm serve` (temp HOME, its own port) serves an office that shows it, because the proof reports the session's
// start to that office; headless Chrome lets it go from its panel; `claude agents --json --all` must then no longer list it.
// Cleanup removes its worktree, branch and the agent-memory folder it created.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome PROJ=/a/trusted/repo OUT=/some/dir bun scripts/letgo-live-proof.mjs
// PROJ (default: this repo) must be a git repo whose folder Claude Code trusts (a background session needs that trust).
// The `claude` that f1rm finds first on PATH is a one-line wrapper that restores the real HOME, so the hire logs in.
// playwright-core is deliberately not a dependency of the repo.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "letgo-live-proof-out");
mkdirSync(OUT, { recursive: true });
const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = homedir();
const PROJ = resolve(process.env.PROJ ?? ROOT);
const tmp = mkdtempSync(join(tmpdir(), "f1rm-letgo-proof-"));
const home = join(tmp, "home"), bin = join(tmp, "bin");
for (const d of [home, bin]) mkdirSync(d, { recursive: true });
const realClaude = Bun.which("claude");
assert.ok(realClaude, "claude is on PATH");
const TASK = `letgo-proof-${Math.random().toString(36).slice(2, 6)}`;
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
// Claude Code puts a hire's worktree under the main repo's .claude/worktrees, whichever linked worktree PROJ is.
const worktree = () => new RegExp(`^worktree (.*/\\.claude/worktrees/${TASK})$`, "m").exec(git("worktree", "list", "--porcelain").stdout.toString())?.[1];

writeFileSync(join(bin, "open"), "#!/bin/sh\n");
writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME='${REAL_HOME}' exec '${realClaude}' "$@"\n`);
chmodSync(join(bin, "open"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

const port = 41900 + Math.floor(Math.random() * 100);
const f1rmEnv = { ...process.env, HOME: home, F1RM_PORT: String(port), PATH: `${bin}:${process.env.PATH}` };
const cli = (...args) => Bun.spawn(["bun", join(ROOT, "office/cli/f1rm.ts"), ...args], { env: f1rmEnv, cwd: PROJ, stdout: "pipe", stderr: "inherit" });
await cli("install").exited;
const secret = /X-F1rm-Secret: (\S+)/i.exec(readFileSync(join(home, ".f1rm/ingest-headers"), "utf8"))?.[1];
assert.ok(secret, "install wrote the ingest secret into the temp home");

const server = cli("serve");
let hired;
const cleanup = async () => {
  server.kill();
  if (hired) {
    // Only reached when the panel's Let go did not finish the job; `stop` and `rm` can race the session's own exit.
    for (let i = 0; i < 30 && (await listed()).some((a) => a.sessionId === hired.sessionId); i++) {
      await claude("stop", hired.id);
      await claude("rm", hired.id);
      await Bun.sleep(1000);
    }
  }
  // Claude Code locks the worktree of a background session, and a locked one needs --force twice.
  const left = worktree();
  if (left) git("worktree", "remove", "--force", "--force", left);
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
  assert.ok(url, "f1rm serve printed the office URL");
  const base = new URL(url).origin;

  const hire = Bun.spawn(
    ["bun", join(ROOT, "office/cli/f1rm.ts"), "hire", "--report-to", "", "designer", NAME, TASK,
      "This is an automated test of Let go. Reply with only the word OK and stop. Do not read or change any file.",
      "--model", "haiku", "--settings", '{"disableAllHooks":true}'],
    { env: f1rmEnv, cwd: PROJ, stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(await hire.exited, 0, `f1rm hire exited 0: ${await new Response(hire.stderr).text()}`);
  hired = await until(async () => (await listed()).find((a) => a.name === NAME), 60_000, `${NAME} in claude agents`);
  assert.equal(hired.kind, "background", "it is a background session");
  await until(worktree, 60_000, "its own worktree");
  console.log(`hired with f1rm hire: ${JSON.stringify({ id: hired.id, name: hired.name, kind: hired.kind, state: hired.state })}`);

  const seed = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": secret },
    body: JSON.stringify({ session_id: hired.sessionId, transcript_path: join(tmp, "seed.jsonl"), cwd: PROJ, hook_event_name: "UserPromptSubmit", prompt: "go", agent_type: "f1rm:designer" }),
  });
  assert.equal(seed.status, 200);

  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.locator(".door").first().click();
  await page.locator(".roster button", { hasText: "Designer," }).dispatchEvent("click");
  const panel = page.locator(".panel");
  await panel.getByRole("button", { name: "Let go", exact: true }).click();
  await page.screenshot({ path: join(OUT, "letgo-live-1-confirm.png") });
  await panel.getByRole("button", { name: "Yes, let go", exact: true }).click();
  await panel.waitFor({ state: "detached", timeout: 90_000 });
  assert.equal(await page.locator(".roster button", { hasText: "Designer," }).count(), 0, "the office no longer lists the hire");
  await page.screenshot({ path: join(OUT, "letgo-live-2-gone.png") });

  const after = await listed();
  assert.ok(!after.some((a) => a.sessionId === hired.sessionId || a.id === hired.id), "claude agents --json --all no longer lists it");
  console.log(`its worktree after Let go: ${worktree() ? "left behind (cleaned up below)" : "removed"}`);
  hired = null;
  assert.deepEqual(errors, [], "no page errors");
  console.log(`PASS Let go live: ${NAME} let go from the panel, and claude agents --json --all no longer lists it`);
  await browser.close();
} finally {
  await cleanup();
}
process.exit(0);
