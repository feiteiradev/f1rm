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

test("a spec's integration branch lands with no DONE report: `f1rm merge spec-<n>` takes spec-<n> as it is, with the same red check and suite, and still refuses a settings change", async () => {
  const s = setup();
  const spec = join(s.repo, ".claude", "worktrees", "spec-7");
  git(s.repo, "worktree", "add", "-q", spec, "-b", "spec-7");
  const tip = commit(spec, { "add.ts": ADD, "add.test.ts": ADD_TEST }, "Merge ticket-8 (#8) into spec-7");
  const base = git(s.repo, "rev-parse", "HEAD");
  const r = await mergeIn(["spec-7", "--check", "true"], s.repo, { home: s.home, now: () => Date.parse("2026-11-06T12:00:00Z") });
  expect([r.code, r.err]).toEqual([0, ""]);
  expect(git(s.repo, "rev-parse", "HEAD^1")).toBe(base);
  expect(git(s.repo, "rev-parse", "HEAD^2")).toBe(tip);
  expect(lines(r.out).some((l) => l.includes("add.test.ts") && /red/i.test(l))).toBe(true);
  const other = join(s.repo, ".claude", "worktrees", "spec-8");
  git(s.repo, "worktree", "add", "-q", other, "-b", "spec-8");
  commit(other, { ".claude/settings.json": "{}\n", "b.ts": ADD, "b.test.ts": ADD_TEST.replace("./add.ts", "./b.ts") }, "widen");
  const refused = await mergeIn(["spec-8", "--check", "true"], s.repo, { home: s.home });
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("settings");
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
  expect(cli("help").stdout.toString()).toContain("merge <task> [--check <command>] [--no-red <reason>]");
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
  expect(r.err).toContain("the dev fixes it and sends a new DONE");
  expect(existsSync(evidence(s, "merge.json"))).toBe(false);
  untouched(s, head, tip);
});

test("a dirty file the merge does not touch no longer blocks and is left as it is; a dirty or untracked path the merge changes is refused, named, and nothing moves", async () => {
  const s = setup();
  feature(s);
  await done(s);
  writeFileSync(join(s.repo, "README.md"), "edited by the user\n");
  writeFileSync(join(s.repo, "stray.txt"), "untracked\n");
  const r = await merge(s);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("edited by the user\n");
  expect(readFileSync(join(s.repo, "stray.txt"), "utf8")).toBe("untracked\n");
  expect(readFileSync(join(s.repo, "add.ts"), "utf8")).toBe(ADD);

  const o = setup();
  const tip = commit(o.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "README.md": "shop, the dev's words\n" }, "add");
  await done(o);
  const head = git(o.repo, "rev-parse", "HEAD");
  writeFileSync(join(o.repo, "README.md"), "edited by the user\n"); // tracked, changed by the merge
  writeFileSync(join(o.repo, "add.ts"), "// mine\n"); // untracked, added by the merge
  const refused = await merge(o);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("README.md");
  expect(refused.err).toContain("add.ts");
  expect(refused.err).toContain("committed or removed");
  expect(refused.err).not.toContain("add.test.ts");
  expect(readFileSync(join(o.repo, "README.md"), "utf8")).toBe("edited by the user\n");
  expect(readFileSync(join(o.repo, "add.ts"), "utf8")).toBe("// mine\n");
  expect(git(o.repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(o.repo, "rev-parse", "refs/heads/worktree-add-a")).toBe(tip);
  expect(git(o.repo, "worktree", "list")).not.toContain("merge-add-a");
  git(o.repo, "checkout", "--", "README.md");
  rmSync(join(o.repo, "add.ts"));
  expect((await merge(o)).code).toBe(0); // .claude/worktrees/add-a is untracked in this repo and is no dirt
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
  expect(r.err).toContain("the lead hires a fresh implementer");
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
  expect(r.err).toContain('--check "<the project\'s full suite command>"');
  expect(r.err).toContain("remembered");
  untouched(s, head, tip);
  expect((await merge(s)).code).toBe(0);
});

