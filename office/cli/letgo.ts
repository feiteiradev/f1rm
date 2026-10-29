// `f1rm letgo`, and the office's safety net: let a finished hire go, archive what it left unfinished, then remove its worktree and branch.
import { basename, dirname } from "node:path";
import { git, worktreesOf } from "../server/checkpoint.ts";
import type { machine, Session } from "../server/machine.ts";
import { archiveWork, filesText } from "./archive.ts";
import { readRoles, SLUG } from "./hire.ts";

type M = Pick<typeof machine, "gitCommonDir" | "letGo" | "removeWorktree" | "sessions">;

const SLUG_SRC = SLUG.source.slice(1, -1);
const NOT_LET_GO = "not let go:";
let nameRe: RegExp | undefined;

export type HireName = { role: string; team: string | null; task: string; reviewer: boolean };

/**
 * What a hire's name says (`<role>-<task>`, `<team>.<role>-<task>`, `lead-<team>`), or null for the PM or any other name. A lead's team
 * is the one it heads, and its task repeats it. A Reviewer is named `reviewer-review-<task>`; its task is the one it reviews, and it has no branch or worktree of its own.
 */
export function hireName(name: string): HireName | null {
  nameRe ??= new RegExp(`^(?:(${SLUG_SRC})\\.)?(${readRoles().map((r) => r.id).join("|")})-(${SLUG_SRC})$`);
  const m = nameRe.exec(name);
  if (!m) return null;
  const [, team, role, rest] = m;
  if (role === "lead") return team ? null : { role, team: rest, task: rest, reviewer: false };
  const reviewer = role === "reviewer";
  return { role, team: team ?? null, task: reviewer ? rest.replace(/^review-/, "") : rest, reviewer };
}

/** The task a hire's name carries, or null for a lead or any other name (see hireName). */
export function hireTask(name: string): { task: string; reviewer: boolean } | null {
  const h = hireName(name);
  return h && h.role !== "lead" ? { task: h.task, reviewer: h.reviewer } : null;
}

/** The repo's main working directory a session belongs to: its own folder, or the folder above `.claude/worktrees`. */
export const repoOf = (cwd: string) => cwd.split("/.claude/worktrees/")[0];

/**
 * Lets a session go, archives the worktree's unfinished work under refs/f1rm/archive/<task> first (the session that is `first` of its name does), and, if it is the `last` of its name, removes the worktree and branch.
 * Nothing is refused for uncommitted files or an unmerged branch: it is all archived. A failing archive lets nobody go and removes nothing. Throws if the session can't be let go.
 */
export async function letGoHire(m: Pick<M, "letGo" | "removeWorktree">, s: Session, repo: string, { first = true, last = true } = {}): Promise<string> {
  const hire = hireTask(s.name);
  const task = hire && !hire.reviewer ? hire.task : null;
  // A Reviewer works in the main checkout and a lead has no branch: nothing of theirs to keep.
  if (!task) {
    await m.letGo(s.id);
    return `${s.name}: let go`;
  }
  const branch = `worktree-${task}`;
  let kept = "";
  if (first) {
    try {
      const a = archiveWork(repo, task);
      kept = a ? `archived its work as ${a.ref} (${filesText(a)})` : "";
    } catch (err) {
      return `${s.name}: ${NOT_LET_GO} could not archive its work: ${(err as Error).message}`;
    }
  }
  // What is archived may be discarded: `claude rm` refuses a worktree with uncommitted files or unpushed commits otherwise.
  await m.letGo(s.id, { discardIn: repo, discardAny: true });
  if (!last) return `${s.name}: let go${kept && `, ${kept}`}`; // another session of this name is still to go: the worktree and branch are removed after it
  try {
    m.removeWorktree(repo, task, true);
  } catch (err) {
    return `${s.name}: let go, ${kept && `${kept}, `}kept ${branch} and its worktree: ${(err as Error).message}`;
  }
  return `${s.name}: let go, ${kept && `${kept}, `}removed its worktree and branch ${branch}`;
}

/** Archives and removes every worktree under `.claude/worktrees` and every `worktree-*` branch of `repo` that no live session works in; the live ones are listed and skipped. It never runs `claude rm`. */
function leftovers(m: Pick<M, "removeWorktree">, repo: string, all: Session[]): { lines: string[]; ok: boolean } {
  const taskIn = (cwd: string) => (repoOf(cwd) === repo ? cwd.split("/.claude/worktrees/")[1]?.split("/")[0] : undefined);
  const live = new Map(all.filter((s) => s.pid && taskIn(s.cwd)).map((s) => [taskIn(s.cwd)!, s.name]));
  const branches = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/worktree-*"]) ?? "").split("\n").filter(Boolean).map((b) => b.slice("worktree-".length));
  const tasks = [...new Set([...worktreesOf(repo).map((p) => basename(p)), ...branches])].sort();
  const lines: string[] = [];
  let ok = true;
  for (const task of tasks) {
    if (live.has(task)) {
      lines.push(`${task}: live session ${live.get(task)} works in it, skipped`);
      continue;
    }
    let kept = "";
    try {
      const a = archiveWork(repo, task);
      kept = a ? `archived its work as ${a.ref} (${filesText(a)}), ` : "";
    } catch (err) {
      ok = false;
      lines.push(`${task}: not removed: could not archive its work: ${(err as Error).message}`);
      continue;
    }
    try {
      m.removeWorktree(repo, task, true);
      lines.push(`${task}: ${kept}removed its worktree and branch worktree-${task}`);
    } catch (err) {
      ok = false;
      lines.push(`${task}: ${kept}not removed: ${(err as Error).message}`);
    }
  }
  return { lines, ok };
}

/** Runs `f1rm letgo <name>...` or `f1rm letgo --leftovers` in `cwd`: one line per name, and `ok` false if any name wasn't found or couldn't be let go. */
export async function letgo(names: string[], m: M, cwd: string): Promise<{ lines: string[]; ok: boolean }> {
  const common = m.gitCommonDir(cwd);
  if (!common) throw new Error("not in a git repo");
  const repo = dirname(common);
  const all = await m.sessions();
  if (!all) throw new Error("can't list the sessions (`claude agents --json --all` failed)");
  if (names.includes("--leftovers")) {
    if (names.length > 1) throw new Error("usage: f1rm letgo --leftovers (it takes no names)");
    return leftovers(m, repo, all);
  }
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
        const line = await letGoHire(m, s, repo, { first: i === 0, last: i === found.length - 1 });
        lines.push(line);
        if (line.includes(`: ${NOT_LET_GO} `)) {
          ok = false;
          break; // the archive failed: the other sessions of this name share the worktree, which stays whole
        }
      } catch (err) {
        ok = false;
        lines.push(`${name}: could not be let go: ${(err as Error).message}`);
      }
    }
  }
  return { lines, ok };
}
