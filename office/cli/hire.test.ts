// Seam 2: the real `f1rm hire`, run against a stub `claude` first on PATH.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longRepos } from "./long-repo.test-helper.ts";
import { hire as hireCommand, NO_SLOT, realWait, topicBrief, withEffort, withPonytail, type Wait } from "./hire.ts";

test("topicBrief names the project's live leads under Other teams, or none live, and leaves the criteria and scope to the lead", () => {
  const two = topicBrief("billing", ["lead-a", "lead-b"]);
  expect(two).toContain("\nOther teams: lead-a, lead-b (live in this project): agree contracts with them directly\n");
  expect(two).toContain("\nAcceptance criteria: set by the lead in its interview\nOut of scope: set by the lead in its interview\n");
  expect(two).not.toContain("ask the PM");
  expect(topicBrief("billing", [])).toContain("\nOther teams: none live\n");
});

test("withPonytail merges into a --settings=<json> and never adds a second --settings", () => {
  const out = withPonytail("backend-dev", ['--settings={"env":{"A":"1"}}', "--model", "x"]);
  expect(out.filter((f) => f.startsWith("--settings"))).toHaveLength(1);
  expect(out.slice(1)).toEqual(["--model", "x"]);
  expect(JSON.parse(out[0]!.slice("--settings=".length))).toEqual({ env: { PONYTAIL_DEFAULT_MODE: "full", A: "1" } });
  expect(withPonytail("backend-dev", ["--settings=/tmp/s.json"])).toEqual(["--settings=/tmp/s.json"]);
});

// The real `f1rm hire` waits for a slot up to 8 minutes; the processes these tests spawn give up at once (the wait itself is tested in process, below).
process.env.F1RM_SLOT_WAIT_MS = "0";

// Every test spawns real `f1rm hire` processes (up to eight in one test); on a loaded machine that passes 5 s.
setDefaultTimeout(30_000);

// Every temp folder this file makes goes in one list, removed once the file is done.
const made: string[] = [];
const tmp = (prefix: string) => (made.push(mkdtempSync(join(tmpdir(), prefix))), made[made.length - 1]);
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const CLI = join(import.meta.dir, "f1rm.ts");
const BRIEF = "Task: landing: build the page\nAcceptance criteria:\n- it renders";

type Session = { kind: string; state?: string; status?: unknown; name?: string; cwd?: string };
const bg = (state: string, name = "elsewhere-x", cwd = "/elsewhere"): Session => ({ kind: "background", state, name, cwd });

/** `claude agents --json` prints `sessions` (or fails when null); any other call records its argv (NUL-separated, so a multi-line prompt survives) and env. */
function stubClaude(sessions: Session[] | null) {
  const bin = tmp("f1rm-bin-");
  const log = join(bin, "argv.log");
  const envLog = join(bin, "env.log");
  const agents = join(bin, "agents.json");
  if (sessions) writeFileSync(agents, JSON.stringify(sessions));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = agents ]; then cat "${agents}" 2>/dev/null; exit $?; fi\nprintf '%s\\0' "$@" >> "${log}"\npwd -P >> "${bin}/cwd.log"\nenv | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)' >> "${envLog}"\necho "backgrounded · 7c5dcf5d"\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    cwd: () => (existsSync(join(bin, "cwd.log")) ? readFileSync(join(bin, "cwd.log"), "utf8").trim() : null),
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\0").slice(0, -1) : null),
    env: () => (existsSync(envLog) ? readFileSync(envLog, "utf8").split("\n").filter(Boolean) : []),
  };
}

