// Seam: `f1rm push`, run in a real temp git repo whose `origin` is a bare repo next to it, with an injected HOME and a check command given by flag.
// Nothing here reaches a real remote: origin is a folder in the temp dir.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushIn } from "./push.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const commit = (cwd: string, file: string, text = file) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/** A repo `shop` on main with one commit already on its bare `origin`, and a second clone `other` of origin (another machine). */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-push-")));
  made.push(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(root, "shop");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { check: "pwd >> .git/check-ran" } }));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  const first = commit(repo, "README.md", "shop\n");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const other = join(root, "other");
  git(root, "clone", "-q", origin, other);
  const home = join(root, "home");
  mkdirSync(home);
  return { root, origin, repo, other, home, first };
}
type Setup = ReturnType<typeof setup>;

const NOW = Date.parse("2026-11-02T12:00:00Z");
const run = (s: Setup, flags: string[], cwd = s.repo) => pushIn(flags, cwd, { home: s.home, now: () => NOW });
const push = (s: Setup, ...flags: string[]) => run(s, ["--check", "true", ...flags]);
const originMain = (s: Setup) => git(s.origin, "rev-parse", "refs/heads/main");
const pushesLog = (s: Setup) => join(s.home, ".f1rm", "kept", "shop", "pushes.log");
const ran = (s: Setup) => existsSync(join(s.repo, ".git", "check-ran"));

test("a green suite and a fast-forward push the base branch: `pushed main <old7>..<new7> to origin`, and origin is at the new tip", async () => {
  const s = setup();
  const tip = commit(s.repo, "a.txt");
  const r = await push(s);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n").at(-1)).toBe(`pushed main ${s.first.slice(0, 7)}..${tip.slice(0, 7)} to origin`);
  expect(originMain(s)).toBe(tip);
});

test("a push appends `date | repo | base | old..new` to ~/.f1rm/kept/<repo>/pushes.log, one line per push", async () => {
  const s = setup();
  const one = commit(s.repo, "a.txt");
  await push(s);
  const two = commit(s.repo, "b.txt");
  await push(s);
  expect(readFileSync(pushesLog(s), "utf8")).toBe(`2026-11-02T12:00:00.000Z | shop | main | ${s.first}..${one}\n2026-11-02T12:00:00.000Z | shop | main | ${one}..${two}\n`);
});

test("when origin already has the tip it says `already up to date`, pushes nothing and logs nothing", async () => {
  const s = setup();
  const r = await push(s);
  expect([r.code, r.out.trim(), r.err]).toEqual([0, "already up to date", ""]);
  expect(existsSync(pushesLog(s))).toBe(false);
});

