// Seam: `f1rm merge <task>`, run in a real temp git repo with a dev's worktree branch, an injected HOME and a check command given by flag.
// Nothing here pushes or touches the real repo; a pre-push hook and a bare "remote" prove the command never tries.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIn } from "./merge.ts";
import { reportIn } from "./report.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const ADD = `export const add = (a: number, b: number) => a + b;\n`;
const ADD_TEST = `import { expect, test } from "bun:test";\nimport { add } from "./add.ts";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n`;
const PASSES = `import { expect, test } from "bun:test";\ntest("always", () => expect(1).toBe(1));\n`;

/** A repo `shop` on main with one commit (a package.json whose check records where it ran), and the dev's worktree `.claude/worktrees/add-a` on `worktree-add-a`. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-merge-")));
  made.push(root);
  const repo = join(root, "shop");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { check: "pwd >> ../../../.git/check-ran" } }));
  writeFileSync(join(repo, "README.md"), "shop\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const wt = join(repo, ".claude", "worktrees", "add-a");
  git(repo, "worktree", "add", "-q", wt, "-b", "worktree-add-a");
  const home = join(root, "home");
  mkdirSync(home);
  return { root, repo, wt, home };
}
type Setup = ReturnType<typeof setup>;

const commit = (cwd: string, files: Record<string, string>, message = "work") => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(cwd, name, ".."), { recursive: true });
    writeFileSync(join(cwd, name), text);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
/** The dev's `DONE` report for its current tip (or for `commit`). */
const done = async (s: Setup, commit = git(s.wt, "rev-parse", "HEAD"), task = "add-a") => void (await reportIn(["DONE", task, "--commit", commit], s.wt, { home: s.home }));
/** A feature with its test: the test fails on the base, which has no add.ts. */
const feature = (s: Setup) => commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST }, "add");

const merge = (s: Setup, ...flags: string[]) => mergeIn(["add-a", "--check", "true", ...flags], s.repo, { home: s.home, now: () => Date.parse("2026-10-28T12:00:00Z") });
const evidence = (s: Setup, file: string) => join(s.home, ".f1rm", "evidence", "shop", "add-a", file);
const lines = (out: string) => out.trim().split("\n");

/** What a refused merge must leave: main where it was, clean, no scratch worktree, and the dev's branch where it was. */
function untouched(s: Setup, head: string, tip: string) {
  expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(s.repo, "status", "--porcelain", "--", ".", ":(exclude).claude/worktrees")).toBe("");
  expect(git(s.repo, "rev-parse", "refs/heads/worktree-add-a")).toBe(tip);
  const listed = git(s.repo, "worktree", "list");
  expect(listed).not.toContain("merge-add-a");
  expect(listed).not.toContain("red-add-a");
  expect(existsSync(join(s.repo, ".claude", "worktrees", "merge-add-a"))).toBe(false);
  expect(existsSync(join(s.repo, ".claude", "worktrees", "red-add-a"))).toBe(false);
  expect(git(s.repo, "branch", "--list")).not.toContain("merge-");
}

test("a reviewed branch lands: new tests red on the base, the check green on the merge, main fast-forwarded to a --no-ff merge, one line per step and a last line `merged <sha>`", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  const base = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const head = git(s.repo, "rev-parse", "HEAD");
  expect(lines(r.out).at(-1)).toBe(`merged ${head}`);
  expect(git(s.repo, "rev-parse", "HEAD^1")).toBe(base);
  expect(git(s.repo, "rev-parse", "HEAD^2")).toBe(tip);
  expect(readFileSync(join(s.repo, "add.ts"), "utf8")).toBe(ADD);
  expect(lines(r.out).some((l) => l.includes("add.test.ts") && /red/i.test(l))).toBe(true);
  expect(git(s.repo, "worktree", "list").split("\n")).toHaveLength(2); // main and the dev's, no scratch left
  expect(git(s.repo, "status", "--porcelain", "--", ".", ":(exclude).claude/worktrees")).toBe("");
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8"))).toEqual({ merge: head, base, tip, red: ["add.test.ts"], check: 0, at: "2026-10-28T12:00:00.000Z" });
  expect(statSync(evidence(s, "merge.json")).mode & 0o777).toBe(0o600);
});

test("the f1rm command wires it: steps on stdout as they happen, the last line `merged <sha>`, a refusal on stderr with a non-zero exit, and the usage lists it", async () => {
  const s = setup();
  feature(s);
  await done(s);
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "f1rm.ts"), ...args], { cwd: s.repo, env: { ...process.env, HOME: s.home } });
  const refused = cli("merge", "add-a", "--check", "exit 9");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("check failed (exit 9)");
  const landed = cli("merge", "add-a", "--check", "true");
  expect(landed.exitCode).toBe(0);
  expect(landed.stdout.toString().trim().split("\n").at(-1)).toBe(`merged ${git(s.repo, "rev-parse", "HEAD")}`);
  expect(cli("help").stdout.toString()).toContain("merge <task> [--check <command>]");
});