const checkFile = (s: Setup) => join(s.home, ".f1rm", "kept", "shop", "check-command");
const callsFile = (s: Setup) => join(s.home, ".f1rm", "kept", "shop", "calls.md");
/** The repo without a `check` script, the dev's branch updated onto it, and a feature on that branch. */
function noScript() {
  const s = setup();
  writeFileSync(join(s.repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  git(s.repo, "commit", "-q", "-am", "no check");
  git(s.wt, "merge", "-q", "main");
  feature(s);
  return s;
}

test("--check is remembered when the merge lands: one line in kept/<repo>/check-command, and a refused merge writes nothing", async () => {
  const s = noScript();
  await done(s);
  expect((await merge(s, "--check", "exit 3")).code).toBe(1);
  expect(existsSync(checkFile(s))).toBe(false);
  expect((await mergeIn(["add-a", "--check", "echo suite-ran"], s.repo, { home: s.home })).code).toBe(0);
  expect(readFileSync(checkFile(s), "utf8")).toBe("echo suite-ran\n");
});

test("with no --check and no check script the remembered command is the suite; an explicit --check wins; a repo with a check script keeps its script", async () => {
  const s = noScript();
  await done(s);
  mkdirSync(join(s.home, ".f1rm", "kept", "shop"), { recursive: true });
  const ran = join(s.root, "ran");
  writeFileSync(checkFile(s), `echo remembered > ${ran}\n`);
  const r = await mergeIn(["add-a", "--check", "echo given"], s.repo, { home: s.home });
  expect(r.code).toBe(0);
  expect(existsSync(ran)).toBe(false); // --check won
  expect(readFileSync(checkFile(s), "utf8")).toBe("echo given\n");

  const t = noScript();
  await done(t);
  mkdirSync(join(t.home, ".f1rm", "kept", "shop"), { recursive: true });
  writeFileSync(checkFile(t), `echo remembered > ${ran}\n`);
  const used = await mergeIn(["add-a"], t.repo, { home: t.home });
  expect(used.err).toBe("");
  expect(used.code).toBe(0);
  expect(readFileSync(ran, "utf8").trim()).toBe("remembered");
  expect(used.out).toContain("echo remembered");

  const u = setup(); // has scripts.check
  feature(u);
  await done(u);
  mkdirSync(join(u.home, ".f1rm", "kept", "shop"), { recursive: true });
  writeFileSync(checkFile(u), "exit 9\n");
  expect((await mergeIn(["add-a"], u.repo, { home: u.home })).code).toBe(0);
  expect(readFileSync(join(u.repo, ".git", "check-ran"), "utf8").trim()).toBe(join(u.repo, ".claude", "worktrees", "merge-add-a"));
});

test("--no-red: a test-only branch is refused with the way out named, lands with a reason that is logged in calls.md, and the suite still runs", async () => {
  const s = setup();
  const tip = commit(s.wt, { "always.test.ts": PASSES }, "test only");
  await done(s);
  const head = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s);
  expect(r.code).toBe(1);
  expect(r.err).toContain('--no-red "<reason>"');
  expect(r.err).not.toMatch(/user/i);
  untouched(s, head, tip);
  const failed = await merge(s, "--no-red", "renamed tests", "--check", "exit 4");
  expect(failed.err).toContain("check failed (exit 4)");
  expect(existsSync(callsFile(s))).toBe(false);
  untouched(s, head, tip);
  for (const bad of [["--no-red"], ["--no-red", " "]]) expect((await merge(s, ...bad)).err).toContain("usage");
  const ok = await merge(s, "--no-red", "renamed | tests only");
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("red: skipped");
  expect(readFileSync(callsFile(s), "utf8")).toBe("| date | task | call | detail |\n|---|---|---|---|\n| 2026-10-28 | add-a | merge --no-red | renamed / tests only |\n");
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8")).red).toEqual([]);

  const c = setup(); // code with no test file, and a calls.md that already has its header
  commit(c.wt, { "add.ts": ADD }, "refactor");
  await done(c);
  mkdirSync(join(c.home, ".f1rm", "kept", "shop"), { recursive: true });
  writeFileSync(callsFile(c), "| date | task | call | detail |\n|---|---|---|---|\n| 2026-10-01 | x | y | z |\n");
  expect((await merge(c)).err).toContain('--no-red "<reason>"');
  expect((await merge(c, "--no-red", "no new behaviour")).code).toBe(0);
  expect(readFileSync(callsFile(c), "utf8").trim().split("\n")).toEqual(["| date | task | call | detail |", "|---|---|---|---|", "| 2026-10-01 | x | y | z |", "| 2026-10-28 | add-a | merge --no-red | no new behaviour |"]);
});

test("a branch that touches Claude Code settings, hooks or commands is refused whatever the flags; the message says only the user changes permissions", async () => {
  for (const file of [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/pre.sh", ".claude/commands/go.md", ".claude/hooks/é.sh", ".Claude/Settings.json", ".CLAUDE/hooks/x", ".claude/agents/a.md", ".claude/skills/s/SKILL.md", ".mcp.json"]) {
    const s = setup();
    mkdirSync(join(s.wt, file, ".."), { recursive: true });
    writeFileSync(join(s.wt, file), "{}\n");
    git(s.wt, "add", "-f", file); // settings.local.json is ignored in most checkouts
    const tip = commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST });
    await done(s);
    const head = git(s.repo, "rev-parse", "HEAD");
    const r = await merge(s, "--no-red", "because");
    expect([file, r.code, r.err]).toEqual([file, 1, expect.stringContaining("a merged settings file widens every later session's permissions; only the user changes Claude Code permissions (the office's project-commands card)")]);
    expect(r.err).toContain(file);
    untouched(s, head, tip);
  }
});