function hire(stub: ReturnType<typeof stubClaude>, args: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", CLI, "hire", ...args], {
    cwd,
    env: { ...process.env, HOME: env.HOME ?? tmp("f1rm-home-"), PATH: `${stub.bin}:${process.env.PATH}`, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const pmArgs = ["--report-to", "pm-shop"];
// The statusLine runs the CLI by absolute path: a `claude --bg` session may have no `f1rm` on its PATH.
const TAP_OBJ = { type: "command", command: `'${process.execPath}' '${join(import.meta.dir, "f1rm.ts")}' usage-tap` };
const TAP = `"statusLine":${JSON.stringify(TAP_OBJ)}`;
const FULL = `{"env":{"PONYTAIL_DEFAULT_MODE":"full"},${TAP}}`;
/** The value of the one --settings flag in an argv, or null if there is none. */
const settingsOf = (argv: string[] | null) => {
  const at = argv?.indexOf("--settings") ?? -1;
  expect(argv?.lastIndexOf("--settings")).toBe(at);
  return at < 0 ? null : argv![at + 1];
};

/** The values of every --effort in an argv. */
const effortsOf = (argv: string[] | null) => argv!.filter((a, i) => argv![i - 1] === "--effort" || a.startsWith("--effort="));

test("a specialist hired from a subfolder is judged against the repo root: the team's lead running at the root counts, and a session working the task's worktree refuses a second", () => {
  const repos = longRepos();
  try {
    const repo = repos.repo(100);
    const sub = repos.inside(repo, 130);
    const args = ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF];
    const lead = bg("working", "lead-checkout", repo);
    const ok = hire(stubClaude([lead]), args, sub);
    expect([ok.code, ok.err]).toEqual([0, ""]);
    const taken = hire(stubClaude([lead, bg("done", "checkout.designer-landing", join(repo, ".claude", "worktrees", "landing"))]), args, sub);
    expect(taken.err).toContain('a session already works on task "landing": one specialist per task');
  } finally {
    repos.cleanup();
  }
});

test("f1rm hire checks the path length of the repo root, in a git repo only: a long subfolder of a short repo and a long plain folder hire, a long repo or a subfolder of one is refused with nothing started", () => {
  const repos = longRepos();
  try {
    const short = repos.repo(100), exact = repos.repo(150), long = repos.repo(151), plain = repos.repo(151, { git: false });
    const lead = (cwd: string) => {
      const stub = stubClaude([]);
      return { ...hire(stub, [...pmArgs, "designer", "designer-checkout", "checkout", BRIEF], cwd), started: stub.argv() !== null };
    };
    // A git repo at exactly 150 is accepted: the limit is on the root, not on the .git inside it. The expected lengths are literals.
    for (const [length, cwd] of [[100, short], [150, exact], [170, repos.inside(short, 170)], [151, plain]] as const) {
      const r = lead(cwd);
      expect([cwd.length, r.code, r.started]).toEqual([length, 0, true]);
    }
    for (const [length, cwd] of [[151, long], [170, repos.inside(long, 170)]] as const) {
      const r = lead(cwd);
      expect([cwd.length, r.code === 0, r.started]).toEqual([length, false, false]);
      expect(r.err).toContain("this repo's path is too long for f1rm status (Claude Code cuts the project folder name; the limit is 150 characters, so the `--claude-worktrees-` prefix of a worktree's folder stays whole)");
      // Not a counted refusal: the message stands alone, without the advice to leave the task todo.
      expect(r.err).not.toContain("Do not hire");
    }
  } finally {
    repos.cleanup();
  }
});

test("hire runs exactly claude --bg --agent --name --worktree with the slash command and report-to ahead of the brief", () => {
  const stub = stubClaude([]);
  const r = hire(stub, [...pmArgs, "designer", "designer-landing", "landing", BRIEF]);
  expect(r.code).toBe(0);
  expect(stub.argv()).toEqual([
    "--bg",
    "--agent",
    "f1rm:designer",
    "--name",
    "designer-landing",
    "--worktree",
    "landing",
    `/design-pipeline Report to: pm-shop\n\n${BRIEF}`,
    "--settings",
    FULL,
    "--effort",
    "high",
  ]);
  expect(r.out).toContain("backgrounded");
});

test("hire without --report-to reports to the PM session of the repo it runs in", () => {
  const stub = stubClaude([]);
  const repo = join(repoDir(), "shop");
  mkdirSync(repo);
  hire(stub, ["designer", "designer-api", "api", BRIEF], repo);
  expect(stub.argv()![7]).toStartWith("/design-pipeline Report to: pm-shop\n\n");
  expect(stub.argv()![7]).toEndWith(`\n\n${BRIEF}`);
});

test.each([
  ["researcher", "/mattpocock-skills:research"],
  ["advisor", "/mattpocock-skills:domain-modeling Before you start, load these with the Skill tool: mattpocock-skills:research."],
])("a %s brief starts with its slash commands: %s", (role, commands) => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, role, `${role}-x`, "x", BRIEF]);
  expect(stub.argv()!.find((a) => a.startsWith("/"))).toStartWith(`${commands} Report to: pm-shop\n\n`);
});

const prompt = (stub: ReturnType<typeof stubClaude>) => stub.argv()!.find((a) => a.startsWith("/"))!;