test("the default check is `bun run check`, run once, in the scratch worktree of the merge", async () => {
  const s = setup();
  feature(s);
  await done(s);
  const r = await mergeIn(["add-a"], s.repo, { home: s.home });
  expect(r.code).toBe(0);
  expect(readFileSync(join(s.repo, ".git", "check-ran"), "utf8").trim().split("\n")).toEqual([join(s.repo, ".claude", "worktrees", "merge-add-a")]);
});

test("the check runs through the suite lock: a lock held by a live process makes the merge wait, and the merge lands once it is gone", async () => {
  const s = setup();
  feature(s);
  await done(s);
  const lock = join(s.repo, ".git", "f1rm-check.lock");
  const holder = Bun.spawn(["sleep", "30"]);
  writeFileSync(lock, JSON.stringify({ pid: holder.pid, since: Date.now(), cwd: "/other/worktree", commit: "abc" }));
  const pending = mergeIn(["add-a", "--check", "true"], s.repo, { home: s.home, env: { F1RM_CHECK_POLL_MS: "50" } });
  await Bun.sleep(600);
  expect(git(s.repo, "log", "--oneline", "-1")).toContain("first"); // still waiting: main has not moved
  holder.kill();
  rmSync(lock);
  const r = await pending;
  expect(r.code).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

test("a failing check refuses the landing: main untouched, scratch gone, and the tail of the check's output is shown", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s, "--check", "echo BOOM-FROM-CHECK; exit 3");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("check failed");
  expect(r.err).toContain("exit 3");
  expect(r.err).toContain("BOOM-FROM-CHECK");
  expect(existsSync(evidence(s, "merge.json"))).toBe(false);
  untouched(s, head, tip);
});

test("a dirty main working directory is refused and left as it is; the scratch folder of worktrees does not count as dirt", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  writeFileSync(join(s.repo, "README.md"), "edited by the user\n");
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("uncommitted changes");
  expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("edited by the user\n");
  expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(s.repo, "rev-parse", "refs/heads/worktree-add-a")).toBe(tip);
  git(s.repo, "checkout", "--", "README.md");
  writeFileSync(join(s.repo, "stray.txt"), "untracked\n");
  expect((await merge(s)).err).toContain("uncommitted changes");
  rmSync(join(s.repo, "stray.txt"));
  expect((await merge(s)).code).toBe(0); // .claude/worktrees/add-a is untracked in this repo and is no dirt
});

test("no DONE report, or a newest report that is not a DONE, or a DONE without a commit, is refused", async () => {
  const s = setup();
  const tip = feature(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  let r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no DONE report");
  await done(s);
  await reportIn(["BLOCKED", "add-a"], s.wt, { home: s.home });
  r = await merge(s);
  expect(r.err).toContain("no DONE report");
  await reportIn(["DONE", "add-a"], s.wt, { home: s.home });
  expect((await merge(s)).err).toContain("no DONE report");
  untouched(s, head, tip);
});

test("a tip that differs from the DONE commit is refused with `tip moved`; a short sha of the tip is the same commit", async () => {
  const s = setup();
  const first = feature(s);
  await done(s);
  const second = commit(s.wt, { "more.txt": "more\n" }, "after the DONE");
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("tip moved: send the work back to the dev");
  untouched(s, head, second);
  await done(s, first.slice(0, 7));
  expect((await merge(s)).err).toContain("tip moved");
  await done(s, second.slice(0, 7));
  expect((await merge(s)).code).toBe(0);
});

test("code with no test file is refused; documentation, *.md, growth/ and docs/ land without a red check", async () => {
  const s = setup();
  const tip = commit(s.wt, { "add.ts": ADD }, "code only");
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no test file");
  untouched(s, head, tip);

  const d = setup();
  commit(d.wt, { "README.md": "shop, documented\n", "docs/decisions.md": "# d\n", "growth/plan.txt": "plan\n", "notes/a.MD": "x\n" }, "docs");
  await done(d);
  const ok = await merge(d);
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("red: skipped");
  expect(JSON.parse(readFileSync(evidence(d, "merge.json"), "utf8")).red).toEqual([]);
});

test("a new test that passes on the base proves nothing: the landing is refused and the file that passed is named, not the ones that failed", async () => {
  const s = setup();
  const tip = commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "always.test.ts": PASSES }, "add");
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("pass on the base");
  expect(r.err).toContain("always.test.ts");
  expect(r.err).not.toContain("add.test.ts");
  untouched(s, head, tip);
});