test("a settings entry that is a bare symlink (.claude/commands, .claude/hooks) is refused like the files under it", async () => {
  for (const dir of [".claude/commands", ".claude/hooks"]) {
    const s = setup();
    mkdirSync(join(s.wt, ".claude"), { recursive: true });
    symlinkSync("../elsewhere", join(s.wt, dir));
    git(s.wt, "add", "-f", dir);
    const tip = commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST });
    await done(s);
    const r = await merge(s);
    expect([dir, r.code, r.err]).toEqual([dir, 1, expect.stringContaining("a merged settings file widens")]);
    untouched(s, git(s.repo, "rev-parse", "HEAD"), tip);
  }
});

test("paths git would quote (accents, spaces) are read whole: an accented test file counts as a test, and a dirty file with such a name is named in the refusal", async () => {
  const s = setup();
  commit(s.wt, { "é.test.ts": ADD_TEST, "add.ts": ADD }, "accented test");
  await done(s);
  const r = await merge(s);
  expect(r.err).toBe("");
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8")).red).toEqual(["é.test.ts"]);

  const o = setup(); // an untracked file at a path the merge adds
  const tip = commit(o.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "my fíle.txt": "dev\n" });
  await done(o);
  writeFileSync(join(o.repo, "my fíle.txt"), "mine\n");
  const refused = await merge(o);
  expect(refused.err).toContain("my fíle.txt");
  untouched2(o, tip);
});
const untouched2 = (s: Setup, tip: string) => expect(git(s.repo, "rev-parse", "refs/heads/worktree-add-a")).toBe(tip);

