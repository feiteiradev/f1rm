// Jump's pure parts: what it asks the office, and what a session that has ended leaves behind.
import type { OfficeState } from "../server/office.ts";
import { send } from "./post.ts";

/** The toast when a Jump finds the session over. */
export const ENDED = "This session has ended";

/** Null when the terminal came forward, otherwise why it didn't. A session that has just ended is neither: `onEnded` hears of it, and nothing opens. */
export async function jumpTo(id: string, onEnded: (id: string) => void): Promise<string | null> {
  if (import.meta.env?.MODE === "demo") return "Jump needs a live office; this is a recording.";
  const { error, reply } = await send(`jump/${encodeURIComponent(id)}`);
  if (reply?.ended === true) return onEnded(id), null;
  return error;
}

/** The state without one employee and their interns; the same object when they aren't there. The office's next push says the same. */
export function without(state: OfficeState, id: string): OfficeState {
  if (!state.employees[id]) return state;
  const { [id]: _, ...employees } = state.employees;
  return { ...state, employees, interns: Object.fromEntries(Object.entries(state.interns).filter(([, i]) => i.parent !== id)) };
}
