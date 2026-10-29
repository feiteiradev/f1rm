// Archive, then remove: `f1rm letgo` keeps unfinished work under refs/f1rm/archive/<task> before it removes a worktree and its branch. Real temp git repos throughout.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine } from "../server/machine.ts";
import { pausedDirOf, pausedFile, writePaused } from "../server/pause.ts";
import { archiveWork, archivesIn, listArchives, pruneArchives } from "./archive.ts";
import { letgo } from "./letgo.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-archive-")));
  made.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const wt = (repo: string, task: string) => join(repo, ".claude", "worktrees", task);
const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
const refs = (repo: string) => git(repo, "for-each-ref", "--format=%(refname)", "refs/f1rm/archive/").split("\n").filter(Boolean).sort();

/** A repo on main with one commit and a worktree per task, each on its own branch `worktree-<task>`. */
function repoWith(...tasks: string[]) {
  const repo = tmp();
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "start");
  for (const task of tasks) git(repo, "worktree", "add", "-b", `worktree-${task}`, wt(repo, task));
  return repo;
}
/** The worktree `work` has a committed change main lacks, an edited tracked file, an untracked file and a staged one. */
function unfinished(repo: string, task: string) {
  const dir = wt(repo, task);
  writeFileSync(join(dir, "feature.txt"), "committed\n");
  git(dir, "add", "feature.txt");
  git(dir, "commit", "-m", "feature");
  writeFileSync(join(dir, "base.txt"), "edited\n");
  writeFileSync(join(dir, "scratch.txt"), "untracked\n");
  writeFileSync(join(dir, "staged.txt"), "staged\n");
  git(dir, "add", "staged.txt");
  return git(dir, "rev-parse", "HEAD");
}

test("archiveWork keeps a worktree's committed, edited, staged and untracked work under refs/f1rm/archive/<task>, and touches nothing", () => {
  const repo = repoWith("work");
  const tip = unfinished(repo, "work");
  const statusBefore = git(wt(repo, "work"), "status", "--porcelain");
  const a = archiveWork(repo, "work")!;
  expect(a.ref).toBe("refs/f1rm/archive/work");
  expect(git(repo, "rev-parse", a.ref)).toBe(a.sha);
  expect(git(repo, "log", "-1", "--format=%s", a.sha)).toMatch(/^wip: work/);
  expect(git(repo, "show", `${a.ref}:base.txt`)).toBe("edited");
  expect(git(repo, "show", `${a.ref}:scratch.txt`)).toBe("untracked");
  expect(git(repo, "show", `${a.ref}:staged.txt`)).toBe("staged");
  expect(git(repo, "show", `${a.ref}:feature.txt`)).toBe("committed");
  expect(git(repo, "merge-base", "--is-ancestor", tip, a.ref)).toBe(""); // the unmerged tip is reachable
  expect(git(wt(repo, "work"), "status", "--porcelain")).toBe(statusBefore);
  expect(git(repo, "rev-parse", "worktree-work")).toBe(tip);
  expect(existsSync(join(wt(repo, "work"), "scratch.txt"))).toBe(true);
  expect(a.files).toBe(3); // the committed file is the unmerged tip's, not the wip commit's
});