test("a conflict with main is aborted and cleaned up, main is untouched and the dev is told to rebase and send a new DONE", async () => {
  const s = setup();
  commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "README.md": "shop, the dev's words\n" }, "add");
  const tip = git(s.wt, "rev-parse", "HEAD");
  await done(s);
  const head = commit(s.repo, { "README.md": "shop, main's words\n" }, "main moves");
  const r = await merge(s);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("conflict: the dev rebases onto main and sends a new DONE");
  expect(existsSync(evidence(s, "merge.json"))).toBe(false);
  untouched(s, head, tip);
  expect(existsSync(join(s.repo, ".git", "worktrees", "merge-add-a"))).toBe(false); // no merge state left behind
});

test("a repo without a check script is refused unless --check names one", async () => {
  const s = setup();
  writeFileSync(join(s.repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  git(s.repo, "commit", "-q", "-am", "no check");
  git(s.wt, "merge", "-q", "main");
  const tip = feature(s);
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await mergeIn(["add-a"], s.repo, { home: s.home });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no `check` script");
  untouched(s, head, tip);
  expect((await merge(s)).code).toBe(0);
});

test("it runs only in the main working directory: a worktree, a folder outside the repo and a bad task name are refused", async () => {
  const s = setup();
  feature(s);
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const inWorktree = await mergeIn(["add-a", "--check", "true"], s.wt, { home: s.home });
  expect(inWorktree.code).not.toBe(0);
  expect(inWorktree.err).toContain("main working directory");
  const outside = await mergeIn(["add-a", "--check", "true"], s.root, { home: s.home });
  expect(outside.code).not.toBe(0);
  for (const argv of [[], ["Add A"], ["../x"], ["add-a", "--check"], ["add-a", "--bogus", "x"], ["add-a", "--check", " "]]) {
    const bad = await mergeIn(argv, s.repo, { home: s.home });
    expect([argv, bad.code, bad.err]).toEqual([argv, 1, expect.stringContaining("usage")]);
  }
  expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
});

test("a branch that is already on main, or a leftover scratch worktree of this task, is refused", async () => {
  const s = setup();
  feature(s);
  await done(s);
  mkdirSync(join(s.repo, ".claude", "worktrees", "merge-add-a"), { recursive: true });
  const stale = await merge(s);
  expect(stale.err).toContain("merge-add-a exists");
  rmSync(join(s.repo, ".claude", "worktrees", "merge-add-a"), { recursive: true });
  expect((await merge(s)).code).toBe(0);
  const again = await merge(s);
  expect(again.code).not.toBe(0);
  expect(again.err).toContain("already on main");
});

const SELF_MOVE = (repo: string, marker: string) => `[ -e ${marker} ] || { touch ${marker}; git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved; }`;

test("when main moves while the merge is checked, the merge is redone from the new tip once and lands on it", async () => {
  const s = setup();
  feature(s);
  await done(s);
  const before = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s, "--check", SELF_MOVE(s.repo, join(s.root, "moved-once")));
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain("moved");
  const moved = git(s.repo, "rev-parse", "HEAD^1");
  expect(git(s.repo, "log", "-1", "--format=%s", moved)).toBe("moved");
  expect(git(s.repo, "rev-parse", `${moved}^`)).toBe(before);
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8")).base).toBe(moved);
  expect(git(s.repo, "worktree", "list").split("\n")).toHaveLength(2);
});

test("when main moves again on the second try the command stops with a message and lands nothing", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  const r = await merge(s, "--check", `git -C ${s.repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("moved again");
  expect(git(s.repo, "log", "--format=%s")).not.toContain("Merge branch");
  expect(existsSync(evidence(s, "merge.json"))).toBe(false);
  untouched(s, git(s.repo, "rev-parse", "HEAD"), tip);
});

test("it never pushes and never touches a remote: a pre-push hook never runs, the remote and its tracking refs stay as they were", async () => {
  const s = setup();
  const remote = join(s.root, "remote.git");
  git(s.root, "init", "-q", "--bare", remote);
  git(s.repo, "remote", "add", "origin", remote);
  const marker = join(s.root, "pushed");
  const hook = join(s.repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(hook, 0o755);
  feature(s);
  await done(s);
  const r = await merge(s);
  expect(r.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(git(s.repo, "for-each-ref", "refs/remotes")).toBe("");
  expect(git(remote, "for-each-ref")).toBe("");
  expect(git(s.repo, "config", "--get", "remote.origin.url")).toBe(remote);
});

test("a repo's node_modules is linked into the scratch worktrees and the link is gone afterwards, the real folder untouched", async () => {
  const s = setup();
  mkdirSync(join(s.repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(s.repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  feature(s);
  await done(s);
  const seen = join(s.root, "seen");
  const r = await merge(s, "--check", `ls node_modules/dep > ${seen}`);
  expect(r.code).toBe(0);
  expect(readFileSync(seen, "utf8").trim()).toBe("index.js");
  expect(readFileSync(join(s.repo, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  expect(symlinkSyncProbe(join(s.repo, "node_modules"))).toBe(false);
});
const symlinkSyncProbe = (p: string) => {
  try {
    return statSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
