// Seam 2: the real `f1rm hire`, run against a stub `claude` first on PATH.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longRepos } from "./long-repo.test-helper.ts";

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
const FULL = '{"env":{"PONYTAIL_DEFAULT_MODE":"full"}}';
/** The value of the one --settings flag in an argv, or null if there is none. */
const settingsOf = (argv: string[] | null) => {
  const at = argv?.indexOf("--settings") ?? -1;
  expect(argv?.lastIndexOf("--settings")).toBe(at);
  return at < 0 ? null : argv![at + 1];
};

test("every hire but a lead is started at ponytail full by its own --settings, which a lead's start does not carry", () => {
  for (const [role, task] of [["backend-dev", "x"], ["frontend-dev", "x"], ["designer", "x"], ["researcher", "x"], ["reviewer", "review-x"]]) {
    const stub = stubClaude([]);
    expect([role, hire(stub, [...pmArgs, role, `${role}-${task}`, task, BRIEF]).code]).toEqual([role, 0]);
    expect([role, settingsOf(stub.argv())]).toEqual([role, FULL]);
  }
  const lead = stubClaude([]);
  expect(hire(lead, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF]).code).toBe(0);
  expect(settingsOf(lead.argv())).toBeNull();
});

test("a reviewer's --settings stays ahead of --disallowedTools, which would swallow it, and a --settings the caller passes gets the level merged in", () => {
  const rv = stubClaude([]);
  hire(rv, [...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(rv.argv()!.indexOf("--settings")).toBeLessThan(rv.argv()!.indexOf("--disallowedTools"));
  const own = stubClaude([]);
  expect(hire(own, [...pmArgs, "designer", "designer-x", "x", BRIEF, "--settings", '{"disableAllHooks":true,"env":{"A":"1"}}']).code).toBe(0);
  expect(JSON.parse(settingsOf(own.argv())!)).toEqual({ disableAllHooks: true, env: { A: "1", PONYTAIL_DEFAULT_MODE: "full" } });
  const set = stubClaude([]);
  hire(set, [...pmArgs, "designer", "designer-y", "y", BRIEF, "--settings", '{"env":{"PONYTAIL_DEFAULT_MODE":"lite"}}']);
  expect(JSON.parse(settingsOf(set.argv())!)).toEqual({ env: { PONYTAIL_DEFAULT_MODE: "lite" } });
});

test("a lead hired from a subfolder of the repo is started in the repo root, which is where status looks for it; outside git it is started where the command ran", () => {
  const repos = longRepos();
  try {
    const repo = repos.repo(100), plain = repos.repo(100, { git: false });
    const sub = repos.inside(repo, 130);
    for (const [from, started] of [[repo, repo], [sub, repo], [plain, plain]]) {
      const stub = stubClaude([]);
      expect([from.length, hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], from).code]).toEqual([from.length, 0]);
      expect(stub.cwd()).toBe(started);
    }
  } finally {
    repos.cleanup();
  }
});

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
      return { ...hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], cwd), started: stub.argv() !== null };
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
      // Not a cap refusal: the message stands alone, without the advice to leave the task todo.
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
  ]);
  expect(r.out).toContain("backgrounded");
});

test("hire without --report-to reports to the PM session of the repo it runs in", () => {
  const stub = stubClaude([]);
  const repo = join(repoDir(), "shop");
  mkdirSync(repo);
  hire(stub, ["backend-dev", "backend-dev-api", "api", BRIEF], repo);
  expect(stub.argv()![7]).toBe(`/pstack:poteto-mode Before you start, load these with the Skill tool: mattpocock-skills:tdd. Report to: pm-shop\n\n${BRIEF}`);
});

