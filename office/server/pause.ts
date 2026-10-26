// A project's pause switch: the flag the office keeps per project, outside the repo in `~/.f1rm/paused/<repo>.json`, so a restart keeps it and `f1rm status` and `f1rm wake` can read it.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";
import { writePrivate } from "./private.ts";

/** What every hook of a paused project's sessions is answered: Claude Code stops the session at that step and keeps the reason in the conversation. */
export const PAUSE_ANSWER = { continue: false, stopReason: "project paused by the PM" } as const;
/** A session still busy this long after the pause (its turn went on without a hook, e.g. text streaming) is stopped. */
export const GRACE_MS = 30_000;

/** Who paused (`manual`, or `schedule` for the work-hours pause), when (ms), and why; `stopped` is the names of the hires `claude stop` ended after the grace, absent until it ran. */
export type Paused = { by: "manual" | "schedule"; at: number; why: string; stopped?: string[] };

/** `~/.f1rm/paused`, where the office keeps the flags. */
export const pausedDirOf = (home: string) => join(home, ".f1rm", "paused");
export const pausedFile = (dir: string, repo: string) => join(dir, `${repoKey(repo)}.json`);

/** The project's pause, or null when there is none: no file, or one that is cut or of another shape. */
export function readPaused(file: string): Paused | null {
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    const ok = (p?.by === "manual" || p?.by === "schedule") && Number.isFinite(p.at) && typeof p.why === "string" && (p.stopped === undefined || (Array.isArray(p.stopped) && p.stopped.every((s: unknown) => typeof s === "string")));
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
