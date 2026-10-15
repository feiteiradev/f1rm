// What a board looks like at a glance, as pure functions of its rows. The whiteboard and the text version both read these.
import type { BoardRow } from "../server/board.ts";

/** Marker colors for the whiteboard's chips. A status the guidelines don't name looks like `todo`. */
export const CHIP_COLORS: Record<string, number> = {
  todo: 0x6b7385,
  doing: 0x1f9d55,
  review: 0xd98a12,
  done: 0x3b6fd4,
  blocked: 0xd64545,
};

export const boardCounts = (rows: BoardRow[]) => ({
  total: rows.length,
  done: rows.filter((r) => r.status === "done").length,
  blocked: rows.filter((r) => r.status === "blocked").length,
});

/** The whole board in a phrase, for the text version. */
export function boardSummary(rows: BoardRow[]): string {
  if (!rows.length) return "No tasks";
  const { total, done, blocked } = boardCounts(rows);
  return `${done} of ${total} ${total === 1 ? "task" : "tasks"} done${blocked ? `, ${blocked} blocked` : ""}`;
}