test.each([
  ["frontend-dev", "/pstack:poteto-mode Before you start, load these with the Skill tool: mattpocock-skills:tdd."],
  ["backend-dev", "/pstack:poteto-mode Before you start, load these with the Skill tool: mattpocock-skills:tdd."],
  ["researcher", "/mattpocock-skills:research"],
  ["reviewer", "/code-review medium worktree-x Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, ponytail:ponytail-review, mattpocock-skills:code-review."],
])("a %s brief starts with its slash commands: %s", (role, commands) => {
  const stub = stubClaude([]);
  const task = role === "reviewer" ? "review-x" : "x";
  hire(stub, [...pmArgs, role, `${role}-${task}`, task, BRIEF]);
  expect(stub.argv()!.find((a) => a.startsWith("/"))).toStartWith(`${commands} Report to: pm-shop\n\n`);
});

const prompt = (stub: ReturnType<typeof stubClaude>) => stub.argv()!.find((a) => a.startsWith("/"))!;

test("--skills adds to the list; a slash-only skill becomes the first command and the role's own first skill moves into the list", () => {
  const dev = stubClaude([]);
  hire(dev, ["--skills", "ponytail:ponytail,vercel:nextjs", ...pmArgs, "frontend-dev", "frontend-dev-x", "x", BRIEF]);
  expect(prompt(dev)).toStartWith("/pstack:poteto-mode Before you start, load these with the Skill tool: ponytail:ponytail, vercel:nextjs, mattpocock-skills:tdd. Report to: pm-shop\n\n");
  const researcher = stubClaude([]);
  hire(researcher, ["--skills", "research,seo-audit", ...pmArgs, "researcher", "researcher-x", "x", BRIEF]);
  expect(prompt(researcher)).toStartWith("/research Before you start, load these with the Skill tool: seo-audit, mattpocock-skills:research. Report to: pm-shop\n\n");
  // security-review reads the git state where it runs, so it never runs at the start: --level high puts it after the merge.
  const reviewer = stubClaude([]);
  expect(hire(reviewer, ["--skills", "security-review", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]).err).toContain("--level high");
  expect(reviewer.argv()).toBeNull();
});

test("a backend bug loads diagnosing-bugs before tdd: --skills mattpocock-skills:diagnosing-bugs goes ahead of the role's own later skills", () => {
  const bug = stubClaude([]);
  hire(bug, ["--skills", "mattpocock-skills:diagnosing-bugs", ...pmArgs, "backend-dev", "backend-dev-x", "x", BRIEF]);
  expect(prompt(bug)).toStartWith("/pstack:poteto-mode Before you start, load these with the Skill tool: mattpocock-skills:diagnosing-bugs, mattpocock-skills:tdd. Report to: pm-shop\n\n");
  const stack = stubClaude([]);
  hire(stack, ["--skills", "ponytail:ponytail,mattpocock-skills:diagnosing-bugs", ...pmArgs, "backend-dev", "backend-dev-y", "y", BRIEF]);
  expect(prompt(stack)).toStartWith("/pstack:poteto-mode Before you start, load these with the Skill tool: ponytail:ponytail, mattpocock-skills:diagnosing-bugs, mattpocock-skills:tdd.");
});

// architect and how carry disable-model-invocation, so the Skill tool refuses them: a lead gets one only as its first slash command.
test.each(["pstack:architect", "pstack:how"])("a lead hired with --skills %s gets it as the first slash command and still loads the guidelines and f1rm:hire with the Skill tool", (skill) => {
  const stub = stubClaude([]);
  expect(hire(stub, ["--skills", skill, ...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir()).code).toBe(0);
  expect(prompt(stub)).toBe(`/${skill} Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, f1rm:hire. Report to: pm-shop\n\n${BRIEF}`);
});

test("what hire adds to a brief is the Report to line alone: no PLAN, no GO, and no PM round trip before the lead hires", () => {
  const stub = stubClaude([]);
  expect(hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir()).code).toBe(0);
  const text = prompt(stub);
  expect(text).toEndWith(`Report to: pm-shop\n\n${BRIEF}`);
  expect(text).not.toMatch(/\bPLAN\b|\bGO\b|NEEDS YOU/);
});