// architect and how carry disable-model-invocation, so the Skill tool refuses them: a lead gets one only as its first slash command.
// arena, swarm and interrogate carry disable-model-invocation too, and no hire is wired to run one as a first command: --skills refuses them, for every role.
// Every pstack skill but setup-pstack carries disable-model-invocation, so one rule refuses them: any pstack: skill other than poteto-mode, architect and how.
// A space after the comma is trimmed: the gate trims names, so a padded one in the list would hold the hire, and a padded architect would not be the first command.
// A leading slash is how a skill is typed as a command; the load list and the checks need the bare name.
// poteto-mode runs a dev's playbook flow: for any other role it would replace the role's own work.
// A dev's own first skill, pstack:poteto-mode, is slash-only too, so a second slash-only skill would push it into the Skill-tool list, which refuses it and holds the hire forever.
test("flags after the brief go to claude", () => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF, "--model", "haiku"]);
  expect(stub.argv()!.slice(8)).toEqual(["--settings", FULL, "--model", "haiku", "--effort", "high"]);
});

test("a usage file at 95% of the 5-hour window holds the real hire (code 75, the time it ends), 50% starts it, --override skips the hold", () => {
  const home = tmp("f1rm-home-");
  const usage = (pct: number) => (mkdirSync(join(home, ".f1rm"), { recursive: true }), writeFileSync(join(home, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: pct, resetsAt: Date.now() / 1000 + 3600 }, readAt: 0 })));
  usage(95);
  const held = hire(stubClaude([]), [...pmArgs, "designer", "designer-x", "x", BRIEF], process.cwd(), { HOME: home });
  expect(held.code).toBe(75);
  expect(held.err).toContain("usage hold: 5-hour usage is 95%");
  expect(held.err).toMatch(/new sessions wait until \d\d:\d\d/);
  expect(hire(stubClaude([]), ["--override", ...pmArgs, "designer", "designer-x", "x", BRIEF], process.cwd(), { HOME: home }).code).toBe(0);
  usage(50);
  expect(hire(stubClaude([]), [...pmArgs, "designer", "designer-x", "x", BRIEF], process.cwd(), { HOME: home }).code).toBe(0);
});

test("under a usage hold, hire waits for a slot, then gives up with code 75 and tells the session to ask nobody", () => {
  const home = tmp("f1rm-home-");
  mkdirSync(join(home, ".f1rm"), { recursive: true });
  writeFileSync(join(home, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: 95, resetsAt: Date.now() / 1000 + 3600 }, readAt: 0 }));
  const stub = stubClaude([]);
  const r = hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF], process.cwd(), { HOME: home });
  expect(r.code).toBe(75);
  expect(r.err).toContain("waiting for a slot: usage hold: 5-hour usage is 95%");
  expect(r.err).toContain("no slot yet: run the same command again. Ask nobody; it is not a decision for the user.");
  expect(r.err).not.toContain("--override");
  expect(r.err).not.toContain("asks the user");
  expect(stub.argv()).toBeNull();
});

test("9 working background sessions on the machine and hire still goes ahead: there is no machine cap", () => {
  const stub = stubClaude([...Array(8).fill(bg("working")), bg("blocked"), bg("done"), { kind: "interactive" }]);
  expect(hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]).code).toBe(0);
  expect(stub.argv()![2]).toBe("f1rm:designer");
});

test("hire does not hire when it cannot count the working hires", () => {
  const stub = stubClaude(null);
  const r = hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(r.code).not.toBe(0);
  expect(stub.argv()).toBeNull();
});

test("hire scrubs the Claude Code session variables it inherited", () => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF], process.cwd(), {
    CLAUDECODE: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDE_PID: "42",
  });
  expect(stub.env()).toEqual([]);
});

