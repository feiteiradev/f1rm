// Archive, then remove: before `f1rm letgo` removes a worktree and its branch it keeps whatever is unfinished under refs/f1rm/archive/<task>.
// The archive is a `wip:` commit built in a temporary index on top of the worktree's HEAD (see snapshotTree): the worktree's files, its index and its branch are never touched.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, snapshotTree, TASK } from "../server/checkpoint.ts";

export type Archive = { task: string; ref: string; sha: string; at: number; files: number; bytes: number };

const PREFIX = "refs/f1rm/archive/";
const KEEP_MS = 30 * 86_400_000;

/** Tool litter that is never work: `claude`'s own folder, Impeccable's live state, Finder's file, installed packages (a symlink too), editor swap and backup files. */
export const JUNK = [".claude/**", ".impeccable/**", "**/.DS_Store", "**/node_modules", "**/node_modules/**", "**/*.swp", "**/*.swo", "**/*~", "**/.#*"];

const inBase = (repo: string, rev: string) => git(repo, ["merge-base", "--is-ancestor", rev, "HEAD"]) !== null;
const refExists = (repo: string, ref: string) => git(repo, ["rev-parse", "--verify", "-q", ref]) !== null;

/** How many files a commit changed against its parent, and their size. */
function sizeOf(repo: string, sha: string): { files: number; bytes: number } {
  const blobs = (git(repo, ["diff-tree", "-r", "--no-commit-id", "--root", sha]) ?? "").split("\n").filter(Boolean).map((l) => l.split(" ")[3]).filter((b) => b && !/^0+$/.test(b));
  const sizes = blobs.length ? Bun.spawnSync(["git", "-C", repo, "cat-file", "--batch-check=%(objectsize)"], { stdin: Buffer.from(blobs.join("\n") + "\n") }).stdout.toString().split("\n") : [];
  return { files: blobs.length, bytes: sizes.reduce((sum, n) => sum + (parseInt(n, 10) || 0), 0) };
}

const archiveOf = (repo: string, task: string, sha: string, at: number): Archive => ({ task, ref: PREFIX + task, sha, at, ...sizeOf(repo, sha) });

/**
 * Keeps the work of `<repo>/.claude/worktrees/<task>` that no other branch has: its uncommitted, staged and untracked files (junk excluded) and any commits of `worktree-<task>` the base lacks,
 * as a `wip:` commit on the tip under `refs/f1rm/archive/<task>`. An archive already there moves to `<task>-<n>`. Null when there is nothing to keep: the branch is merged and the worktree has no work but junk.
 * Throws when the work can't be read or the ref can't be written; the caller removes nothing then.
 */
export function archiveWork(repo: string, task: string): Archive | null {
  if (!TASK.test(task) || task.includes("..")) throw new Error(`"${task}" is no task name`);
  const dir = join(repo, ".claude", "worktrees", task);
  let from: { head: string; tree: string; dirty: boolean } | null = null;
  if (!existsSync(repo)) return null;
  if (existsSync(join(dir, ".git"))) {
    from = snapshotTree(dir, JUNK);
    if (!from) throw new Error(`can't read the work in ${dir}`);
  } else {
    // No worktree (or a folder that is none): the branch's own commits are what is left.
    const tip = git(repo, ["rev-parse", "--verify", "-q", `refs/heads/worktree-${task}`]);
    const tree = tip && git(repo, ["rev-parse", `${tip}^{tree}`]);
    if (tip && tree) from = { head: tip, tree, dirty: false };
  }
  if (!from || (!from.dirty && inBase(repo, from.head))) return null;
  const ref = PREFIX + task;
  const old = git(repo, ["rev-parse", "--verify", "-q", ref]);
  // The same work again (a let-go retried after `claude rm` failed) is already kept.
  if (old && git(repo, ["rev-parse", `${old}^{tree}`]) === from.tree && git(repo, ["rev-parse", `${old}^`]) === from.head) return listArchives(repo).find((a) => a.ref === ref)!;
  const sha = git(repo, ["commit-tree", from.tree, "-p", from.head, "-m", `wip: ${task}`]);
  if (!sha) throw new Error("git commit-tree failed");
  if (old) {
    let n = 1;
    while (refExists(repo, `${ref}-${n}`)) n++;
    if (git(repo, ["update-ref", `${ref}-${n}`, old]) === null) throw new Error(`can't write ${ref}-${n}`);
  }
  if (git(repo, ["update-ref", ref, sha]) === null) throw new Error(`can't write ${ref}`);
  return archiveOf(repo, task, sha, Date.now());
}

/** Every archive of the repo, by task. Its age is the commit date of its tip, which is the day it was archived. */
export function listArchives(repo: string): Archive[] {
  const out = git(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:unix)", PREFIX]) ?? "";
  return out.split("\n").filter(Boolean).map((line) => {
    const [ref, sha, at] = line.split("\t");
    return archiveOf(repo, ref.slice(PREFIX.length), sha, Number(at) * 1000);
  });
}

/** Deletes the archives older than 30 days and returns them. */
export function pruneArchives(repo: string, now: number): Archive[] {
  return listArchives(repo).filter((a) => now - a.at > KEEP_MS && git(repo, ["update-ref", "-d", a.ref]) !== null);
}

export const filesText = (a: Pick<Archive, "files">) => `${a.files} file${a.files === 1 ? "" : "s"}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `f1rm archives [--prune]`: the archives with task, date and size, or the ones it just deleted. */
export function archivesIn(args: string[], m: { gitCommonDir(cwd: string): string | null }, cwd: string, now = Date.now()): { out: string; err?: string; code: number } {
  if (args.some((a) => a !== "--prune") || args.length > 1) return { out: "", err: "usage: f1rm archives [--prune]", code: 1 };
  const common = m.gitCommonDir(cwd);
  if (!common) return { out: "", err: "not in a git repo", code: 1 };
  const repo = dirname(common);
  const shown = args.length ? pruneArchives(repo, now) : listArchives(repo);
  if (!shown.length) return { out: args.length ? "nothing to prune\n" : "no archives\n", code: 0 };
  const width = Math.max(...shown.map((a) => a.task.length));
  return { out: shown.map((a) => `${args.length ? "pruned " : ""}${a.task.padEnd(width)}  ${day(a.at)}  ${filesText(a)}, ${a.bytes} bytes\n`).join(""), code: 0 };
}
