// The daily docker sweep: once per 24 h the office removes tagged Docker resources whose task is gone (see docker.ts sweep). Never untagged ones, never images.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { repoId, sweep, type Docker } from "../docker.ts";
import { hireName, repoOf } from "../cli/letgo.ts";

export const DAY_MS = 24 * 3600_000;

/** A task is live when its worktree exists (a symlinked folder too), or a session of the repo is named for it (so a task that is just starting is never swept). */
export function liveTasksOf(repo: string, sessions: { name?: string; cwd?: string }[]): Set<string> {
  const live = new Set<string>();
  try {
    for (const d of readdirSync(`${repo}/.claude/worktrees`, { withFileTypes: true })) if (d.isDirectory() || d.isSymbolicLink()) live.add(d.name);
  } catch { /* no worktrees folder */ }
  for (const s of sessions) {
    const cwd = String(s.cwd ?? "");
    if (repoOf(cwd) !== repo) continue;
    const task = hireName(String(s.name ?? ""))?.task;
    if (task) live.add(task);
    const inTree = cwd.startsWith(`${repo}/.claude/worktrees/`) && cwd.slice(repo.length + "/.claude/worktrees/".length).split("/")[0];
    if (inTree) live.add(inTree);
  }
  return live;
}

/** True when the last run (`{lastRun}` in `stateFile`) is 24 h or more before `now`; a missing file or a lastRun in the future counts as never. */
export function due(stateFile: string, now: number): boolean {
  let last = 0;
  try {
    const n = JSON.parse(readFileSync(stateFile, "utf8")).lastRun;
    if (typeof n === "number" && n <= now) last = n;
  } catch { /* never ran */ }
  return now - last >= DAY_MS;
}

/**
 * Runs the sweep for every registered repo whose folder exists if it is due; returns the lines to log (what was removed). Never throws.
 * A run where no repo got a clean answer (docker down) is not recorded, so the next tick tries again.
 */
export async function sweepTick(repos: string[], liveTasks: (repo: string) => Set<string> | Promise<Set<string>>, docker: Docker, now: number, stateFile: string): Promise<string[]> {
  if (!repos.length || !due(stateFile, now)) return [];
  const lines: string[] = [];
  let ok = 0;
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    try {
      const r = await sweep(docker, repoId(repo), await liveTasks(repo));
      const [c, n, v] = [r.containers.length, r.networks.length, r.volumes.length];
      if (c + n + v) lines.push(`docker sweep ${basename(repo)}: removed ${c} containers, ${n} networks, ${v} volumes`);
      for (const e of r.errors) lines.push(`docker sweep ${basename(repo)}: ${e}`);
      if (!r.errors.length || c + n + v) ok++;
    } catch { /* this repo is tried again on the next run */ }
  }
  if (!ok) return [];
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ lastRun: now }));
  } catch { /* unwritable state: it sweeps again next tick, harmlessly */ }
  return lines;
}
