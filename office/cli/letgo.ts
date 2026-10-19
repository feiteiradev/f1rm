// `f1rm letgo`, and the office's safety net: let a finished hire go, and clean up the worktree and branch it leaves once they are merged.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { readRoles, SLUG } from "./hire.ts";
import type { machine, Session } from "../server/machine.ts";

type M = Pick<typeof machine, "gitCommonDir" | "letGo" | "mergedBranch" | "removeWorktree" | "sessions">;

const SLUG_SRC = SLUG.source.slice(1, -1);
const NOT_LET_GO = "not let go:";
let nameRe: RegExp | undefined;

/**
 * The task a hire's name carries (`<role>-<task>`, `<team>.<role>-<task>`), or null for a lead or any other name. A Reviewer is
 * named `reviewer-review-<task>`; its task is the one it reviews, and it has no branch or worktree of its own.
 */
export function hireTask(name: string): { task: string; reviewer: boolean } | null {
  nameRe ??= new RegExp(`^(?:${SLUG_SRC}\\.)?(${readRoles().map((r) => r.id).filter((id) => id !== "lead").join("|")})-(${SLUG_SRC})$`);
  const m = nameRe.exec(name);
  if (!m) return null;
  const reviewer = m[1] === "reviewer";
  return { task: reviewer ? m[2].replace(/^review-/, "") : m[2], reviewer };
}

/** The repo's main working directory a session belongs to: its own folder, or the folder above `.claude/worktrees`. */
export const repoOf = (cwd: string) => cwd.split("/.claude/worktrees/")[0];

/** Lets a session go, then removes its worktree and branch if the branch is merged into the base. Throws if it can't be let go or cleaned up. */
export async function letGoHire(m: Pick<M, "letGo" | "mergedBranch" | "removeWorktree">, s: Session, repo: string, clean = true): Promise<string> {
  const hire = hireTask(s.name);
  const task = hire && !hire.reviewer ? hire.task : null;
  // A Reviewer works in the main checkout and a lead has no branch: nothing of theirs to keep.
  if (!task) {
    await m.letGo(s.id);
    return `${s.name}: let go`;
  }
  const branch = `worktree-${task}`;
  // Decided before anything is stopped: unlanded work (a hire waiting after BLOCKED too) is never lost, and neither are uncommitted files.
  if (!m.mergedBranch(repo, branch)) return `${s.name}: ${NOT_LET_GO} ${branch} is not merged into the base branch`;
  const wt = `${repo}/.claude/worktrees/${task}`;
  if (existsSync(wt) && Bun.spawnSync(["git", "-C", wt, "status", "--porcelain"]).stdout.toString().trim()) return `${s.name}: ${NOT_LET_GO} its worktree has uncommitted files`;
  // Merged work is already in the base, so `claude rm` may discard the worktree's copy of it (see machine.letGo).
  await m.letGo(s.id, { discardIn: repo });
  if (!clean) return `${s.name}: let go`; // another session of this name is still to go: the worktree and branch are removed after it
  try {
    m.removeWorktree(repo, task);
  } catch (err) {
    // ponytail: git refuses a worktree with uncommitted files and it is never forced; the person decides what to do with them.
    return `${s.name}: let go, kept ${branch} and its worktree: ${(err as Error).message}`;
  }
  return `${s.name}: let go, removed its worktree and branch ${branch}`;
}

/** Runs `f1rm letgo <name>...` in `cwd`: one line per name, and `ok` false if any name wasn't found or couldn't be let go. */
export async function letgo(names: string[], m: M, cwd: string): Promise<{ lines: string[]; ok: boolean }> {
  const common = m.gitCommonDir(cwd);
  if (!common) throw new Error("not in a git repo");
  const repo = dirname(common);
  const all = await m.sessions();
  if (!all) throw new Error("can't list the sessions (`claude agents --json --all` failed)");
  const lines: string[] = [];
  let ok = true;
  for (const name of names) {
    // A name can be reused, and a finished or stale session keeps its place in the list: every session of it goes.
    const found = all.filter((a) => a.kind === "background" && a.name === name && repoOf(a.cwd) === repo);
    if (!found.length) {
      ok = false;
      lines.push(`${name}: no background session with this name in this repo`);
    }
    for (const [i, s] of found.entries()) {
      try {
        const line = await letGoHire(m, s, repo, i === found.length - 1);
        if (line.includes(`: ${NOT_LET_GO} `)) ok = false;
        lines.push(line);
      } catch (err) {
        ok = false;
        lines.push(`${name}: could not be let go: ${(err as Error).message}`);
      }
    }
  }
  return { lines, ok };
}
