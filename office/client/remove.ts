// Removing an empty door: the pure parts. The office deletes the project's edition file, so the button asks twice.
import { post } from "./post.ts";

/** How long the first click stays armed. */
export const CONFIRM_MS = 4000;
/** Whether a click at `now` is the confirming second one, given when the button was armed (null: it wasn't). */
export const isConfirm = (armedAt: number | null, now: number) => armedAt !== null && now - armedAt <= CONFIRM_MS;

/** How long a refusal stays on the lobby. */
export const NOTE_MS = 5000;
/** Runs `clear` after `ms`; returns the cancel. */
export const clearAfter = (clear: () => void, ms = NOTE_MS, timers = { set: setTimeout, clear: clearTimeout }) => {
  const t = timers.set(clear, ms);
  return () => timers.clear(t);
};

/** Asks the office to forget a door. Null when it did, otherwise why it didn't (404 no such door, 409 not empty, 401 out-of-date link). */
export const removeDoor = (roomId: string) => post(`remove/${encodeURIComponent(roomId)}`);
