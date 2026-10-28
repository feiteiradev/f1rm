// The full stop of a pause: which processes belong to a project's hires, killing them, and checking that nothing of the project still runs.
// The rule is conservative on purpose. A process is the project's when it sits in the process tree of one of its background sessions (read before the stop), or is an orphan
// (parent launchd) whose cwd is inside the repo's worktrees. The office, whatever the caller protects (and their ancestors), a login shell, a `claude` that is no session of the project
// and everything with a living parent outside the hires' trees (a terminal, the user's interactive session and what it runs) are never claimed.
// An orphan is not claimed either when its tree holds a process with a controlling terminal (a tmux or screen server started in a worktree owns the user's panes), and its walk stops at a login shell or a `claude`.
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { BoardRow } from "./board.ts";
import { newCheckpointId, snapshotWorktree, worktreesOf, writeManifest, type CheckSession, type Manifest, type Snapshot } from "./checkpoint.ts";

/** `tty`: the process has a controlling terminal (ps shows a tty, not `??`). A background hire's shells and what they start have none. */
export type Proc = { pid: number; ppid: number; command: string; cwd: string | null; zombie?: boolean; tty?: boolean };
/** `session`: a hire's own process; `child`: something in its tree; `orphan`: a process of the worktrees that lost its parent. */
export type Claimed = Proc & { why: "session" | "child" | "orphan" };
export type Killed = { pid: number; command: string; cwd: string | null; signal: "SIGTERM" | "SIGKILL"; why: Claimed["why"] };