test("a rename in main's working tree counts at the old path too, and an untracked file where the merge adds a directory (or the reverse) is named", async () => {
  const s = setup();
  commit(s.repo, { "old name.txt": "x\n" }, "base file");
  git(s.wt, "merge", "-q", "main");
  commit(s.wt, { "old name.txt": "x, changed by the dev\n", "add.ts": ADD, "add.test.ts": ADD_TEST });
  await done(s);
  git(s.repo, "mv", "old name.txt", "new name.txt");
  const r = await merge(s);
  expect(r.code).toBe(1);
  expect(r.err).toContain("old name.txt");

  const d = setup();
  commit(d.wt, { "lib/x.ts": ADD, "lib/x.test.ts": ADD_TEST.replace("./add.ts", "./x.ts") });
  await done(d);
  writeFileSync(join(d.repo, "lib"), "a file where the dev adds a folder\n");
  expect((await merge(d)).err).toContain("lib");
  rmSync(join(d.repo, "lib"));
  expect((await merge(d)).code).toBe(0);

  const e = setup();
  commit(e.wt, { "lib": ADD, "lib.test.ts": ADD_TEST.replace("./add.ts", "./lib") });
  await done(e);
  mkdirSync(join(e.repo, "lib"));
  writeFileSync(join(e.repo, "lib", "mine.txt"), "mine\n");
  const reverse = await merge(e);
  expect(reverse.err).toContain("lib/mine.txt");
});

test("the remembered check command may not push or merge: it is refused where it is read, so a file written by hand cannot smuggle one past the gate", async () => {
  for (const bad of ["git push origin main", "bun test && git -C . push", "gh pr merge 3", "gh api repos/a/b/merges -f base=main", "f1rm push", "true; git  push --force"]) {
    const s = noScript();
    await done(s);
    mkdirSync(join(s.home, ".f1rm", "kept", "shop"), { recursive: true });
    writeFileSync(checkFile(s), bad + "\n");
    const r = await mergeIn(["add-a"], s.repo, { home: s.home });
    expect([bad, r.code, r.err]).toEqual([bad, 1, expect.stringContaining("the remembered check command may not push or merge; pass --check again")]);
    untouched(s, git(s.repo, "rev-parse", "HEAD"), git(s.repo, "rev-parse", "refs/heads/worktree-add-a"));
  }
});

test("a --check or --no-red value with a newline is an error, not flattened; a calls.md or check-command that cannot be written warns after the landing and still exits 0", async () => {
  const s = setup();
  feature(s);
  await done(s);
  for (const flags of [["--check", "true\nrm -rf x"], ["--no-red", "a\nb"]]) {
    const r = await merge(s, ...flags);
    expect([flags[0], r.code, r.err]).toEqual([flags[0], 1, expect.stringContaining("one line")]);
  }
  mkdirSync(join(s.home, ".f1rm"), { recursive: true });
  writeFileSync(join(s.home, ".f1rm", "kept"), "a file where the folder should be\n");
  const r = await merge(s, "--no-red", "why");
  expect(r.code).toBe(0);
  expect(r.out).toContain("warning: could not write");
  expect(r.out.trim().split("\n").at(-1)).toMatch(/^merged /);
});

