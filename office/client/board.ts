// What a board looks like at a glance, as pure functions of its rows. The whiteboard and the text version both read these.
import type { BoardRow } from "../server/board.ts";

/** Marker colors for the whiteboard's chips. A status the guidelines don't name looks like `todo`. */
export const CHIP_COLORS: Record<string, number> = {
  todo: 0x6b7385,
  doing: 0x1f9d55,
  review: 0xd98a12,
  done: 0x3b6fd4,
  blocked: 0xd64545,
  // Approved founder work waiting for the user to put it out.
  publish: 0xc04fb0,
};

/** The ticket rows: a spec's own row on the wall (its branch `spec-<n>`) is no ticket. */
export const boardCounts = (all: BoardRow[]) => {
  const rows = all.filter((r) => !r.branch.startsWith("spec-"));
  return {
    total: rows.length,
    done: rows.filter((r) => r.status === "done").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
    publish: rows.filter((r) => r.status === "publish").length,
  };
};

/** The whole board in a phrase, for the text version. */
export function boardSummary(rows: BoardRow[]): string {
  const { total, done, blocked, publish } = boardCounts(rows);
  if (!total) return "No tickets";
  return `${done} of ${total} ${total === 1 ? "ticket" : "tickets"} done${blocked ? `, ${blocked} blocked` : ""}${publish ? `, ${publish} to publish` : ""}`;
}
