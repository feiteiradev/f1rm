// machine.removeWorktree: node_modules goes first so a plain `git worktree remove` works; a symlinked one is only unlinked. Real temp git repos.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveWork } from "../cli/archive.ts";
import { machine } from "./machine.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => (made.push(realpathSync(mkdtempSync(join(tmpdir(), "f1rm-rmwt-")))), made.at(-1)!);
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const wt = (repo: string, task: string) => join(repo, ".claude", "worktrees", task);
function repoWith(task: string) {
  const repo = tmp();
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "start");
  git(repo, "worktree", "add", "-b", `worktree-${task}`, wt(repo, task));
  return repo;
}

test("removeWorktree deletes node_modules first, so the plain remove (no force) succeeds", () => {
  const repo = repoWith("t1");
  mkdirSync(join(wt(repo, "t1"), "node_modules", "pkg", "deep"), { recursive: true });
  writeFileSync(join(wt(repo, "t1"), "node_modules", "pkg", "deep", "x.js"), "x");
  machine.removeWorktree(repo, "t1");
  expect(existsSync(wt(repo, "t1"))).toBe(false);
});

test("node_modules is not in the archive of a worktree", () => {
  const repo = repoWith("t4");
  mkdirSync(join(wt(repo, "t4"), "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt(repo, "t4"), "node_modules", "pkg", "x.js"), "x");
  writeFileSync(join(wt(repo, "t4"), "work.txt"), "w");
  const a = archiveWork(repo, "t4")!;
  expect(git(repo, "ls-tree", "-r", "--name-only", a.ref)).not.toContain("node_modules");
  expect(git(repo, "ls-tree", "-r", "--name-only", a.ref)).toContain("work.txt");
});

/** Another folder with a node_modules holding a file that must survive. */
function precious() {
  const other = tmp();
  mkdirSync(join(other, "node_modules"));
  writeFileSync(join(other, "node_modules", "keep.txt"), "keep");
  return { other, kept: () => existsSync(join(other, "node_modules", "keep.txt")) };
}

test("removeWorktree refuses a worktree dir that is a symlink, and deletes nothing through it", () => {
  const repo = repoWith("t5");
  const p = precious();
  symlinkSync(p.other, wt(repo, "ln"));
  expect(() => machine.removeWorktree(repo, "ln", true)).toThrow(/symlink/);
  expect(p.kept()).toBe(true);
});

test("removeWorktree refuses when .claude/worktrees is a symlink, and deletes nothing through it", () => {
  const repo = tmp();
  git(repo, "init", "-b", "main");
  const p = precious();
  mkdirSync(join(p.other, "t6", "node_modules"), { recursive: true });
  writeFileSync(join(p.other, "t6", "node_modules", "keep.txt"), "keep");
  mkdirSync(join(repo, ".claude"));
  symlinkSync(p.other, join(repo, ".claude", "worktrees"));
  expect(() => machine.removeWorktree(repo, "t6", true)).toThrow(/symlink/);
  expect(existsSync(join(p.other, "t6", "node_modules", "keep.txt"))).toBe(true);
  expect(p.kept()).toBe(true);
});

test("removeWorktree refuses a plain folder under .claude/worktrees that git does not list, and keeps its node_modules", () => {
  const repo = repoWith("t7");
  mkdirSync(join(wt(repo, "plain"), "node_modules"), { recursive: true });
  writeFileSync(join(wt(repo, "plain"), "node_modules", "keep.txt"), "keep");
  expect(() => machine.removeWorktree(repo, "plain", true)).toThrow(/not a worktree/);
  expect(existsSync(join(wt(repo, "plain"), "node_modules", "keep.txt"))).toBe(true);
});

test("removeWorktree on a symlinked node_modules unlinks it and leaves the target alone", () => {
  const repo = repoWith("t2");
  const target = tmp();
  writeFileSync(join(target, "precious.txt"), "keep");
  symlinkSync(target, join(wt(repo, "t2"), "node_modules"));
  machine.removeWorktree(repo, "t2");
  expect(existsSync(wt(repo, "t2"))).toBe(false);
  expect(existsSync(join(target, "precious.txt"))).toBe(true);
});

test("removeWorktree on a dirty worktree without force says git still refuses", () => {
  const repo = repoWith("t8");
  writeFileSync(join(wt(repo, "t8"), "base.txt"), "edited\n");
  expect(() => machine.removeWorktree(repo, "t8")).toThrow(/still refuses.*node_modules is already deleted/);
  expect(existsSync(wt(repo, "t8"))).toBe(true);
});

test("removeWorktree with force still removes a locked worktree; without force it refuses and strips nothing", () => {
  const repo = repoWith("t3");
  mkdirSync(join(wt(repo, "t3"), "node_modules"));
  writeFileSync(join(wt(repo, "t3"), "node_modules", "k.js"), "k");
  git(repo, "worktree", "lock", wt(repo, "t3"));
  expect(() => machine.removeWorktree(repo, "t3")).toThrow(/locked/);
  expect(existsSync(join(wt(repo, "t3"), "node_modules", "k.js"))).toBe(true);
  machine.removeWorktree(repo, "t3", true);
  expect(existsSync(wt(repo, "t3"))).toBe(false);
});
