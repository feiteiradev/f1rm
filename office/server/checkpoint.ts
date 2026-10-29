// The checkpoint a pause takes: what each session was doing and a snapshot of each worktree's work, kept by the office so a fresh PM can resume everyone.
// Snapshots are git commits under refs/f1rm/checkpoint/<task> built in a temporary index: the worktree's files, its index and its branch are never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKey, type BoardRow } from "./board.ts";
import type { Killed } from "./fullstop.ts";
import { NOTE_PAUSE } from "./recovery.ts";

export type Snapshot = { ref: string; sha: string; dirty: boolean };
/** One session as the pause found it. `snapshot` is its worktree's, null for a session that works in the repo itself (a lead, a Reviewer). */
export type CheckSession = { name: string; role: string; task: string; row: BoardRow | null; sessionId: string; cwd: string; snapshot: Snapshot | null };
export type Manifest = { id: string; at: number; repo: string; why: string; sessions: CheckSession[]; killed: Pick<Killed, "pid" | "command" | "cwd" | "signal">[]; verified: boolean; unsaved?: string[] };

export const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID = /^cp-\d{8}-\d{6}(?:-\d+)?$/;

export const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=f1rm", "-c", "user.email=f1rm@localhost", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return r.success ? r.stdout.toString().trim() : null;
};

/**
 * The tree of the worktree at `dir` as it is: HEAD plus uncommitted, staged and untracked files (ignored ones are not, nor the globs in `exclude`), built in a temporary index.
 * `dirty` says the tree differs from HEAD's. Null when `dir` is no worktree with a commit.
 * ponytail: synchronous git, so a very big worktree holds the office's event loop for as long as `git add -A` takes; make it async if that is felt.
 */
export function snapshotTree(dir: string, exclude: string[] = []): { head: string; tree: string; dirty: boolean } | null {
  const head = git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head) return null;
  const scratch = mkdtempSync(join(tmpdir(), "f1rm-checkpoint-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (git(dir, ["read-tree", "HEAD"], env) === null || git(dir, ["add", "-A", "--", ".", ...exclude.map((g) => `:(exclude,glob)${g}`)], env) === null) return null;
    const tree = git(dir, ["write-tree"], env);
    return tree ? { head, tree, dirty: tree !== git(dir, ["rev-parse", "HEAD^{tree}"]) } : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Saves the worktree at `dir`, uncommitted, staged and untracked files included (ignored ones are not), as a commit on top of its HEAD under `refs/f1rm/checkpoint/<task>`.
 * A clean worktree is recorded at its own tip. Null when `dir` is no worktree with a commit. Throws for a task that is no ref name.
 */
export function snapshotWorktree(dir: string, task: string): Snapshot | null {
  if (!TASK.test(task) || task.includes("..")) throw new Error(`"${task}" is no task name`);
  const snap = snapshotTree(dir);
  if (!snap) return null;
  const ref = `refs/f1rm/checkpoint/${task}`;
  const sha = snap.dirty ? git(dir, ["commit-tree", snap.tree, "-p", snap.head, "-m", `f1rm checkpoint of ${task}`]) : snap.head;
  if (!sha || git(dir, ["update-ref", ref, sha]) === null) return null;
  return { ref, sha, dirty: snap.dirty };
}

/** `~/.f1rm/checkpoints`, where the office keeps the manifests: one folder per project. */
export const checkpointsDirOf = (home: string) => join(home, ".f1rm", "checkpoints");
export const checkpointDirOf = (checkpointsDir: string, roomId: string) => join(checkpointsDir, repoKey(roomId));

/** The worktrees git lists under `<repo>/.claude/worktrees` (real paths), none when the repo is gone. */
export function worktreesOf(repo: string): string[] {
  if (!existsSync(repo)) return [];
  const out = git(repo, ["worktree", "list", "--porcelain"]) ?? "";
  const root = join(realpathSync(repo), ".claude", "worktrees") + "/";
  return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).filter((p) => p.startsWith(root) && existsSync(p)).map((p) => realpathSync(p));
}

/** `cp-<date>-<time>` in UTC, with a counter when the same second already has one. */
export function newCheckpointId(at: number, dir: string): string {
  const base = `cp-${new Date(at).toISOString().replace(/[-:]/g, "").replace(/^(\d{8})T(\d{6}).*$/, "$1-$2")}`;
  let id = base;
  for (let n = 2; existsSync(join(dir, `${id}.json`)); n++) id = `${base}-${n}`;
  return id;
}

/** Writes the manifest through a temp file and points `latest` at it. */
export function writeManifest(dir: string, m: Manifest) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${m.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  writeFileSync(join(dir, "latest.tmp"), m.id + "\n", { mode: 0o600 });
  renameSync(join(dir, "latest.tmp"), join(dir, "latest"));
}

/** The manifest with this id, or null: no such file, a cut one, or an id that is not one of ours (it becomes a file name). */
export function readManifest(dir: string, id: string): Manifest | null {
  if (!ID.test(id)) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    return m?.id === id && Array.isArray(m.sessions) ? m : null;
  } catch {
    return null;
  }
}

export function latestManifest(dir: string): Manifest | null {
  try {
    return readManifest(dir, readFileSync(join(dir, "latest"), "utf8").trim());
  } catch {
    return null;
  }
}

/** The note a resume gives a session: the pause is over, and where it stopped (its task, board row, and the snapshot of its worktree when it had uncommitted work). */
export function whereItStopped(s: CheckSession, id: string): string {
  const row = s.row ? `, board row ${s.row.id} (${s.row.status}, branch ${s.row.branch})` : "";
  const work = s.snapshot?.dirty ? `; your uncommitted work is saved as ${s.snapshot.ref} (${s.snapshot.sha.slice(0, 7)}), and your files are as you left them` : "";
  return `${NOTE_PAUSE} You stopped at checkpoint ${id}: your task ${s.task}${row}${work}.`;
}