const LAUNCHD = 1;
const within = (dir: string, path: string) => {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const isClaude = (command: string) => /(?:^|\/)claude(?:\s|$)/.test(command);

/** Everything of the project in `procs`: see the file's header. `roots` are the pids of the project's background sessions; `worktrees` is `<repo>/.claude/worktrees`. */
export function claim(procs: Proc[], o: { roots: number[]; worktrees: string; protect: number[] }): Claimed[] {
  const alive = procs.filter((q) => !q.zombie);
  const byPid = new Map(alive.map((q) => [q.pid, q]));
  const safe = new Set<number>();
  for (let pid of o.protect) for (; pid > LAUNCHD && !safe.has(pid); pid = byPid.get(pid)?.ppid ?? 0) safe.add(pid);
  const kids = Map.groupBy(alive, (q) => q.ppid);
  const why = new Map<number, Claimed["why"]>();
  // The user's own shells and sessions are never walked into; a root's tree is the hire's whole, an orphan's stops at them.
  const stranger = (q: Proc) => q.command.startsWith("-") || isClaude(q.command);
  const subtree = (pid: number, stop: (q: Proc) => boolean) => {
    const seen: Proc[] = [];
    for (const queue = [pid]; queue.length; ) {
      const q = byPid.get(queue.pop()!);
      if (!q || seen.includes(q) || stop(q)) continue;
      seen.push(q);
      queue.push(...(kids.get(q.pid) ?? []).map((k) => k.pid));
    }
    return seen;
  };
  const orphans = alive.filter((q) => q.ppid === LAUNCHD && q.pid !== LAUNCHD && q.cwd && within(o.worktrees, q.cwd) && !stranger(q) && !subtree(q.pid, () => false).some((x) => x.tty));
  const walk = (from: number[], first: Claimed["why"], next: Claimed["why"], stop: (q: Proc) => boolean) => {
    const queue = from.map((pid) => [pid, first] as const);
    for (const [pid, w] of queue) {
      if (why.has(pid) || safe.has(pid) || !byPid.has(pid) || stop(byPid.get(pid)!)) continue;
      why.set(pid, w);
      for (const k of kids.get(pid) ?? []) queue.push([k.pid, next]);
    }
  };
  walk(o.roots, "session", "child", () => false);
  walk(orphans.map((q) => q.pid), "orphan", "child", stranger);
  return alive.filter((q) => why.has(q.pid)).map((q) => ({ ...q, why: why.get(q.pid)! }));
}

export type StopDeps = {
  procs: () => Promise<Proc[]>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  /** How long a SIGTERM may take before the SIGKILL, and how long the sessions get to go after their stop. */
  termMs?: number;
};

const STEP_MS = 250;

/**
 * Stops the project's sessions (`stopSessions`), kills what is left of their trees and the orphans in the worktrees (SIGTERM, then SIGKILL after `termMs`), and looks again.
 * `remaining` is what still runs afterwards: empty means nothing of the project does. The tree is read before the stop, because a stop reparents the children to launchd and a child
 * that left the worktrees (a dev server in /tmp) could no longer be told from a stranger's.
 */
export async function clearProject(o: { roots: number[]; worktrees: string; protect: number[]; stopSessions: () => Promise<void> } & StopDeps): Promise<{ killed: Killed[]; remaining: Claimed[] }> {
  const termMs = o.termMs ?? 4000;
  const rule = { roots: o.roots, worktrees: o.worktrees, protect: o.protect };
  const before = claim(await o.procs(), rule);
  await o.stopSessions();
  const waitFor = async (done: (now: Proc[]) => boolean, ms: number) => {
    let now = await o.procs();
    for (let waited = 0; !done(now) && waited < ms; waited += STEP_MS) {
      await o.sleep(STEP_MS);
      now = await o.procs();
    }
    return now;
  };
  // Today's claim, plus what the earlier tree held (same pid and same command, so a reused pid is not ours).
  const pending = (now: Proc[]) => {
    const seen = new Map(claim(now, rule).map((q) => [q.pid, q]));
    for (const b of before) {
      const q = now.find((x) => x.pid === b.pid && !x.zombie && x.command === b.command);
      if (q && !seen.has(q.pid)) seen.set(q.pid, { ...q, why: b.why });
    }
    return [...seen.values()];
  };
  const killed: Killed[] = [];
  const send = (targets: Claimed[], signal: Killed["signal"]) => {
    for (const q of targets) {
      o.kill(q.pid, signal);
      const rec = { pid: q.pid, command: q.command, cwd: q.cwd, signal, why: q.why };
      const i = killed.findIndex((k) => k.pid === q.pid);
      if (i < 0) killed.push(rec);
      else killed[i] = rec;
    }
  };
  const empty = (now: Proc[]) => pending(now).length === 0;
  // The sessions get a moment to leave; a pid that outlives it is killed like the rest.
  send(pending(await waitFor((now) => !o.roots.some((pid) => now.some((q) => q.pid === pid && !q.zombie)), termMs)), "SIGTERM");
  send(pending(await waitFor(empty, termMs)), "SIGKILL");
  return { killed, remaining: pending(await waitFor(empty, termMs / 2)) };
}

/** What running `ps` or `lsof` gave: its output, its exit code, and whether it was killed for taking too long. */
export type RunResult = { out: string; code: number | null; timedOut: boolean };

/**
 * The process table: pid, parent, state, terminal and command from `ps`, and the cwd of each from one `lsof` call. A `ps` or `lsof` that fails or times out throws:
 * an empty or cwd-less table would read as "nothing of the project runs".
 */
export async function procsFrom(run: (argv: string[]) => Promise<RunResult>): Promise<Proc[]> {
  const [ps, lsof] = await Promise.all([run(["ps", "-axo", "pid=,ppid=,stat=,tty=,command="]), run(["lsof", "-w", "-a", "-d", "cwd", "-Fpn"])]);
  for (const [name, r] of [["ps", ps], ["lsof", lsof]] as const) {
    if (r.timedOut || r.code !== 0) throw new Error(`${name} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}`);
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of lsof.out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  const procs: Proc[] = [];
  for (const line of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const q: Proc = { pid: Number(m[1]), ppid: Number(m[2]), command: m[5]!, cwd: cwds.get(Number(m[1])) ?? null };
    if (m[3]!.startsWith("Z")) q.zombie = true;
    if (m[4] !== "??") q.tty = true;
    procs.push(q);
  }
  return procs;
}

const runReal = async (argv: string[]): Promise<RunResult> => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 20_000 });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { out, code, timedOut: !!p.signalCode };
};
export const realProcs = () => procsFrom(runReal);

