// The daily docker sweep: once per 24 h the office removes tagged Docker resources whose task is gone (see docker.ts sweep). Never untagged ones, never images.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { repoId, sweep, type Docker } from "../docker.ts";
import { hireName, repoOf } from "../cli/letgo.ts";

export const DAY_MS = 24 * 3600_000;

const realOr = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** A task is live when its worktree exists (a symlinked folder too), or a session of the repo is named for it (so a task that is just starting is never swept). Repos compare by real path. */
export function liveTasksOf(repo: string, sessions: { name?: string; cwd?: string }[]): Set<string> {
  const live = new Set<string>();
  try {
    for (const d of readdirSync(`${repo}/.claude/worktrees`, { withFileTypes: true })) if (d.isDirectory() || d.isSymbolicLink()) live.add(d.name);
  } catch { /* no worktrees folder */ }
  const real = realOr(repo);
  for (const s of sessions) {
    const cwd = String(s.cwd ?? "");
    const root = repoOf(cwd)!;
    if (realOr(root) !== real) continue;
    const task = hireName(String(s.name ?? ""))?.task;
    if (task) live.add(task);
    const inTree = cwd !== root && cwd.slice(root.length + "/.claude/worktrees/".length).split("/")[0];
    if (inTree) live.add(inTree);
  }
  return live;
}

const stateOf = (stateFile: string): { lastRun?: number; repos?: Record<string, number> } => {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) ?? {}; } catch { return {}; }
};

/** True when `repo`'s last run is 24 h or more before `now`: its own entry in `repos`, else the old shared `{lastRun}`. A missing file or a time in the future counts as never. */
export function due(stateFile: string, now: number, repo: string): boolean {
  const st = stateOf(stateFile);
  const n = st.repos?.[repo] ?? st.lastRun;
  return now - (typeof n === "number" && n <= now ? n : 0) >= DAY_MS;
}

/**
 * Runs the sweep for every registered repo whose folder exists if it is due; returns the lines to log (what was removed). Never throws.
 * Each repo has its own last run; one that got no clean answer (docker down) is not recorded, so the next tick tries it again.
 */
export async function sweepTick(repos: string[], liveTasks: (repo: string) => Set<string> | Promise<Set<string>>, docker: Docker, now: number, stateFile: string): Promise<string[]> {
  const lines: string[] = [];
  const done: string[] = [];
  for (const repo of repos) {
    if (!existsSync(repo) || !due(stateFile, now, repo)) continue;
    try {
      const r = await sweep(docker, repoId(repo), await liveTasks(repo));
      const [c, n, v] = [r.containers.length, r.networks.length, r.volumes.length];
      if (c + n + v) lines.push(`docker sweep ${basename(repo)}: removed ${c} containers, ${n} networks, ${v} volumes`);
      for (const e of r.errors) lines.push(`docker sweep ${basename(repo)}: ${e}`);
      if (!r.errors.length || c + n + v) done.push(repo);
    } catch { /* this repo is tried again on the next run */ }
  }
  if (!done.length) return [];
  try {
    const st = stateOf(stateFile);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...st, repos: { ...st.repos, ...Object.fromEntries(done.map((r) => [r, now])) } }));
  } catch { /* unwritable state: it sweeps again next tick, harmlessly */ }
  return lines;
}
