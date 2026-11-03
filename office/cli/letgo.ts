// `f1rm letgo`, and the office's safety net: let a finished hire go, archive what it left unfinished, then remove its worktree and branch.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { realDocker, repoId, teardown, type Docker } from "../docker.ts";
import { git, worktreesOf } from "../server/checkpoint.ts";
import type { machine, Session } from "../server/machine.ts";
import { pausedDirOf, pausedFile, readPaused } from "../server/pause.ts";
import { archiveWork, filesText } from "./archive.ts";
import { readRoles, SLUG } from "./hire.ts";

type M = Pick<typeof machine, "gitCommonDir" | "letGo" | "removeWorktree" | "sessions"> & { docker?: Docker };

/** Tears down the task's tagged Docker stack; never throws. Returns ", tore down N containers, N networks, N volumes" only when something was removed. */
async function toreDown(m: { docker?: Docker }, repo: string, task: string): Promise<string> {
  try {
    const r = await teardown(m.docker ?? realDocker, repoId(repo), task);
    return r.containers.length + r.networks.length + r.volumes.length ? `, tore down ${r.containers.length} containers, ${r.networks.length} networks, ${r.volumes.length} volumes` : "";
  } catch {
    return "";
  }
}

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
 * Lets a session go: stops it, then (for the `first` session of its name) archives the worktree's unfinished work under refs/f1rm/archive/<task>, so nothing it writes while stopping is lost,
 * then (for the `last` one) removes the worktree and branch with git before `claude rm` runs, so that has no files to refuse.
 * Nothing is refused for uncommitted files or an unmerged branch: it is all archived. A failing archive removes nothing and lets nobody go. Throws if the session can't be let go.
 */
export async function letGoHire(m: Pick<M, "letGo" | "removeWorktree" | "docker">, s: Session, repo: string, { first = true, last = true } = {}): Promise<string> {
  const hire = hireTask(s.name);
  const task = hire && !hire.reviewer ? hire.task : null;
  // A Reviewer works in the main checkout and a lead has no branch: nothing of theirs to keep.
  if (!task) {
    await m.letGo(s.id);
    return `${s.name}: let go`;
  }
  const branch = `worktree-${task}`;
  let kept = "";
  let archiveError: Error | null = null;
  let removeError = "";
  const afterStop = () => {
    if (first) {
      try {
        const a = archiveWork(repo, task);
        kept = a ? `archived its work as ${a.ref} (${filesText(a)})` : "";
      } catch (err) {
        archiveError = err as Error;
        throw err;
      }
    }
    if (!last) return; // another session of this name is still to go: the worktree and branch are removed after it
    try {
      m.removeWorktree(repo, task, true);
    } catch (err) {
      removeError = (err as Error).message;
    }
  };
  try {
    // What is archived may be discarded: the removal of an earlier session of the name still meets the worktree, which it refuses with uncommitted files or unpushed commits otherwise.
    await m.letGo(s.id, { discardIn: repo, discardAny: true, afterStop });
  } catch (err) {
    if (archiveError) return `${s.name}: ${NOT_LET_GO} could not archive its work (the session is stopped): ${(archiveError as Error).message}`;
    throw err;
  }
  if (!last) return `${s.name}: let go${kept && `, ${kept}`}`;
  const said = kept && `${kept}, `;
  return removeError ? `${s.name}: let go, ${said}kept ${branch} and its worktree: ${removeError}` : `${s.name}: let go, ${said}removed its worktree and branch ${branch}${await toreDown(m, repo, task)}`;
}

/**
 * Archives and removes every worktree under `.claude/worktrees` and every `worktree-*` branch of `repo` that no session works in. A worktree with a session that is not done (stopped by a pause,
 * blocked on a limit, failed, running, or a finished one whose process lives) is listed and skipped: `f1rm wake` may resume it. It never stops or removes a session. Refuses while the project is paused.
 */
async function leftovers(m: Pick<M, "removeWorktree" | "docker">, repo: string, all: Session[], home: string): Promise<{ lines: string[]; ok: boolean }> {
  const paused = readPaused(pausedFile(pausedDirOf(home), repo));
  if (paused) throw new Error(`${basename(repo)} is paused (${paused.by}${paused.why ? `: ${paused.why}` : ""}): its stopped sessions are resumed by \`f1rm resume\`, so nothing is cleaned up until then`);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = real(repo) + "/.claude/worktrees/";
  const taskIn = (cwd: string) => {
    const at = real(cwd);
    return at.startsWith(root) ? at.slice(root.length).split("/")[0] : undefined;
  };
  const busy = new Map(all.filter((s) => (s.state !== "done" || s.pid) && taskIn(s.cwd)).map((s) => [taskIn(s.cwd)!, s]));
  const branches = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/worktree-*"]) ?? "").split("\n").filter(Boolean).map((b) => b.slice("worktree-".length));
  const tasks = [...new Set([...worktreesOf(repo).map((p) => basename(p)), ...branches])].filter((t) => t && !t.includes("/")).sort();
  const lines: string[] = [];
  let ok = true;
  for (const task of tasks) {
    const s = busy.get(task);
    if (s) {
      lines.push(`${task}: session ${s.name} (${s.state}) works in it, skipped`);
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
      lines.push(`${task}: ${kept}removed its worktree and branch worktree-${task}${await toreDown(m, repo, task)}`);
    } catch (err) {
      ok = false;
      lines.push(`${task}: ${kept}not removed: ${(err as Error).message}`);
    }
  }
  return { lines, ok };
}

/** Runs `f1rm letgo <name>...` or `f1rm letgo --leftovers` in `cwd`: one line per name, and `ok` false if any name wasn't found or couldn't be let go. `home` is where the pause flags are. */
export async function letgo(names: string[], m: M, cwd: string, home = process.env.HOME ?? homedir()): Promise<{ lines: string[]; ok: boolean }> {
  const common = m.gitCommonDir(cwd);
  if (!common) throw new Error("not in a git repo");
  const repo = dirname(common);
  const all = await m.sessions();
  if (!all) throw new Error("can't list the sessions (`claude agents --json --all` failed)");
  if (names.includes("--leftovers")) {
    if (names.length > 1) throw new Error("usage: f1rm letgo --leftovers (it takes no names)");
    return await leftovers(m, repo, all, home);
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
