// Stop all / Resume all in the top bar: the pure parts. The words follow `f1rm pause --all` and `f1rm resume --all` (cli/pause.ts); the office does the work.
import type { StopResult } from "../cli/pause.ts";
import { send } from "./post.ts";

export type View = { phase: "idle" | "confirm" | "stopping" | "resuming"; status: string; failed: boolean };
export const IDLE: View = { phase: "idle", status: "", failed: false };

/** A stop checks, kills and checkpoints every project, so it can take long; the office answers within this or the page stops waiting (the CLI waits the same). */
export const WAIT_MS = 120_000;
/** A status text this young was made by this page's own action, so a paused list changing now is that action's doing and keeps it. */
export const OWN_MS = 3000;

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const running = (r: StopResult) => `${r.room} is NOT stopped, still running: ${r.remaining.map((p) => `pid ${p.pid} ${p.command}`).join("; ")}.`;
const RETRY = "Run `f1rm pause --all` again, or press Stop all again if nothing shows paused.";

type Said = Pick<View, "status" | "failed">;

/** Stops every project. Says "All N stopped" only when the office checked afterwards that nothing of any project runs. */
async function stopAll(): Promise<Said> {
  const { error, reply } = await send("pause", { all: true }, WAIT_MS);
  const rooms = (reply?.rooms ?? []) as string[];
  const results = (reply?.results ?? []) as StopResult[];
  const bad = results.filter((r) => !r.verified);
  if (error || bad.length) return { failed: true, status: [error, ...bad.map(running), rooms.length && `Stopped: ${rooms.join(", ")}.`, RETRY].filter(Boolean).join(" ") };
  if (!reply) return { failed: true, status: `The office's reply could not be read, so nobody knows whether the projects stopped. ${RETRY}` };
  if (!results.length) return { failed: false, status: rooms.length ? `Paused ${rooms.join(", ")}; nothing was running to check.` : "Nothing to stop: every project is already paused." };
  const n = results.reduce((sum, r) => sum + r.stopped.length + r.killed.length, 0);
  const checkpoints = [...new Set(results.flatMap((r) => (r.checkpoint ? [r.checkpoint] : [])))];
  return { failed: false, status: `All ${n} stopped.${checkpoints.length ? ` ${checkpoints.length === 1 ? "Checkpoint" : "Checkpoints"} ${checkpoints.join(", ")}.` : ""}` };
}

/** Resumes every paused project and says what woke and what did not. */
async function resumeAll(): Promise<Said> {
  const { error, reply } = await send("resume", { all: true }, WAIT_MS);
  if (error) return { failed: true, status: error };
  if (!reply) return { failed: true, status: "The office's reply could not be read, so nobody knows whether the projects resumed. Press Resume all again, or run `f1rm resume --all`." };
  const rooms = (reply.rooms ?? []) as string[];
  if (!rooms.length) return { failed: false, status: "No project was paused." };
  const waking = Number(reply.waking ?? 0);
  const lost = (reply.lost ?? []) as { name: string; why: string }[];
  const woken = waking ? `: ${plural(waking, "hire")} waking` : "";
  return { failed: lost.length > 0, status: `Resumed ${rooms.join(", ")}${woken}.${lost.length ? ` NOT woken: ${lost.map((l) => `${l.name} (${l.why})`).join("; ")}.` : ""}` };
}

/** Escape closes the question wherever the focus is, while it is open. */
export const escapeCancels = (view: View, key: string) => view.phase === "confirm" && key === "Escape";
/** Whether a change of the paused list leaves the status text alone: an action is running, or its text is still fresh. */
export const keepsStatus = (view: View, sinceSettledMs: number) => view.phase !== "idle" || sinceSettledMs < OWN_MS;

/** What the buttons do; `set` shows the view they leave. Stop all asks first (`ask`), and only Confirm posts. One action runs at a time, and it always ends back at idle with its words. */
export function stopAllControls(set: (view: View) => void) {
  let busy = false;
  const run = async (phase: "stopping" | "resuming", words: string, act: () => Promise<Said>) => {
    if (busy) return;
    busy = true;
    set({ phase, status: words, failed: false });
    let said: Said;
    try {
      said = await act();
    } catch {
      said = { failed: true, status: "Something went wrong asking the office. Check `f1rm status`, then try again." };
    } finally {
      busy = false;
    }
    set({ phase: "idle", ...said });
  };
  return {
    ask: () => !busy && set({ ...IDLE, phase: "confirm" }),
    cancel: () => !busy && set(IDLE),
    /** Drops a status text that no action of this page made (the paused list changed from outside). */
    clear: () => !busy && set(IDLE),
    confirm: () => run("stopping", "Stopping all projects. This can take a minute.", stopAll),
    resume: () => run("resuming", "Resuming all projects.", resumeAll),
  };
}
export type Controls = ReturnType<typeof stopAllControls>;
