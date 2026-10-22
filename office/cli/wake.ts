// `f1rm wake <name|id> [message]`: resumes a stopped, blocked or done hire of this project in place.
import type { HireName } from "./letgo.ts";

/** Who may wake a hire follows who may hire it: the PM wakes leads, a lead wakes the members of its own team, a specialist wakes nobody. */
export const mayWake = (waker: { role: string | null; team: string | null }, target: HireName): boolean =>
  waker.role === "pm" ? target.role === "lead" : waker.role === "lead" ? target.role !== "lead" && !!waker.team && target.team === waker.team : false;