test.each([
  [["pm", "pm-x", "x", BRIEF], "f1rm pm"],
  [["janitor", "janitor-x", "x", BRIEF], 'unknown role "janitor"'],
  [["designer", "designer-x", "Landing Page", BRIEF], "lowercase words joined by hyphens"],
  [["designer", "designer-x", "x"], "usage: f1rm hire"],
])("hire %j is refused without starting anything", (args, message) => {
  const stub = stubClaude([]);
  const r = hire(stub, [...pmArgs, ...args]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain(message);
  expect(stub.argv()).toBeNull();
});

test("hire --help prints the syntax", () => {
  expect(hire(stubClaude([]), ["--help"]).out).toContain("usage: f1rm hire [--override]");
});

// Teams: the repo a lead runs in is the folder `f1rm hire` runs in.
const repoDir = () => realpathSync(tmp("f1rm-repo-"));
const worktree = (repo: string, task: string) => join(repo, ".claude", "worktrees", task);

test("a hire into a team is <team>.<role>-<task> in its own worktree and reports to the team's lead", () => {
  const repo = repoDir();
  const stub = stubClaude([bg("done", "lead-checkout", repo)]);
  expect(hire(stub, ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo).code).toBe(0);
  expect(stub.argv()!.slice(0, 7)).toEqual(["--bg", "--agent", "f1rm:designer", "--name", "checkout.designer-landing", "--worktree", "landing"]);
  expect(stub.argv()![7]).toBe(`/design-pipeline Report to: lead-checkout\n\n${BRIEF}`);
});

test.each([
  [["--team", "checkout", "designer", "designer-landing", "landing", BRIEF], 'name must be "checkout.designer-landing"'],
  [["--team", "search", "designer", "search.designer-landing", "landing", BRIEF], 'team "search" has no lead running in this repo'],
  [["--team", "blog", "designer", "blog.designer-landing", "landing", BRIEF], 'team "blog" has no lead running in this repo'],
])("hire %j is refused", (args, message) => {
  const repo = repoDir();
  const stub = stubClaude([bg("done", "lead-checkout", repo), bg("done", "lead-blog", "/code/blog")]);
  const r = hire(stub, args, repo);
  expect(r.err).toContain(message);
  expect(stub.argv()).toBeNull();
});

test("a team has no cap on working members: a third joins two busy or blocked ones, its Reviewer among them", () => {
  const repo = repoDir();
  const busy = [bg("done", "lead-checkout", repo), bg("working", "checkout.frontend-dev-form", worktree(repo, "form")), bg("blocked", "checkout.reviewer-review-api", worktree(repo, "review-api"))];
  const stub = stubClaude(busy);
  expect(hire(stub, ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo).code).toBe(0);
  expect(stub.argv()![4]).toBe("checkout.designer-landing");
});

test("one specialist per task: a task a live session works in is refused, even with --override", () => {
  const repo = repoDir();
  const taken = [bg("done", "designer-landing", worktree(repo, "landing"))];
  for (const flags of [[], ["--override"]]) {
    const stub = stubClaude(taken);
    const r = hire(stub, [...flags, ...pmArgs, "researcher", "researcher-landing", "landing", BRIEF], repo);
    expect(r.err).toContain('a session already works on task "landing": one specialist per task');
    expect(stub.argv()).toBeNull();
  }
  expect(hire(stubClaude(taken), [...pmArgs, "researcher", "researcher-landing", "landing", BRIEF], repoDir()).code).toBe(0);
});

test("a founder role is refused in a Work project, or one with no edition, and hired in a Founder project", async () => {
  const { projectFile, writeEdition } = await import("../server/editions.ts");
  const home = realpathSync(tmp("f1rm-home-")), repo = repoDir();
  const marketer = [...pmArgs, "marketer", "marketer-launch", "launch", BRIEF];
  const unset = stubClaude([]);
  const r = hire(unset, marketer, repo, { HOME: home });
  expect(r.err).toContain("marketer is a Founder role and this is a Work project");
  expect(unset.argv()).toBeNull();
  writeEdition(projectFile(join(home, ".f1rm", "projects"), repo), "founder");
  const founder = stubClaude([]);
  expect(hire(founder, marketer, repo, { HOME: home }).code).toBe(0);
  expect(founder.argv()!.slice(0, 7)).toEqual(["--bg", "--agent", "f1rm:marketer", "--name", "marketer-launch", "--worktree", "launch"]);
  expect(founder.argv()![7]).toStartWith("/cro Before you start, load these with the Skill tool: anthropic-skills:content-creator, brandkit. Report to: pm-shop");
  writeEdition(projectFile(join(home, ".f1rm", "projects"), repo), "work");
  expect(hire(stubClaude([]), marketer, repo, { HOME: home }).err).toContain("Founder role");
});

test("a hire into a paused project is refused with a pointer to resume, and starts nothing; once resumed it hires", () => {
  const repos = longRepos();
  try {
    const repo = realpathSync(repos.repo(100));
    const home = tmp("f1rm-home-");
    const flag = join(home, ".f1rm", "paused", `${repo.replace(/[^A-Za-z0-9]/g, "-")}.json`);
    mkdirSync(join(home, ".f1rm", "paused"), { recursive: true });
    writeFileSync(flag, JSON.stringify({ by: "manual", at: 1, why: "lunch" }));
    const stub = stubClaude([]);
    const refused = hire(stub, [...pmArgs, "designer", "designer-checkout", "checkout", BRIEF], repo, { HOME: home });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("is paused (manual: lunch)");
    expect(refused.err).toContain("`f1rm resume`");
    expect(stub.argv()).toBeNull();
    rmSync(flag);
    expect(hire(stub, [...pmArgs, "designer", "designer-checkout", "checkout", BRIEF], repo, { HOME: home }).code).toBe(0);
    expect(stub.argv()).not.toBeNull();
  } finally {
    repos.cleanup();
  }
});

/** A fake clock for the wait: each sleep moves it on, and `onSleep` gets the count of sleeps so far (a test frees a slot there). */
function clock(onSleep: (n: number) => void = () => {}) {
  let t = 0, n = 0;
  const said: string[] = [];
  const wait: Wait = { sleep: async (ms) => { t += ms; onSleep(++n); }, now: () => t, total: 8 * 60_000, say: (line) => said.push(line) };
  return { wait, said, sleeps: () => n };
}

/** A HOME whose usage file holds the 5-hour window at `pct`; `set` rewrites it (a test lowers it to lift the hold). */
function usageHome(pct: number) {
  const home = tmp("f1rm-home-");
  mkdirSync(join(home, ".f1rm"), { recursive: true });
  const set = (p: number) => writeFileSync(join(home, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: p, resetsAt: Date.now() / 1000 + 3600 }, readAt: 0 }));
  set(pct);
  return { home, set };
}