export const realRealpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** What the office gives a pause to act with: the process table, the kill and the pids to spare (its own). */
export type FullStopOptions = StopDeps & { protect?: number[] };

export type Hire = { name: string; role: string; task: string; sessionId: string; cwd: string; pid?: number; row: BoardRow | null };
export type FullStopResult = { manifest: Manifest; stopped: string[]; killed: Killed[]; remaining: Claimed[]; saved: (Snapshot & { task: string })[]; unsaved: string[] };

/**
 * The whole stop of a project: the hires' sessions and what they started (see clearProject), a snapshot of every worktree and the manifest, kept in `dir`.
 * The manifest is written even when something survives (`verified` false), so the PM can see what was recorded; `previous` (an earlier checkpoint of the same pause) keeps its sessions.
 */
export async function fullStop(o: { repo: string; hires: Hire[]; stop: (sessionId: string) => Promise<boolean>; protect: number[]; previous: Manifest | null; why: string; now: number; dir: string } & StopDeps): Promise<FullStopResult> {
  const worktrees = join(realRealpath(o.repo), ".claude", "worktrees");
  const stopped: string[] = []; // the hires `claude stop` ended now, not the ones that had ended already
  const result = await clearProject({
    roots: o.hires.flatMap((h) => (h.pid ? [h.pid] : [])), worktrees, protect: o.protect,
    stopSessions: async () => void (await Promise.all(o.hires.map(async (h) => (await o.stop(h.sessionId).catch(() => false)) && stopped.push(h.name)))),
    procs: o.procs, kill: o.kill, sleep: o.sleep, termMs: o.termMs,
  });
  const unsaved: string[] = []; // worktrees with nothing to save on top of (an unborn HEAD) or a name that is no ref: their files are untouched, but no ref holds them
  const saved = worktreesOf(o.repo).flatMap((dir) => {
    const task = basename(dir);
    try {
      const snap = snapshotWorktree(dir, task);
      if (snap) return [{ ...snap, task, dir }];
    } catch {} // a folder whose name is no ref name
    unsaved.push(task);
    return [];
  });
  const fresh: CheckSession[] = o.hires.map((h) => ({ name: h.name, role: h.role, task: h.task, row: h.row, sessionId: h.sessionId, cwd: h.cwd, snapshot: null }));
  const sessions = [...(o.previous?.sessions ?? []).filter((s) => !fresh.some((f) => f.name === s.name)), ...fresh].map((s) => {
    const now = saved.find((v) => v.dir === realRealpath(s.cwd));
    return { ...s, snapshot: now ? { ref: now.ref, sha: now.sha, dirty: now.dirty } : s.snapshot };
  });
  const manifest: Manifest = {
    id: newCheckpointId(o.now, o.dir), at: o.now, repo: o.repo, why: o.why, verified: result.remaining.length === 0, sessions,
    killed: [...(o.previous?.killed ?? []), ...result.killed.map(({ pid, command, cwd, signal }) => ({ pid, command, cwd, signal }))],
    ...(unsaved.length && { unsaved }),
  };
  writeManifest(o.dir, manifest);
  return { manifest, stopped, killed: result.killed, remaining: result.remaining, saved: saved.map(({ dir: _, ...s }) => s), unsaved };
}

/** The real process table and kill, sparing the office's own process. A process that is already gone is no error. */
export const realFullStop = (): FullStopOptions => ({
  procs: realProcs,
  kill: (pid, signal) => {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return; // never launchd, a process group (0, -1) or the office itself
    try {
      process.kill(pid, signal);
    } catch {} // gone already, or not ours to signal: the check afterwards says what still runs
  },
  sleep: (ms) => Bun.sleep(ms),
  protect: [process.pid],
});