// arena, swarm and interrogate carry disable-model-invocation too, and no hire is wired to run one as a first command: --skills refuses them, for every role.
test.each(["pstack:arena", "pstack:swarm", "pstack:interrogate"])("--skills %s is refused with nothing started: the Skill tool refuses it and the user can run it by hand", (skill) => {
  for (const [role, task] of [["lead", "checkout"], ["backend-dev", "x"], ["reviewer", "review-x"]]) {
    const stub = stubClaude([]);
    const r = hire(stub, ["--skills", skill, ...pmArgs, role, role === "lead" ? `lead-${task}` : `${role}-${task}`, task, BRIEF], repoDir());
    expect(r.code, `${role} ${skill}`).not.toBe(0);
    expect(r.err, `${role} ${skill}`).toContain(`${skill} is not wired inside hires; the user can run it by hand`);
    expect(stub.argv(), `${role} ${skill}`).toBeNull();
  }
});

// Every pstack skill but setup-pstack carries disable-model-invocation, so one rule refuses them: any pstack: skill other than poteto-mode, architect and how.
test.each(["pstack:typescript-best-practices", "pstack:tdd"])("--skills %s is refused for a dev, a lead and a code Reviewer, with nothing started", (skill) => {
  for (const [role, task] of [["backend-dev", "x"], ["lead", "checkout"], ["reviewer", "review-x"]]) {
    const stub = stubClaude([]);
    const r = hire(stub, ["--skills", skill, ...pmArgs, role, role === "lead" ? `lead-${task}` : `${role}-${task}`, task, BRIEF], repoDir());
    // setup-pstack is the one pstack skill the Skill tool loads, so the message does not say it refuses the skill.
    expect(r.err, `${role} ${skill}`).toContain(`${skill} is not wired inside hires; the user can run it by hand`);
    expect(r.err, `${role} ${skill}`).not.toContain("the Skill tool refuses it");
    expect(stub.argv(), `${role} ${skill}`).toBeNull();
  }
});

