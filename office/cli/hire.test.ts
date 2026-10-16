// Seam 2: the real `f1rm hire`, run against a stub `claude` first on PATH.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "f1rm.ts");
const BRIEF = "Task: landing: build the page\nAcceptance criteria:\n- it renders";

type Session = { kind: string; state?: string; name?: string; cwd?: string };
const bg = (state: string, name = "elsewhere-x", cwd = "/elsewhere"): Session => ({ kind: "background", state, name, cwd });

/** `claude agents --json` prints `sessions` (or fails when null); any other call records its argv (NUL-separated, so a multi-line prompt survives) and env. */
function stubClaude(sessions: Session[] | null) {
  const bin = mkdtempSync(join(tmpdir(), "f1rm-bin-"));
  const log = join(bin, "argv.log");
  const envLog = join(bin, "env.log");
  const agents = join(bin, "agents.json");
  if (sessions) writeFileSync(agents, JSON.stringify(sessions));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = agents ]; then cat "${agents}" 2>/dev/null; exit $?; fi\nprintf '%s\\0' "$@" >> "${log}"\nenv | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)' >> "${envLog}"\necho "backgrounded · 7c5dcf5d"\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\0").slice(0, -1) : null),
    env: () => (existsSync(envLog) ? readFileSync(envLog, "utf8").split("\n").filter(Boolean) : []),
  };
}

function hire(stub: ReturnType<typeof stubClaude>, args: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", CLI, "hire", ...args], {
    cwd,
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "f1rm-home-")), PATH: `${stub.bin}:${process.env.PATH}`, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const pmArgs = ["--report-to", "pm-shop"];

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
  ]);
  expect(r.out).toContain("backgrounded");
});

test("hire without --report-to reports to the PM session of the repo it runs in", () => {
  const stub = stubClaude([]);
  const repo = join(mkdtempSync(join(tmpdir(), "f1rm-repo-")), "shop");
  mkdirSync(repo);
  hire(stub, ["backend-dev", "backend-dev-api", "api", BRIEF], repo);
  expect(stub.argv()![7]).toBe(`/mattpocock-skills:tdd Report to: pm-shop\n\n${BRIEF}`);
});

test.each([
  ["frontend-dev", "/mattpocock-skills:tdd"],
  ["backend-dev", "/mattpocock-skills:tdd"],
  ["researcher", "/research"],
  ["reviewer", "/code-review Before you start, load these with the Skill tool: f1rm:f1rm-guidelines, security-review."],
])("a %s brief starts with its slash commands: %s", (role, commands) => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, role, `${role}-x`, "x", BRIEF]);
  expect(stub.argv()![7]).toStartWith(`${commands} Report to: pm-shop\n\n`);
});

test("only a reviewer hire carries the no-push deny rule, after the prompt so it cannot swallow it", () => {
  const reviewer = stubClaude([]);
  hire(reviewer, [...pmArgs, "reviewer", "reviewer-x", "x", BRIEF]);
  expect(reviewer.argv()!.slice(8)).toEqual(["--disallowedTools", "Bash(git push *)"]);
  const designer = stubClaude([]);
  hire(designer, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(designer.argv()).toHaveLength(8);
});

test("flags after the brief go to claude", () => {
  const stub = stubClaude([]);
  hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF, "--model", "haiku"]);
  expect(stub.argv()!.slice(8)).toEqual(["--model", "haiku"]);
});

test("at 6 working background sessions, hire refuses with a non-zero exit and tells the PM to ask the user", () => {
  const stub = stubClaude([...Array(5).fill(bg("working")), bg("blocked")]);
  const r = hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("6 hires are already working (the cap is 6)");
  expect(r.err).toContain("ask whether to wait or exceed the cap");
  expect(stub.argv()).toBeNull();
});

test("below the cap hire goes ahead: finished hires and interactive sessions do not count", () => {
  const stub = stubClaude([
    ...Array(5).fill(bg("working")),
    bg("done"),
    bg("stopped"),
    bg("failed"),
    { kind: "interactive" },
  ]);
  expect(hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]).code).toBe(0);
  expect(stub.argv()).not.toBeNull();
});

test("--override hires past the cap", () => {
  const stub = stubClaude(Array(7).fill(bg("working")));
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
const repoDir = () => realpathSync(mkdtempSync(join(tmpdir(), "f1rm-repo-")));
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-home-"))), repo = repoDir();
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
