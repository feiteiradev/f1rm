// Removing an empty door: the pure parts. The office deletes the project's edition file, so the button asks twice.
import { post } from "./post.ts";

/** How long the first click stays armed. */
export const CONFIRM_MS = 4000;
/** A click this soon after arming is a double-click's second half, not a decision. */
export const SETTLE_MS = 400;
/** What a click at `now` does, given when the button was armed (null: it wasn't): arm it, ignore it, or confirm and remove. */
export const clickOn = (armedAt: number | null, now: number): "arm" | "ignore" | "fire" => {
  if (armedAt === null || now - armedAt > CONFIRM_MS) return "arm";
  return now - armedAt < SETTLE_MS ? "ignore" : "fire";
};

/** How long a refusal stays on the lobby. */
export const NOTE_MS = 5000;
/** Runs `clear` after `ms`; returns the cancel. The timers are called bare: a browser's throw "Illegal invocation" as methods of another object. */
export const clearAfter = (clear: () => void, ms = NOTE_MS) => {
  const t = setTimeout(clear, ms);
  return () => clearTimeout(t);
};

/** Asks the office to forget a door. Null when it did, otherwise why it didn't (404 no such door, 409 not empty, 401 out-of-date link). */
export const removeDoor = async (roomId: string) =>
  import.meta.env?.MODE === "demo" ? "Doors are removed in a live office; this is a recording." : post(`remove/${encodeURIComponent(roomId)}`);