test("no refusal of merge.ts sends anyone to the user, hands out a script or says to land by hand: its only mention of the user is the settings-file refusal", () => {
  const mentions = readFileSync(join(import.meta.dir, "merge.ts"), "utf8").split("\n").filter((l) => /\buser/i.test(l));
  expect(mentions).toHaveLength(1);
  expect(mentions[0]).toContain("only the user changes Claude Code permissions");
  expect(readFileSync(join(import.meta.dir, "merge.ts"), "utf8")).not.toMatch(/by hand/i);
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

test("only the verified tip lands: a commit the dev makes while the tests and the check run is not merged, and merge.json records the verified tip", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  // The first check also moves main, so the merge is redone: the second attempt must merge the verified tip, not the branch as it is by then.
  const marker = join(s.root, "once");
  const id = "-c user.name=t -c user.email=t@t";
  const late = `[ -e ${marker} ] || { touch ${marker}; (cd ${s.wt} && echo late > late.txt && git add late.txt && git ${id} commit -q -m late); git -C ${s.repo} ${id} commit -q --allow-empty -m moved; }`;
  const r = await merge(s, "--check", late);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(git(s.wt, "rev-parse", "HEAD")).not.toBe(tip);
  expect(git(s.repo, "rev-parse", "HEAD^2")).toBe(tip);
  expect(existsSync(join(s.repo, "late.txt"))).toBe(false);
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8")).tip).toBe(tip);
});

test("if the main working directory is switched to another branch while the merge is checked, nothing lands and the other branch is not moved", async () => {
  const s = setup();
  const tip = feature(s);
  await done(s);
  const base = git(s.repo, "rev-parse", "HEAD");
  const r = await merge(s, "--check", `git -C ${s.repo} checkout -q -b other`);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("is on other now, not main");
  expect(git(s.repo, "rev-parse", "other")).toBe(base);
  expect(git(s.repo, "rev-parse", "main")).toBe(base);
  expect(git(s.repo, "rev-parse", "refs/heads/worktree-add-a")).toBe(tip);
  expect(existsSync(evidence(s, "merge.json"))).toBe(false);
});

test("a branch that changes how the suite runs (scripts.check, scripts.suite, scripts/check-lock.ts) is refused for the default check and lands with an explicit --check; another script may change", async () => {
  for (const change of [
    { "package.json": JSON.stringify({ scripts: { check: "true" } }) },
    { "package.json": JSON.stringify({ scripts: { check: "pwd >> ../../../.git/check-ran", suite: "true" } }) },
    { "scripts/check-lock.ts": "process.exit(0);\n" },
  ] as Record<string, string>[]) {
    const s = setup();
    const tip = commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, ...change });
    await done(s);
    const head = git(s.repo, "rev-parse", "HEAD");
    const r = await mergeIn(["add-a"], s.repo, { home: s.home });
    expect([Object.keys(change)[0], r.code, r.err]).toEqual([Object.keys(change)[0], 1, expect.stringContaining("changes how the suite runs")]);
    expect(r.err).toContain("read the branch's diff of scripts.check, scripts.suite and scripts/check-lock.ts yourself");
    expect(r.err).toContain('--check "bun run check"');
    expect(r.err).not.toMatch(/user/i);
    untouched(s, head, tip);
    expect((await merge(s)).code).toBe(0);
    expect(readFileSync(callsFile(s), "utf8").trim().split("\n").at(-1)).toBe("| 2026-10-28 | add-a | merge --check on a suite change | true |");
  }
  const s = setup();
  commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "package.json": JSON.stringify({ scripts: { check: "pwd >> ../../../.git/check-ran", build: "echo hi" } }) });
  await done(s);
  expect((await mergeIn(["add-a"], s.repo, { home: s.home })).code).toBe(0);
  expect(existsSync(callsFile(s))).toBe(false);
});

test("a new test file is red when bun reports a failure for it on the base: a module the branch adds counts (it cannot load), a fixture under tests/ does not and is named and refused", async () => {
  const s = setup();
  const tip = commit(s.wt, { "add.ts": ADD, "add.test.ts": ADD_TEST, "sub.ts": "export const sub = (a: number, b: number) => a - b;\n", "sub.test.ts": ADD_TEST.replace("add", "sub").replace("add", "sub").replace("add(1, 2)", "sub(3, 1)").replace("toBe(3)", "toBe(2)") });
  await done(s);
  const r = await merge(s);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(evidence(s, "merge.json"), "utf8"))).toMatchObject({ tip, red: ["add.test.ts", "sub.test.ts"] });

  const f = setup();
  const fixtureTip = commit(f.wt, { "add.ts": ADD, "tests/fixtures/data.json": "{}\n" });
  await done(f);
  const fixture = await merge(f);
  expect(fixture.err).toContain("tests/fixtures/data.json");
  untouched(f, git(f.repo, "rev-parse", "HEAD"), fixtureTip);
});

test("the suite guard compares the branch with its merge-base: a branch forked before main changed scripts.check is not refused for it", async () => {
  const s = setup();
  feature(s);
  await done(s);
  writeFileSync(join(s.repo, "package.json"), JSON.stringify({ scripts: { check: "pwd >> ../../../.git/check-ran; true" } }));
  git(s.repo, "commit", "-q", "-am", "main changes scripts.check");
  const r = await mergeIn(["add-a"], s.repo, { home: s.home });
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
});