/** `f1rm hire` run in this process (so its waiting is injected), in `cwd`, against the stub `claude`. */
async function inProcess(stub: ReturnType<typeof stubClaude>, words: string[], wait: Wait, cwd = repoDir(), home = tmp("f1rm-home-")) {
  const saved = { path: process.env.PATH, home: process.env.HOME, cwd: process.cwd() };
  process.env.PATH = `${stub.bin}:${saved.path}`;
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    return await hireCommand(words, wait);
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
    process.env.HOME = saved.home;
  }
}

test("a hire refused by the usage hold polls, prints one waiting line, and hires as soon as the hold lifts", async () => {
  const stub = stubClaude([]);
  const u = usageHome(95);
  const c = clock((n) => n === 2 && u.set(50));
  expect(await inProcess(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF], c.wait, repoDir(), u.home)).toBe(0);
  expect(c.sleeps()).toBe(2);
  expect(c.said).toHaveLength(1);
  expect(c.said[0]).toStartWith("waiting for a slot: usage hold: 5-hour usage is 95%");
  expect(stub.argv()![2]).toBe("f1rm:designer");
});

test("a hire that never gets a slot waits 8 minutes, says so at most once a minute, then exits 75 and starts nothing", async () => {
  const stub = stubClaude([]);
  const c = clock();
  expect(await inProcess(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF], c.wait, repoDir(), usageHome(95).home)).toBe(75);
  expect(c.sleeps()).toBe(24);
  expect(c.said.filter((l) => l.startsWith("waiting for a slot: ")).length).toBe(9);
  expect(c.said.at(-1)).toBe(NO_SLOT);
  expect(stub.argv()).toBeNull();
});

test("F1RM_SLOT_WAIT_MS that is not a number falls back to the 8 minutes, and 0 stays an accepted value", async () => {
  const saved = process.env.F1RM_SLOT_WAIT_MS;
  try {
    process.env.F1RM_SLOT_WAIT_MS = "abc";
    const stub = stubClaude([]);
    const c = clock();
    expect(await inProcess(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF], { ...c.wait, total: realWait().total }, repoDir(), usageHome(95).home)).toBe(75);
    expect(c.sleeps()).toBe(24);
    process.env.F1RM_SLOT_WAIT_MS = "0";
    expect(realWait().total).toBe(0);
  } finally {
    process.env.F1RM_SLOT_WAIT_MS = saved;
  }
});

test("a refusal that is no usage wait is immediate, with 9 sessions working", async () => {
  const repo = repoDir();
  // One specialist per task, a role not allowed, a name that does not fit: they throw at once and never sleep.
  for (const [words, why] of [
    [["researcher", "researcher-landing", "landing", BRIEF], "one specialist per task"],
    [["janitor", "janitor-x", "x", BRIEF], 'unknown role "janitor"'],
  ] as const) {
    const c = clock();
    const crowd = [...Array(9).fill(bg("working")), bg("done", "designer-landing", worktree(repo, "landing"))];
    await expect(inProcess(stubClaude(crowd), [...pmArgs, ...words], c.wait, repo)).rejects.toThrow(why);
    expect([why, c.sleeps(), c.said]).toEqual([why, 0, []]);
  }
});
