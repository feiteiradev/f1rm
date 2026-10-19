// `f1rm letgo`, and the office's safety net: let a finished hire go, and clean up the worktree and branch it leaves once they are merged.
import { dirname } from "node:path";
import { readRoles } from "./hire.ts";
import type { machine } from "../server/machine.ts";

export type Session = { id: string; name: string; kind: string; state: string; cwd: string };
type M = Pick<typeof machine, "gitCommonDir" | "letGo" | "mergedBranch" | "removeWorktree"> & { sessions: () => Promise<Session[] | null> };

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
let nameRe: RegExp | undefined;

/**
 * The task a hire's name carries (`<role>-<task>`, `<team>.<role>-<task>`), or null for a lead or any other name. A Reviewer is
 * named `reviewer-review-<task>`; its task is the one it reviews, and it has no branch or worktree of its own.
 */
export function hireTask(name: string): { task: string; reviewer: boolean } | null {
  nameRe ??= new RegExp(`^(?:${SLUG}\\.)?(${readRoles().map((r) => r.id).filter((id) => id !== "lead").join("|")})-(${SLUG})$`);
  const m = nameRe.exec(name);
  if (!m) return null;
  const reviewer = m[1] === "reviewer";
  return { task: reviewer ? m[2].replace(/^review-/, "") : m[2], reviewer };
}

/** The repo's main working directory a session belongs to: its own folder, or the folder above `.claude/worktrees`. */
export const repoOf = (cwd: string) => cwd.split("/.claude/worktrees/")[0];

/** Lets a session go, then removes its worktree and branch if the branch is merged into the base. Throws if it can't be let go or cleaned up. */
export async function letGoHire(m: Pick<M, "letGo" | "mergedBranch" | "removeWorktree">, s: Session, repo: string): Promise<string> {
  const hire = hireTask(s.name);
  await m.letGo(s.id);
  // A Reviewer works in the main checkout and a lead has no branch: nothing of theirs to remove.
  if (!hire || hire.reviewer) return `${s.name}: let go`;
  const branch = `worktree-${hire.task}`;
  if (!m.mergedBranch(repo, branch)) return `${s.name}: let go, kept ${branch} and its worktree: not merged into the base branch`;
  try {
    m.removeWorktree(repo, hire.task);
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
    const s = all.find((a) => a.kind === "background" && a.name === name && repoOf(a.cwd) === repo);
    try {
      if (!s) throw new Error("no background session with this name in this repo");
      lines.push(await letGoHire(m, s, repo));
    } catch (err) {
      ok = false;
      lines.push(`${name}: ${s ? "could not be let go: " : ""}${(err as Error).message}`);
    }
  }
  return { lines, ok };
}
