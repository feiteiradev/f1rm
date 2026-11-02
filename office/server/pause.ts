// A project's pause switch: the flag the office keeps per project, outside the repo in `~/.f1rm/paused/<repo>.json`, so a restart keeps it and `f1rm status` and `f1rm wake` can read it.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";
import { writePrivate } from "./private.ts";

/** What every hook of a paused project's sessions is answered: Claude Code stops the session at that step and keeps the reason in the conversation. */
export const PAUSE_ANSWER = { continue: false, stopReason: "project paused by the PM" } as const;
/** A session still busy this long after the pause (its turn went on without a hook, e.g. text streaming) is stopped. */
export const GRACE_MS = 30_000;

/**
 * Who paused (always `manual` now; only a flag an old office wrote carries `schedule`, and it reads and resumes like any other), when (ms), and why. `halted` is the names of the hires whose hook was answered continue:false (their turn ended at that step, the process lives);
 * `stopped` the ones `claude stop` ended after the grace, absent until it ran. A resume picks both up.
 */
export type Paused = { by: "manual" | "schedule"; at: number; why: string; halted?: string[]; stopped?: string[]; checkpoint?: string };

/** `~/.f1rm/paused`, where the office keeps the flags. */
export const pausedDirOf = (home: string) => join(home, ".f1rm", "paused");
export const pausedFile = (dir: string, repo: string) => join(dir, `${repoKey(repo)}.json`);

/** The project's pause, or null when there is none: no file, or one that is cut or of another shape. */
export function readPaused(file: string): Paused | null {
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    const names = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string"));
    const ok = (p?.by === "manual" || p?.by === "schedule") && Number.isFinite(p.at) && typeof p.why === "string" && names(p.halted) && names(p.stopped) && (p.checkpoint === undefined || typeof p.checkpoint === "string");
    return ok ? p : null;
  } catch {
    return null;
  }
}

/** Writes through a temp file so a reader never sees half of it. */
export function writePaused(file: string, paused: Paused) {
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(`${file}.tmp`, JSON.stringify(paused, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export const clearPaused = (file: string) => rmSync(file, { force: true });

/** Why a hire into a paused project is refused: its first prompt would meet the pause (`continue:false`) and stop at once. The same words for `f1rm hire` and the office's Hire dialog. */
export const hireRefusal = (project: string, paused: Paused) =>
  `${project} is paused (${paused.by}${paused.why ? `: ${paused.why}` : ""}): a new hire's first prompt would meet the pause and stop at once. Run \`f1rm resume\` in the project first, then hire.`;
