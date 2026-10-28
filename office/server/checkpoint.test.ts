// Seam: the checkpoint's git snapshot and manifest, on a real temp repo with a real worktree.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointDirOf, checkpointsDirOf, latestManifest, newCheckpointId, readManifest, snapshotWorktree, worktreesOf, writeManifest, type Manifest } from "./checkpoint.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-checkpoint-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

/** Every file of a folder tree (paths and bytes), the .git file or folder aside. */
function bytes(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, bytes(p, base));
    else out[p.slice(base.length)] = createHash("sha1").update(readFileSync(p)).digest("hex");
  }
  return out;
}

function repoWithWorktree() {
  const repo = join(root, `shop-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const wt = join(repo, ".claude", "worktrees", "checkout");
  git(repo, "worktree", "add", "-q", "-b", "worktree-checkout", wt, "main");
  return { repo, wt };
}

test("the snapshot holds the uncommitted, staged and untracked work of a worktree, and leaves its files, index and branch exactly as they were", () => {
  const { repo, wt } = repoWithWorktree();
  writeFileSync(join(wt, "a.txt"), "one, edited\n"); // unstaged edit
  writeFileSync(join(wt, "b.txt"), "two, staged\n");
  git(wt, "add", "b.txt"); // staged edit
  writeFileSync(join(wt, "new.txt"), "untracked\n");
  mkdirSync(join(wt, "node_modules"));
  writeFileSync(join(wt, "node_modules", "junk.js"), "ignored\n");
  const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
  const before = { files: bytes(wt), index: readFileSync(join(gitDir, "index")).toString("hex"), head: git(wt, "rev-parse", "HEAD"), branch: git(repo, "rev-parse", "refs/heads/worktree-checkout"), status: git(wt, "status", "--porcelain"), mtime: statSync(join(wt, "a.txt")).mtimeMs };

  const snap = snapshotWorktree(wt, "checkout");

  expect(snap).toMatchObject({ ref: "refs/f1rm/checkpoint/checkout", dirty: true });
  expect(git(repo, "rev-parse", snap!.ref)).toBe(snap!.sha);
  expect(git(repo, "show", `${snap!.sha}:a.txt`)).toBe("one, edited");
  expect(git(repo, "show", `${snap!.sha}:b.txt`)).toBe("two, staged");
  expect(git(repo, "show", `${snap!.sha}:new.txt`)).toBe("untracked");
  expect(git(repo, "ls-tree", "-r", "--name-only", snap!.sha)).not.toContain("node_modules");
  expect(git(repo, "rev-parse", `${snap!.sha}^`)).toBe(before.head); // on top of the branch's tip, so the work is one commit away from it

  expect(bytes(wt)).toEqual(before.files);
  expect(readFileSync(join(gitDir, "index")).toString("hex")).toBe(before.index);
  expect(git(wt, "rev-parse", "HEAD")).toBe(before.head);
  expect(git(repo, "rev-parse", "refs/heads/worktree-checkout")).toBe(before.branch);
  expect(git(wt, "status", "--porcelain")).toBe(before.status);
  expect(statSync(join(wt, "a.txt")).mtimeMs).toBe(before.mtime);
});

test("a clean worktree is recorded at its own tip: nothing to save, the ref still names the task", () => {
  const { repo, wt } = repoWithWorktree();
  const snap = snapshotWorktree(wt, "checkout");
  expect(snap).toMatchObject({ dirty: false, sha: git(repo, "rev-parse", "HEAD") });
  expect(git(repo, "rev-parse", "refs/f1rm/checkpoint/checkout")).toBe(snap!.sha);
});

test("the worktrees of a repo are the ones listed under .claude/worktrees", () => {
  const { repo, wt } = repoWithWorktree();
  git(repo, "worktree", "add", "-q", "-b", "elsewhere", join(root, `outside-${Math.random().toString(36).slice(2)}`), "main");
  expect(worktreesOf(repo)).toEqual([wt]);
  expect(worktreesOf(join(root, "nope"))).toEqual([]);
});

test("a folder that is no worktree gives no snapshot, and a task name that is no ref is refused", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  expect(snapshotWorktree(plain, "plain")).toBeNull();
  const { wt } = repoWithWorktree();
  expect(() => snapshotWorktree(wt, "../escape")).toThrow();
});

test("a manifest is kept per project under the home, the latest one named by a small file, and each checkpoint has an id the PM can quote", () => {
  const home = join(root, "home");
  const dir = checkpointDirOf(checkpointsDirOf(home), "/code/shop/.git");
  expect(dir).toBe(join(home, ".f1rm", "checkpoints", "-code-shop"));
  expect(latestManifest(dir)).toBeNull();
  const id1 = newCheckpointId(Date.UTC(2026, 9, 28, 15, 30, 12), dir);
  expect(id1).toBe("cp-20261028-153012");
  const m: Manifest = { id: id1, at: 1, repo: "/code/shop", why: "", verified: true, sessions: [{ name: "checkout.dev-x", role: "specialist", task: "x", row: null, sessionId: "sid_1", cwd: "/code/shop/.claude/worktrees/x", snapshot: null }], killed: [] };
  writeManifest(dir, m);
  expect(readManifest(dir, id1)).toEqual(m);
  expect(latestManifest(dir)).toEqual(m);
  expect(newCheckpointId(Date.UTC(2026, 9, 28, 15, 30, 12), dir)).toBe("cp-20261028-153012-2"); // same second: still a new id
  const m2 = { ...m, id: "cp-20261028-153012-2" };
  writeManifest(dir, m2);
  expect(latestManifest(dir)?.id).toBe("cp-20261028-153012-2");
  expect(readManifest(dir, "../etc/passwd")).toBeNull();
});
