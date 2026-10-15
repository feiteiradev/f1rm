// Seam 2: the real `f1rm hire`, run against a stub `claude` first on PATH.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "f1rm.ts");
const BRIEF = "Task: landing: build the page\nAcceptance criteria:\n- it renders";

type Session = { kind: string; state?: string };
const bg = (state: string): Session => ({ kind: "background", state });

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
  ["reviewer", "/code-review /f1rm:f1rm-guidelines /security-review"],
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

test("at 4 working hires, hire refuses with a non-zero exit and tells the PM to ask the user", () => {
  const stub = stubClaude([bg("working"), bg("working"), bg("blocked"), bg("working")]);
  const r = hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("4 hires are already working");
  expect(r.err).toContain("ask whether to wait or exceed the cap");
  expect(stub.argv()).toBeNull();
});

test("below the cap hire goes ahead: finished hires and interactive sessions do not count", () => {
  const stub = stubClaude([
    bg("working"),
    bg("working"),
    bg("working"),
    bg("done"),
    bg("stopped"),
    bg("failed"),
    { kind: "interactive" },
  ]);
  expect(hire(stub, [...pmArgs, "designer", "designer-x", "x", BRIEF]).code).toBe(0);
  expect(stub.argv()).not.toBeNull();
});

test("--override hires past the cap", () => {
  const stub = stubClaude(Array(5).fill(bg("working")));
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