test("origin ahead of the base branch (another machine pushed) is refused as not a fast-forward, with the count; origin is unchanged and the suite did not run", async () => {
  const s = setup();
  commit(s.other, "x.txt");
  commit(s.other, "y.txt");
  git(s.other, "push", "-q", "origin", "main");
  const theirs = originMain(s);
  commit(s.repo, "a.txt");
  const r = await run(s, ["--check", "touch .git/check-ran"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("not a fast-forward");
  expect(r.err).toContain("2 commits");
  expect(originMain(s)).toBe(theirs);
  expect(ran(s)).toBe(false);
  expect(existsSync(pushesLog(s))).toBe(false);
});

test("a `+` refspec in remote.origin.push does not force: when origin moves while the suite runs, the push is rejected and origin keeps the other machine's commit", async () => {
  const s = setup();
  git(s.repo, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  git(s.repo, "config", "push.default", "matching");
  commit(s.repo, "a.txt");
  const theirs = commit(s.other, "x.txt");
  // The suite is the race: it lands the other machine's commit on origin after the fast-forward check and before the push.
  const r = await run(s, ["--check", `git -C ${s.other} push -q origin main`]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("push failed");
  expect(originMain(s)).toBe(theirs);
  expect(existsSync(pushesLog(s))).toBe(false);
});

test("only the base branch goes: another local branch and a tag stay local, whatever remote.origin.push and push.followTags say", async () => {
  const s = setup();
  git(s.repo, "config", "remote.origin.push", "refs/heads/*:refs/heads/*");
  git(s.repo, "config", "push.followTags", "true");
  git(s.repo, "branch", "other");
  commit(s.repo, "a.txt");
  git(s.repo, "tag", "-a", "v1", "-m", "v1");
  const r = await push(s);
  expect(r.code).toBe(0);
  expect(git(s.origin, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
});

test("a failing suite refuses with its exit code and last lines and pushes nothing", async () => {
  const s = setup();
  commit(s.repo, "a.txt");
  const r = await run(s, ["--check", "echo boom; exit 3"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("check failed (exit 3)");
  expect(r.err).toContain("boom");
  expect(r.err).toContain("nothing pushed");
  expect(originMain(s)).toBe(s.first);
});

test("the default suite is `bun run check` of package.json, run once in the main working directory; --check replaces it; a repo with no check script and no --check is refused", async () => {
  const s = setup();
  commit(s.repo, "a.txt");
  const r = await run(s, []);
  expect([r.err, r.code]).toEqual(["", 0]);
  expect(readFileSync(join(s.repo, ".git", "check-ran"), "utf8").trim().split("\n")).toEqual([s.repo]);

  const t = setup();
  writeFileSync(join(t.repo, "package.json"), "{}\n");
  commit(t.repo, "a.txt");
  const none = await run(t, []);
  expect(none.code).toBe(1);
  expect(none.err).toContain("no `check` script");
  expect(originMain(t)).toBe(t.first);
  const custom = await run(t, ["--check", "touch .git/custom-ran"]);
  expect(custom.code).toBe(0);
  expect(existsSync(join(t.repo, ".git", "custom-ran"))).toBe(true);
});

test("refused, changing nothing: no origin, a detached HEAD, a branch that is not the base, a worktree, uncommitted changes, a bad flag", async () => {
  const noOrigin = setup();
  git(noOrigin.repo, "remote", "remove", "origin");
  commit(noOrigin.repo, "a.txt");
  const nr = await push(noOrigin);
  expect([nr.code, nr.err]).toEqual([1, expect.stringContaining("no remote named origin")]);

  const detached = setup();
  commit(detached.repo, "a.txt");
  git(detached.repo, "checkout", "-q", "--detach");
  const dr = await push(detached);
  expect([dr.code, dr.err]).toEqual([1, expect.stringContaining("detached HEAD")]);
  expect(originMain(detached)).toBe(detached.first);

  const feature = setup();
  git(feature.repo, "checkout", "-q", "-b", "feature");
  commit(feature.repo, "a.txt");
  const fr = await push(feature);
  expect([fr.code, fr.err]).toEqual([1, expect.stringContaining("not the base branch")]);
  expect(git(feature.origin, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");

  const tree = setup();
  commit(tree.repo, "a.txt");
  const wt = join(tree.repo, ".claude", "worktrees", "add-a");
  git(tree.repo, "worktree", "add", "-q", wt, "-b", "worktree-add-a");
  const wr = await run(tree, ["--check", "true"], wt);
  expect([wr.code, wr.err]).toEqual([1, expect.stringContaining("main working directory")]);
  expect(originMain(tree)).toBe(tree.first);

  const dirty = setup();
  commit(dirty.repo, "a.txt");
  writeFileSync(join(dirty.repo, "a.txt"), "changed\n");
  const ur = await push(dirty);
  expect([ur.code, ur.err]).toEqual([1, expect.stringContaining("uncommitted changes")]);

  const s = setup();
  for (const flags of [["--force"], ["--check"], ["--check", " "], ["main"], ["--check", "true", "--tags"]]) {
    const r = await run(s, flags);
    expect([flags, r.code, r.err]).toEqual([flags, 1, expect.stringContaining("usage: f1rm push")]);
  }
});

test("the f1rm command wires it: the pushed line on stdout, a refusal on stderr with a non-zero exit, and the usage lists it", () => {
  const s = setup();
  commit(s.repo, "a.txt");
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "f1rm.ts"), ...args], { cwd: s.repo, env: { ...process.env, HOME: s.home } });
  const refused = cli("push", "--check", "exit 9");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("check failed (exit 9)");
  const pushed = cli("push", "--check", "true");
  expect(pushed.exitCode).toBe(0);
  expect(pushed.stdout.toString().trim()).toBe(`pushed main ${s.first.slice(0, 7)}..${git(s.repo, "rev-parse", "--short=7", "HEAD")} to origin`);
  expect(cli("help").stdout.toString()).toContain("push [--check <command>]");
});
