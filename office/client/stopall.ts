// Stop all / Resume all in the top bar: the pure parts. The words follow `f1rm pause --all` and `f1rm resume --all` (cli/pause.ts); the office does the work.
import type { StopResult } from "../cli/pause.ts";
import { send } from "./post.ts";

export type View = { phase: "idle" | "confirm" | "stopping" | "resuming"; status: string; failed: boolean };
export const IDLE: View = { phase: "idle", status: "", failed: false };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const running = (r: StopResult) => `${r.room} is NOT stopped, still running: ${r.remaining.map((p) => `pid ${p.pid} ${p.command}`).join("; ")}.`;

type Said = Pick<View, "status" | "failed">;

/** Stops every project. Says "All N stopped" only when the office checked afterwards that nothing of any project runs. */
async function stopAll(): Promise<Said> {
  const { error, reply } = await send("pause", { all: true });
  const results = (reply?.results ?? []) as StopResult[];
  const bad = results.filter((r) => !r.verified);
  if (error || bad.length) return { failed: true, status: [error, ...bad.map(running)].filter(Boolean).join(" ") };
  const n = results.reduce((sum, r) => sum + r.stopped.length + r.killed.length, 0);
  const checkpoints = results.flatMap((r) => (r.checkpoint ? [r.checkpoint] : []));
  return { failed: false, status: `All ${n} stopped.${checkpoints.length ? ` ${checkpoints.length === 1 ? "Checkpoint" : "Checkpoints"} ${checkpoints.join(", ")}.` : ""}` };
}

/** Resumes every paused project and says what woke and what did not. */
async function resumeAll(): Promise<Said> {
  const { error, reply } = await send("resume", { all: true });
  if (error) return { failed: true, status: error };
  const rooms = (reply?.rooms ?? []) as string[];
  if (!rooms.length) return { failed: false, status: "No project was paused." };
  const waking = Number(reply?.waking ?? 0);
  const lost = (reply?.lost ?? []) as { name: string; why: string }[];
  const woken = waking ? `: ${plural(waking, "hire")} waking` : "";
  return { failed: lost.length > 0, status: `Resumed ${rooms.join(", ")}${woken}.${lost.length ? ` NOT woken: ${lost.map((l) => `${l.name} (${l.why})`).join("; ")}.` : ""}` };
}

/** What the buttons do; `set` shows the view they leave. Stop all asks first (`ask`), and only Confirm posts. */
export const stopAllControls = (set: (view: View) => void) => ({
  ask: () => set({ ...IDLE, phase: "confirm" }),
  cancel: () => set(IDLE),
  confirm: async () => {
    set({ phase: "stopping", status: "Stopping all projects. This can take a minute.", failed: false });
    set({ phase: "idle", ...(await stopAll()) });
  },
  resume: async () => {
    set({ phase: "resuming", status: "Resuming all projects.", failed: false });
    set({ phase: "idle", ...(await resumeAll()) });
  },
});
export type Controls = ReturnType<typeof stopAllControls>;