// A space after the comma is trimmed: the gate trims names, so a padded one in the list would hold the hire, and a padded architect would not be the first command.
test("--skills a, b is split and trimmed: a spaced pstack:tdd is refused and a spaced pstack:architect is the lead's first command", () => {
  const dev = stubClaude([]);
  const r = hire(dev, ["--skills", "mattpocock-skills:diagnosing-bugs, pstack:tdd", ...pmArgs, "backend-dev", "backend-dev-x", "x", BRIEF], repoDir());
  expect(r.err).toContain("pstack:tdd is not wired inside hires");
  expect(dev.argv()).toBeNull();
  const lead = stubClaude([]);
  hire(lead, ["--skills", "ponytail:ponytail, pstack:architect", ...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir());
  expect(prompt(lead)).toStartWith("/pstack:architect Before you start, load these with the Skill tool: ponytail:ponytail, f1rm:f1rm-guidelines, f1rm:hire. ");
});

// A leading slash is how a skill is typed as a command; the load list and the checks need the bare name.
test("--skills /name is the bare name: /pstack:tdd is refused on a dev, and /research on a researcher is the first command", () => {
  const dev = stubClaude([]);
  const r = hire(dev, ["--skills", "/pstack:tdd", ...pmArgs, "backend-dev", "backend-dev-x", "x", BRIEF], repoDir());
  expect(r.err).toContain("pstack:tdd is not wired inside hires");
  expect(dev.argv()).toBeNull();
  const researcher = stubClaude([]);
  hire(researcher, ["--skills", "/research", ...pmArgs, "researcher", "researcher-x", "x", BRIEF], repoDir());
  expect(prompt(researcher)).toStartWith("/research Before you start, load these with the Skill tool: mattpocock-skills:research. ");
});

test("a slash-only --skills named twice, or the dev's own poteto-mode, counts once", () => {
  const dev = stubClaude([]);
  expect(hire(dev, ["--skills", "pstack:poteto-mode", ...pmArgs, "backend-dev", "backend-dev-x", "x", BRIEF]).code).toBe(0);
  expect(prompt(dev)).toStartWith("/pstack:poteto-mode Before you start, load these with the Skill tool: mattpocock-skills:tdd. ");
  const twice = stubClaude([]);
  expect(hire(twice, ["--skills", "research,research", ...pmArgs, "researcher", "researcher-x", "x", BRIEF]).code).toBe(0);
  expect(prompt(twice)).toStartWith("/research Before you start, load these with the Skill tool: mattpocock-skills:research. ");
});

// A code Reviewer's first command is /code-review <level> worktree-<task>: a slash-only skill would take its place.
test.each(["research", "pstack:poteto-mode"])("a code Reviewer is refused --skills %s, and a content Reviewer takes it as its first command", (skill) => {
  const code = stubClaude([]);
  const r = hire(code, ["--skills", skill, ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(r.err).toContain(`${skill} is slash-only`);
  expect(r.err).toContain("a code Reviewer's first command is /code-review");
  expect(code.argv()).toBeNull();
});

test("a content Reviewer takes --skills research as its first command", () => {
  const content = stubClaude([]);
  hire(content, ["--content", "--skills", "research", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(prompt(content)).toStartWith("/research Before you start, load these with the Skill tool: f1rm:f1rm-guidelines. ");
});

// poteto-mode runs a dev's playbook flow: for any other role it would replace the role's own work.
test("--skills pstack:poteto-mode is for the two devs only: a researcher, a designer, a lead and a content Reviewer are refused", () => {
  for (const [role, task, extra] of [["researcher", "x", []], ["designer", "x", []], ["lead", "checkout", []], ["reviewer", "review-x", ["--content"]]] as const) {
    const stub = stubClaude([]);
    const r = hire(stub, [...extra, "--skills", "pstack:poteto-mode", ...pmArgs, role, role === "lead" ? `lead-${task}` : `${role}-${task}`, task, BRIEF], repoDir());
    expect(r.err, role).toContain("pstack:poteto-mode is for the two devs only");
    expect(stub.argv(), role).toBeNull();
  }
});

// A dev's own first skill, pstack:poteto-mode, is slash-only too, so a second slash-only skill would push it into the Skill-tool list, which refuses it and holds the hire forever.
test.each(["frontend-dev", "backend-dev"])("a %s is refused a slash-only --skills (research, architect, how): its own first command is pstack:poteto-mode", (role) => {
  for (const skill of ["research", "pstack:architect", "pstack:how"]) {
    const stub = stubClaude([]);
    const r = hire(stub, ["--skills", skill, ...pmArgs, role, `${role}-x`, "x", BRIEF]);
    expect(r.code, skill).not.toBe(0);
    expect(r.err, skill).toMatch(skill === "research" ? new RegExp(`research is slash-only, and a ${role}'s first command is pstack:poteto-mode: drop it`) :/for a lead only/);
    expect(stub.argv(), skill).toBeNull();
  }
});

test("pstack:architect and pstack:how are for a lead only: every other role is refused, a lead takes one, and two slash-only skills are refused", () => {
  for (const role of ["designer", "researcher", "reviewer"]) {
    const stub = stubClaude([]);
    const task = role === "reviewer" ? "review-x" : "x";
    expect(hire(stub, ["--skills", "pstack:architect", ...pmArgs, role, `${role}-${task}`, task, BRIEF]).err, role).toContain("for a lead only");
    expect(stub.argv(), role).toBeNull();
  }
  const lead = stubClaude([]);
  const r = hire(lead, ["--skills", "pstack:architect,research", ...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir());
  expect(r.err).toContain("pstack:architect and research are slash-only");
  expect(lead.argv()).toBeNull();
  const research = stubClaude([]);
  hire(research, ["--skills", "research", ...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir());
  expect(prompt(research)).toStartWith("/research Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, f1rm:hire. ");
});

test("--level sets the reviewer's /code-review level, and high runs security-review on the merge before APPROVED; other roles refuse it", () => {
  const high = stubClaude([]);
  hire(high, ["--level", "high", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(prompt(high)).toStartWith(
    "/code-review high worktree-x Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, ponytail:ponytail-review, mattpocock-skills:code-review. Before you send APPROVED, run security-review with the Skill tool from the scratch worktree, with <base>...<merge sha> as its args. Report to: pm-shop",
  );
  const low = stubClaude([]);
  hire(low, ["--level", "low", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(prompt(low)).toStartWith("/code-review low worktree-x Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, ponytail:ponytail-review, mattpocock-skills:code-review. ");
  const bad = stubClaude([]);
  expect(hire(bad, ["--level", "max", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]).err).toContain("level");
  expect(hire(bad, ["--level", "high", ...pmArgs, "designer", "designer-x", "x", BRIEF]).err).toContain("reviewer only");
  expect(bad.argv()).toBeNull();
});

test("--content starts a reviewer with the guidelines, sonnet, no code-review skills and the content line; other roles refuse it", () => {
  const stub = stubClaude([]);
  hire(stub, ["--content", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(prompt(stub)).toBe(`/f1rm:f1rm-guidelines Report to: pm-shop\n\nThis branch holds no code: use the content checklist.\n${BRIEF}`);
  expect(stub.argv()!.slice(-4)).toEqual(["--model", "sonnet", "--disallowedTools", "Bash(git push *)"]);
  const opus = stubClaude([]);
  hire(opus, ["--content", ...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF, "--model", "opus"]);
  expect(opus.argv()!.filter((a) => a === "--model" || a === "sonnet" || a === "opus")).toEqual(["--model", "opus"]);
  const other = stubClaude([]);
  expect(hire(other, ["--content", ...pmArgs, "designer", "designer-x", "x", BRIEF]).err).toContain("reviewer only");
  expect(other.argv()).toBeNull();
});

test("a reviewer's task must be review-<task>, and its /code-review targets the branch under review", () => {
  const bad = stubClaude([]);
  const r = hire(bad, [...pmArgs, "reviewer", "reviewer-api", "api", BRIEF]);
  expect(r.err).toContain("a Reviewer's task is review-<task>");
  expect(bad.argv()).toBeNull();
  const content = stubClaude([]);
  expect(hire(content, ["--content", ...pmArgs, "reviewer", "reviewer-api", "api", BRIEF]).err).toContain("a Reviewer's task is review-<task>");
  const targeted = stubClaude([]);
  hire(targeted, [...pmArgs, "reviewer", "reviewer-review-checkout-form", "review-checkout-form", BRIEF]);
  expect(prompt(targeted)).toStartWith("/code-review medium worktree-checkout-form Before you start");
});

test("a reviewer starts with no --worktree, so it runs in the main checkout; every other specialist still gets one", () => {
  const reviewer = stubClaude([]);
  hire(reviewer, [...pmArgs, "reviewer", "reviewer-review-api", "review-api", BRIEF]);
  expect(reviewer.argv()!.slice(0, 5)).toEqual(["--bg", "--agent", "f1rm:reviewer", "--name", "reviewer-review-api"]);
  expect(reviewer.argv()).not.toContain("--worktree");
  for (const role of ["designer", "frontend-dev", "backend-dev", "researcher"]) {
    const stub = stubClaude([]);
    hire(stub, [...pmArgs, role, `${role}-x`, "x", BRIEF]);
    expect(stub.argv()!.slice(4, 7)).toEqual([`${role}-x`, "--worktree", "x"]);
  }
});

test("only a reviewer hire carries the no-push deny rule, after the prompt so it cannot swallow it", () => {
  const reviewer = stubClaude([]);
  hire(reviewer, [...pmArgs, "reviewer", "reviewer-review-x", "review-x", BRIEF]);
  expect(reviewer.argv()!.slice(6)).toEqual(["--settings", FULL, "--disallowedTools", "Bash(git push *)"]);
  const designer = stubClaude([]);
  hire(designer, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(designer.argv()).not.toContain("--disallowedTools");
});

test("flags after the brief go to claude", () => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF, "--model", "haiku"]);
  expect(stub.argv()!.slice(8)).toEqual(["--settings", FULL, "--model", "haiku"]);
});

test("at 8 working background sessions, hire refuses with a non-zero exit and tells the lead to ask the user in its own session", () => {
  const stub = stubClaude([...Array(7).fill(bg("working")), bg("blocked")]);
  const r = hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("8 hires are already working (the cap is 8)");
  expect(r.err).toContain("Tell the session you report to. The lead asks the user in its own session (the PM, for a hire of its own), and only after the user approves this hire in that conversation is it rerun with --override.");
  expect(r.err).not.toContain("Only the PM asks the user");
  expect(r.err).not.toContain("Tell the user");
  expect(stub.argv()).toBeNull();
});

test("below the cap hire goes ahead: finished hires and interactive sessions do not count", () => {
  const stub = stubClaude([
    ...Array(7).fill(bg("working")),
    bg("done"),
    bg("stopped"),
    bg("failed"),
    { kind: "interactive" },
  ]);
  expect(hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]).code).toBe(0);
  expect(stub.argv()).not.toBeNull();
});

test("--override hires past the cap", () => {
  const stub = stubClaude(Array(8).fill(bg("working")));
  const r = hire(stub, ["--override", ...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(r.code).toBe(0);
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

test("a lead runs as lead-<team> in the repo, with no worktree, starting with the guidelines and reporting to the PM", () => {
  const stub = stubClaude([]);
  const r = hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repoDir());
  expect(r.code).toBe(0);
  expect(stub.argv()).toEqual([
    "--bg", "--agent", "f1rm:lead", "--name", "lead-checkout",
    `/f1rm:f1rm-guidelines Before you start, load these with the Skill tool: f1rm:hire. Report to: pm-shop\n\n${BRIEF}`,
  ]);
});

test("a hire into a team is <team>.<role>-<task> in its own worktree and reports to the team's lead", () => {
  const repo = repoDir();
  const stub = stubClaude([bg("done", "lead-checkout", repo)]);
  expect(hire(stub, ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo).code).toBe(0);
  expect(stub.argv()!.slice(0, 7)).toEqual(["--bg", "--agent", "f1rm:designer", "--name", "checkout.designer-landing", "--worktree", "landing"]);
  expect(stub.argv()![7]).toBe(`/design-pipeline Report to: lead-checkout\n\n${BRIEF}`);
});

test.each([
  [["lead", "lead-x", "checkout", BRIEF], 'name must be "lead-checkout"'],
  [["--team", "checkout", "designer", "designer-landing", "landing", BRIEF], 'name must be "checkout.designer-landing"'],
  [["--team", "search", "designer", "search.designer-landing", "landing", BRIEF], 'team "search" has no lead running in this repo'],
  [["--team", "blog", "designer", "blog.designer-landing", "landing", BRIEF], 'team "blog" has no lead running in this repo'],
  [["--team", "checkout", "lead", "lead-checkout", "checkout", BRIEF], "only the PM hires leads"],
])("hire %j is refused", (args, message) => {
  const repo = repoDir();
  const stub = stubClaude([bg("done", "lead-checkout", repo), bg("done", "lead-blog", "/code/blog")]);
  const r = hire(stub, args, repo);
  expect(r.err).toContain(message);
  expect(stub.argv()).toBeNull();
});

test("a project runs at most 2 teams: a third lead is refused, leads elsewhere do not count, and --override passes", () => {
  const repo = repoDir();
  const two = [bg("done", "lead-checkout", repo), bg("working", "lead-search", repo), bg("working", "lead-blog", "/code/blog")];
  const r = hire(stubClaude(two), [...pmArgs, "lead", "lead-cart", "cart", BRIEF], repo);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("this project already has 2 teams (the cap is 2)");
  expect(hire(stubClaude(two.slice(1)), [...pmArgs, "lead", "lead-cart", "cart", BRIEF], repo).code).toBe(0);
  expect(hire(stubClaude(two), ["--override", ...pmArgs, "lead", "lead-cart", "cart", BRIEF], repo).code).toBe(0);
});

test("a team works at most 2 at once, its Reviewer included; finished members free their slot", () => {
  const repo = repoDir();
  const lead = bg("done", "lead-checkout", repo);
  const busy = [lead, bg("working", "checkout.frontend-dev-form", worktree(repo, "form")), bg("blocked", "checkout.reviewer-review-api", worktree(repo, "review-api"))];
  const r = hire(stubClaude(busy), ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo);
  expect(r.err).toContain("team checkout already has 2 working (the cap is 2 per team)");
  const freed = [lead, bg("working", "checkout.frontend-dev-form", worktree(repo, "form")), bg("done", "checkout.backend-dev-api", worktree(repo, "api"))];
  expect(hire(stubClaude(freed), ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo).code).toBe(0);
  expect(hire(stubClaude(busy), ["--override", "--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF], repo).code).toBe(0);
});

test("an idle member frees its team slot though its state still says working; busy, blocked and unreadable status still count", () => {
  const repo = repoDir();
  const lead = bg("done", "lead-checkout", repo);
  const at = (state: string, name: string, task: string, status?: unknown): Session => ({ ...bg(state, `checkout.${name}`, worktree(repo, task)), status });
  const designer = ["--team", "checkout", "designer", "checkout.designer-landing", "landing", BRIEF];
  const form = at("working", "frontend-dev-form", "form", "busy");
  // Two devs sent DONE and went idle: Claude Code keeps their state "working", their status says idle.
  const idle = [lead, at("working", "backend-dev-api", "api", "idle"), at("working", "backend-dev-cart", "cart", "idle")];
  expect(hire(stubClaude(idle), designer, repo).code).toBe(0);
  expect(hire(stubClaude([...idle, form]), designer, repo).code).toBe(0);
  // A busy member, a blocked one (no status) and one whose status is unreadable all count as working.
  for (const other of [at("working", "backend-dev-api", "api", "busy"), at("blocked", "backend-dev-api", "api"), at("blocked", "backend-dev-api", "api", "idle"), at("working", "backend-dev-api", "api"), at("working", "backend-dev-api", "api", 7), at("working", "backend-dev-api", "api", "IDLE")]) {
    const r = hire(stubClaude([lead, form, other]), designer, repo);
    expect(r.err).toContain("team checkout already has 2 working (the cap is 2 per team)");
  }
});

test("an idle member frees its slot in the team cap only: the machine cap still counts it", () => {
  const stub = stubClaude([...Array(8).fill({ ...bg("working"), status: "idle" })]);
  const r = hire(stub, [...pmArgs, "frontend-dev", "frontend-dev-landing", "landing", BRIEF]);
  expect(r.err).toContain("8 hires are already working (the cap is 8)");
});

test("one specialist per task: a task a live session works in is refused, even with --override", () => {
  const repo = repoDir();
  const taken = [bg("done", "designer-landing", worktree(repo, "landing"))];
  for (const flags of [[], ["--override"]]) {
    const stub = stubClaude(taken);
    const r = hire(stub, [...flags, ...pmArgs, "frontend-dev", "frontend-dev-landing", "landing", BRIEF], repo);
    expect(r.err).toContain('a session already works on task "landing": one specialist per task');
    expect(stub.argv()).toBeNull();
  }
  expect(hire(stubClaude(taken), [...pmArgs, "frontend-dev", "frontend-dev-landing", "landing", BRIEF], repoDir()).code).toBe(0);
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

test("one Reviewer per task: a second live session with the reviewer's name is refused, even with --override", () => {
  const repo = repoDir();
  const live = [bg("done", "reviewer-review-api", repo)];
  for (const flags of [[], ["--override"]]) {
    const stub = stubClaude(live);
    const r = hire(stub, [...flags, ...pmArgs, "reviewer", "reviewer-review-api", "review-api", BRIEF], repo);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('a session named "reviewer-review-api" is already running');
    expect(stub.argv()).toBeNull();
  }
  expect(hire(stubClaude(live), [...pmArgs, "reviewer", "reviewer-review-form", "review-form", BRIEF], repo).code).toBe(0);
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
    const refused = hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repo, { HOME: home });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("is paused (manual: lunch)");
    expect(refused.err).toContain("`f1rm resume`");
    expect(stub.argv()).toBeNull();
    rmSync(flag);
    expect(hire(stub, [...pmArgs, "lead", "lead-checkout", "checkout", BRIEF], repo, { HOME: home }).code).toBe(0);
    expect(stub.argv()).not.toBeNull();
  } finally {
    repos.cleanup();
  }
});