test("archiveWork keeps a clean worktree's unmerged commits, and nothing of a merged, clean or junk-only one", () => {
  const repo = repoWith("open", "merged", "junky");
  writeFileSync(join(wt(repo, "open"), "x.txt"), "x\n");
  git(wt(repo, "open"), "add", "x.txt");
  git(wt(repo, "open"), "commit", "-m", "x");
  const tip = git(wt(repo, "open"), "rev-parse", "HEAD");
  writeFileSync(join(wt(repo, "merged"), "m.txt"), "m\n");
  git(wt(repo, "merged"), "add", "m.txt");
  git(wt(repo, "merged"), "commit", "-m", "m");
  git(repo, "merge", "--no-ff", "-m", "merge m", "worktree-merged");
  const junky = wt(repo, "junky");
  writeFileSync(join(junky, ".DS_Store"), "x");
  mkdirSync(join(junky, ".impeccable", "live"), { recursive: true });
  writeFileSync(join(junky, ".impeccable", "live", "state.json"), "{}");
  mkdirSync(join(junky, ".claude"), { recursive: true });
  writeFileSync(join(junky, ".claude", "settings.local.json"), "{}");
  symlinkSync(join(repo, "node_modules"), join(junky, "node_modules"));
  mkdirSync(join(junky, "pkg", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(junky, "pkg", "node_modules", "dep", "i.js"), "1");
  writeFileSync(join(junky, ".impeccable", "hook.cache.json"), "{}");
  writeFileSync(join(repo, ".git", "info", "exclude"), ".claude/settings.local.json\n.impeccable/hook.cache.json\n"); // a gitignore that names a junk file too
  writeFileSync(join(junky, "base.txt.swp"), "swap");
  writeFileSync(join(junky, "base.txt~"), "backup");
  expect(archiveWork(repo, "merged")).toBeNull();
  expect(archiveWork(repo, "junky")).toBeNull();
  const a = archiveWork(repo, "open")!;
  expect(git(repo, "merge-base", "--is-ancestor", tip, a.ref)).toBe("");
  expect(git(repo, "show", `${a.ref}:x.txt`)).toBe("x");
  expect(refs(repo)).toEqual(["refs/f1rm/archive/open"]);
});

test("archiveWork keeps junk out of a snapshot that has real work next to it", () => {
  const repo = repoWith("mixed");
  const dir = wt(repo, "mixed");
  writeFileSync(join(dir, "real.txt"), "real\n");
  writeFileSync(join(dir, ".DS_Store"), "x");
  mkdirSync(join(dir, ".impeccable", "review"), { recursive: true });
  writeFileSync(join(dir, ".impeccable", "review", "desktop.png"), "png");
  writeFileSync(join(dir, ".impeccable", "config.json"), "{}");
  mkdirSync(join(dir, ".claude", "skills", "foo"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "foo", "SKILL.md"), "skill");
  writeFileSync(join(dir, ".claude", "settings.local.json"), "{}");
  const a = archiveWork(repo, "mixed")!;
  expect(git(repo, "ls-tree", "-r", "--name-only", a.ref).split("\n")).toEqual([".claude/skills/foo/SKILL.md", ".impeccable/config.json", "base.txt", "real.txt"]);
});

test("a second archive of a task keeps the first under <task>-1", () => {
  const repo = repoWith("again");
  writeFileSync(join(wt(repo, "again"), "one.txt"), "1\n");
  const first = archiveWork(repo, "again")!;
  writeFileSync(join(wt(repo, "again"), "two.txt"), "2\n");
  const second = archiveWork(repo, "again")!;
  expect(second.ref).toBe("refs/f1rm/archive/again");
  expect(git(repo, "rev-parse", "refs/f1rm/archive/again")).toBe(second.sha);
  expect(git(repo, "rev-parse", "refs/f1rm/archive/again-1")).toBe(first.sha);
  expect(first.sha).not.toBe(second.sha);
  writeFileSync(join(wt(repo, "again"), "three.txt"), "3\n");
  archiveWork(repo, "again");
  expect(refs(repo)).toEqual(["refs/f1rm/archive/again", "refs/f1rm/archive/again-1", "refs/f1rm/archive/again-2"]);
});

test("archiving the same work again (a retried let-go) keeps the archive it has instead of piling up copies", () => {
  const repo = repoWith("retry");
  writeFileSync(join(wt(repo, "retry"), "a.txt"), "a\n");
  const first = archiveWork(repo, "retry")!;
  const again = archiveWork(repo, "retry")!;
  expect(again.sha).toBe(first.sha);
  expect(refs(repo)).toEqual(["refs/f1rm/archive/retry"]);
});

test("archiveWork throws when it cannot write the ref, and for a task that is no ref name", () => {
  const repo = repoWith("clash");
  writeFileSync(join(wt(repo, "clash"), "a.txt"), "a\n");
  git(repo, "update-ref", "refs/f1rm/archive/clash/inner", "HEAD"); // a ref cannot be a folder and a file
  expect(() => archiveWork(repo, "clash")).toThrow();
  expect(() => archiveWork(repo, "../x")).toThrow(/no task name/);
});

const oldCommit = (repo: string, task: string, daysAgo: number, now: number) => {
  const date = `${Math.floor(now / 1000) - daysAgo * 86400} +0000`;
  const sha = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", `wip: ${task}`], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).stdout.toString().trim();
  git(repo, "update-ref", `refs/f1rm/archive/${task}`, sha);
};

test("archives lists each archive with its task, date and size, and --prune deletes only those older than 30 days and prints them", () => {
  const repo = repoWith();
  const now = Date.UTC(2026, 9, 29, 12);
  oldCommit(repo, "ancient", 45, now);
  oldCommit(repo, "stale", 31, now);
  oldCommit(repo, "recent", 29, now);
  oldCommit(repo, "today", 0, now);
  expect(listArchives(repo).map((a) => a.task)).toEqual(["ancient", "recent", "stale", "today"]);
  const listed = archivesIn([], { gitCommonDir: () => join(repo, ".git") }, repo, now);
  expect(listed.code).toBe(0);
  expect(listed.out).toContain("recent");
  expect(listed.out).toContain("2026-09-30");
  expect(listed.out).toMatch(/today\s+2026-10-29\s+0 files/);
  const pruned = archivesIn(["--prune"], { gitCommonDir: () => join(repo, ".git") }, repo, now);
  expect(pruned.out).toContain("pruned ancient");
  expect(pruned.out).toContain("pruned stale");
  expect(pruned.out).not.toContain("recent");
  expect(refs(repo)).toEqual(["refs/f1rm/archive/recent", "refs/f1rm/archive/today"]);
  expect(pruneArchives(repo, now)).toEqual([]);
});

test("archives prints a line when there are none, and refuses a flag it does not know", () => {
  const repo = repoWith();
  const m = { gitCommonDir: () => join(repo, ".git") };
  expect(archivesIn([], m, repo, Date.now()).out).toBe("no archives\n");
  expect(archivesIn(["--nope"], m, repo, Date.now()).code).toBe(1);
});

// letgo over a fake claude (the sessions it lists, stop and rm) with the real repo, so the archive and the removal are real git.
function fakeClaude(sessions: { id: string; name: string; kind?: string; state?: string; cwd: string; pid?: number }[], onStop: (cwd: string) => void = () => {}) {
  const live = sessions.map((s) => ({ kind: "background", state: "done", ...s }));
  const calls: string[] = [];
  const stops: string[] = [];
  const opts: unknown[] = [];
  const worktreeAtRm: boolean[] = [];
  return {
    calls,
    stops,
    opts,
    worktreeAtRm,
    sessions: async () => live.slice(),
    // As machine.letGo: stop, then afterStop, then rm.
    letGo: async (id: string, o?: { discardIn?: string; discardAny?: boolean; afterStop?: () => void | Promise<void> }) => {
      const s = live.find((x) => x.id === id)!;
      stops.push(id);
      onStop(s.cwd);
      await o?.afterStop?.();
      worktreeAtRm.push(existsSync(s.cwd));
      calls.push(`letgo ${id}`);
      opts.push(o && { discardIn: o.discardIn, discardAny: o.discardAny });
      live.splice(live.indexOf(s), 1);
    },
    gitCommonDir: machine.gitCommonDir,
    removeWorktree: machine.removeWorktree,
  };
}

test("letgo archives a hire's unmerged and uncommitted work, then removes its worktree and branch with no refusal", async () => {
  const repo = repoWith("work");
  const tip = unfinished(repo, "work");
  const fake = fakeClaude([{ id: "a1", name: "backend-dev-work", cwd: wt(repo, "work") }]);
  const r = await letgo(["backend-dev-work"], fake, repo);
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual(["backend-dev-work: let go, archived its work as refs/f1rm/archive/work (3 files), removed its worktree and branch worktree-work"]);
  expect(fake.calls).toEqual(["letgo a1"]);
  expect(fake.opts).toEqual([{ discardIn: repo, discardAny: true }]); // claude rm may discard what is archived
  expect(existsSync(wt(repo, "work"))).toBe(false);
  expect(branches(repo)).toEqual(["main"]);
  expect(git(repo, "show", "refs/f1rm/archive/work:scratch.txt")).toBe("untracked");
  expect(git(repo, "merge-base", "--is-ancestor", tip, "refs/f1rm/archive/work")).toBe("");
});

test("letgo of a hire with nothing but junk archives nothing, and a merged clean one just goes", async () => {
  const repo = repoWith("junky");
  writeFileSync(join(wt(repo, "junky"), ".DS_Store"), "x");
  const fake = fakeClaude([{ id: "j1", name: "backend-dev-junky", cwd: wt(repo, "junky") }]);
  const r = await letgo(["backend-dev-junky"], fake, repo);
  expect(r.lines).toEqual(["backend-dev-junky: let go, removed its worktree and branch worktree-junky"]);
  expect(refs(repo)).toEqual([]);
  expect(existsSync(wt(repo, "junky"))).toBe(false);
  expect(branches(repo)).toEqual(["main"]);
});

test("letgo whose archive fails lets nobody go and removes nothing", async () => {
  const repo = repoWith("clash");
  writeFileSync(join(wt(repo, "clash"), "a.txt"), "a\n");
  git(repo, "update-ref", "refs/f1rm/archive/clash/inner", "HEAD");
  const fake = fakeClaude([{ id: "c1", name: "backend-dev-clash", cwd: wt(repo, "clash") }]);
  const r = await letgo(["backend-dev-clash"], fake, repo);
  expect(r.ok).toBe(false);
  expect(r.lines[0]).toMatch(/^backend-dev-clash: not let go: could not archive its work \(the session is stopped\): /);
  expect(fake.stops).toEqual(["c1"]); // stopped first, so nothing more is written, but not removed
  expect(fake.calls).toEqual([]);
  expect(existsSync(join(wt(repo, "clash"), "a.txt"))).toBe(true);
  expect(branches(repo)).toEqual(["main", "worktree-clash"]);
});

test("letgo of a reused name archives once, before the first session goes, and removes once, after the last", async () => {
  const repo = repoWith("twice");
  writeFileSync(join(wt(repo, "twice"), "a.txt"), "a\n");
  const fake = fakeClaude([
    { id: "t1", name: "backend-dev-twice", cwd: wt(repo, "twice"), state: "stopped" },
    { id: "t2", name: "backend-dev-twice", cwd: wt(repo, "twice") },
  ]);
  const r = await letgo(["backend-dev-twice"], fake, repo);
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual(["backend-dev-twice: let go, archived its work as refs/f1rm/archive/twice (1 file)", "backend-dev-twice: let go, removed its worktree and branch worktree-twice"]);
  expect(refs(repo)).toEqual(["refs/f1rm/archive/twice"]);
});

test("letgo --leftovers archives and removes every worktree and worktree-* branch no live session works in, lists the live ones, and never runs claude rm", async () => {
  const repo = repoWith("busy", "dead", "clean");
  writeFileSync(join(wt(repo, "busy"), "busy.txt"), "b\n");
  writeFileSync(join(wt(repo, "dead"), "dead.txt"), "d\n");
  git(repo, "branch", "worktree-orphan", "main"); // a branch whose worktree is gone, with a commit main lacks
  git(repo, "worktree", "add", join(repo, ".claude", "worktrees", "tmp-orphan"), "worktree-orphan");
  writeFileSync(join(wt(repo, "tmp-orphan"), "o.txt"), "o\n");
  git(wt(repo, "tmp-orphan"), "add", "o.txt");
  git(wt(repo, "tmp-orphan"), "commit", "-m", "o");
  git(repo, "worktree", "remove", "--force", wt(repo, "tmp-orphan"));
  git(repo, "branch", "elsewhere"); // not ours
  const fake = fakeClaude([
    { id: "b1", name: "backend-dev-busy", cwd: wt(repo, "busy"), state: "working", pid: 4242 },
    { id: "d1", name: "backend-dev-dead", cwd: wt(repo, "dead"), state: "done" },
  ]);
  const r = await letgo(["--leftovers"], fake, repo, tmp());
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual([
    "busy: session backend-dev-busy (working) works in it, skipped",
    "clean: removed its worktree and branch worktree-clean",
    "dead: archived its work as refs/f1rm/archive/dead (1 file), removed its worktree and branch worktree-dead",
    "orphan: archived its work as refs/f1rm/archive/orphan (0 files), removed its worktree and branch worktree-orphan",
  ]);
  expect(fake.calls).toEqual([]);
  expect(existsSync(wt(repo, "busy"))).toBe(true);
  expect(existsSync(wt(repo, "dead"))).toBe(false);
  expect(branches(repo)).toEqual(["elsewhere", "main", "worktree-busy"]);
  expect(refs(repo)).toEqual(["refs/f1rm/archive/dead", "refs/f1rm/archive/orphan"]);
  expect(git(repo, "show", "refs/f1rm/archive/dead:dead.txt")).toBe("d");
});

test("letgo --leftovers takes no names, and fails and removes nothing of a task whose archive fails", async () => {
  const repo = repoWith("clash");
  writeFileSync(join(wt(repo, "clash"), "a.txt"), "a\n");
  git(repo, "update-ref", "refs/f1rm/archive/clash/inner", "HEAD");
  const fake = fakeClaude([]);
  const r = await letgo(["--leftovers"], fake, repo, tmp());
  expect(r.ok).toBe(false);
  expect(r.lines[0]).toMatch(/^clash: not removed: could not archive its work: /);
  expect(existsSync(join(wt(repo, "clash"), "a.txt"))).toBe(true);
  expect(branches(repo)).toEqual(["main", "worktree-clash"]);
  await expect(letgo(["--leftovers", "backend-dev-x"], fake, repo)).rejects.toThrow(/--leftovers/);
});

test("archiveWork keeps edits and deletions of TRACKED files under junk paths: only untracked junk is left out", () => {
  const repo = tmp();
  git(repo, "init", "-b", "main");
  for (const [f, c] of [["base.txt", "base"], [".claude/settings.json", "{}"], [".impeccable/config.json", "{}"], ["notes~", "n"], ["vendor/node_modules/x.js", "1"], [".DS_Store", "d"], ["gone.swp", "g"]] as const) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  git(repo, "add", "-f", ".");
  git(repo, "commit", "-m", "start");
  git(repo, "worktree", "add", "-b", "worktree-tracked", wt(repo, "tracked"));
  const dir = wt(repo, "tracked");
  for (const f of [".claude/settings.json", ".impeccable/config.json", "notes~", "vendor/node_modules/x.js", ".DS_Store"]) writeFileSync(join(dir, f), "edited");
  rmSync(join(dir, "gone.swp"));
  writeFileSync(join(dir, "other.swp"), "untracked junk");
  const a = archiveWork(repo, "tracked")!;
  for (const f of [".claude/settings.json", ".impeccable/config.json", "notes~", "vendor/node_modules/x.js", ".DS_Store"]) expect([f, git(repo, "show", `${a.ref}:${f}`)]).toEqual([f, "edited"]);
  const kept = git(repo, "ls-tree", "-r", "--name-only", a.ref);
  expect(kept).not.toContain("gone.swp");
  expect(kept).not.toContain("other.swp");
});

test("archiveWork also keeps the branch tip when the worktree's HEAD is another branch, since the branch is deleted", () => {
  const repo = repoWith("moved");
  const dir = wt(repo, "moved");
  git(dir, "checkout", "-b", "other");
  writeFileSync(join(dir, "o.txt"), "o\n");
  git(dir, "add", "o.txt");
  git(dir, "commit", "-m", "on other");
  const tip = git(repo, "commit-tree", "main^{tree}", "-p", "main", "-m", "on the task branch");
  git(repo, "branch", "-f", "worktree-moved", tip);
  const a = archiveWork(repo, "moved")!;
  expect(git(repo, "merge-base", "--is-ancestor", tip, a.ref)).toBe("");
  expect(git(repo, "merge-base", "--is-ancestor", "other", a.ref)).toBe("");
});

test("archiveWork refuses a worktree with a repository inside it: its files would be lost as an empty gitlink", () => {
  const repo = repoWith("nested");
  const inner = join(wt(repo, "nested"), "inner");
  mkdirSync(inner);
  git(inner, "init", "-b", "main");
  writeFileSync(join(inner, "f.txt"), "f");
  git(inner, "add", "f.txt");
  git(inner, "commit", "-m", "inner");
  expect(() => archiveWork(repo, "nested")).toThrow(/repository inside it: inner/);
  expect(refs(repo)).toEqual([]);
});

test("pruneArchives skips a ref whose date it cannot read, and the archive of a task whose worktree still exists", () => {
  const repo = repoWith("alive");
  const now = Date.UTC(2026, 9, 29, 12);
  oldCommit(repo, "alive", 45, now);
  oldCommit(repo, "gone", 45, now);
  git(repo, "update-ref", "refs/f1rm/archive/weird", git(repo, "rev-parse", "HEAD^{tree}")); // a ref with no commit date
  expect(pruneArchives(repo, now).map((a) => a.task)).toEqual(["gone"]);
  expect(refs(repo)).toEqual(["refs/f1rm/archive/alive", "refs/f1rm/archive/weird"]);
});

test("letgo stops the session first and archives after, so what it writes while stopping is kept; git removes the worktree before claude rm", async () => {
  const repo = repoWith("late");
  const fake = fakeClaude([{ id: "l1", name: "backend-dev-late", cwd: wt(repo, "late") }], (cwd) => writeFileSync(join(cwd, "late.txt"), "written as it stopped\n"));
  const r = await letgo(["backend-dev-late"], fake, repo);
  expect(r.ok).toBe(true);
  expect(git(repo, "show", "refs/f1rm/archive/late:late.txt")).toBe("written as it stopped");
  expect(fake.worktreeAtRm).toEqual([false]); // claude rm meets no worktree, so there is nothing for it to refuse
  expect(branches(repo)).toEqual(["main"]);
});

test("letgo --leftovers skips every worktree with a session that is not done (stopped, blocked, failed, running, through a linked path too), and removes the one whose sessions are done", async () => {
  const tasks = ["paused", "limit", "failed", "linked", "finished"];
  const repo = repoWith(...tasks);
  for (const t of tasks) writeFileSync(join(wt(repo, t), "w.txt"), t);
  const link = join(tmp(), "link");
  symlinkSync(repo, link);
  const fake = fakeClaude([
    { id: "p1", name: "backend-dev-paused", cwd: wt(repo, "paused"), state: "stopped" },
    { id: "b1", name: "backend-dev-limit", cwd: wt(repo, "limit"), state: "blocked" },
    { id: "f1", name: "backend-dev-failed", cwd: wt(repo, "failed"), state: "failed" },
    { id: "k1", name: "backend-dev-linked", cwd: join(link, ".claude", "worktrees", "linked"), state: "working", pid: 7 },
    { id: "d1", name: "backend-dev-finished", cwd: wt(repo, "finished"), state: "done" },
  ]);
  const r = await letgo(["--leftovers"], fake, repo, tmp());
  expect(r.lines.map((l) => `${l.split(":")[0]} ${l.includes("skipped") ? "skipped" : "removed"}`)).toEqual(["failed skipped", "finished removed", "limit skipped", "linked skipped", "paused skipped"]);
  expect(branches(repo)).toEqual(["main", "worktree-failed", "worktree-limit", "worktree-linked", "worktree-paused"]);
});

test("letgo --leftovers refuses while the project is paused", async () => {
  const repo = repoWith("held");
  const home = tmp();
  writePaused(pausedFile(pausedDirOf(home), repo), { by: "manual", at: Date.now(), why: "lunch" });
  await expect(letgo(["--leftovers"], fakeClaude([]), repo, home)).rejects.toThrow(/is paused/);
  expect(existsSync(wt(repo, "held"))).toBe(true);
});
