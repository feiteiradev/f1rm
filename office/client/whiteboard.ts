// The whiteboard on a room's wall: a count and one chip per task. The task text is in the board panel, never drawn here.
import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { BoardRow } from "../server/board.ts";
import { boardCounts, CHIP_COLORS } from "./board.ts";
import type { RoomLayout } from "./layout.ts";

// Art pixels in the room's frame.
const BOARD = { fromRight: 62, y: 2, w: 40, h: 17 };
const CHIP = { size: 3, pitch: 4, perRow: 9, rows: 2, x: 3, y: 8 };
const PAPER = 0xe9e4d6;
const INK = 0x2a3140;
// ponytail: the wall shows the first 18 tasks as chips; the count above them covers the rest.

const origin = (r: RoomLayout) => ({ x: r.x + r.w - BOARD.fromRight, y: r.y + BOARD.y });

/** The board and its chips, which open the board's panel when tapped. */
export function buildWhiteboard(r: RoomLayout, rows: BoardRow[], onOpen: () => void) {
  const { x, y } = origin(r);
  const root = new Container();
  const g = new Graphics();
  g.rect(x, y, BOARD.w, BOARD.h).fill(0x9aa3b5);
  g.rect(x + 1, y + 1, BOARD.w - 2, BOARD.h - 2).fill(PAPER);
  rows.slice(0, CHIP.perRow * CHIP.rows).forEach((row, i) => {
    const cx = x + CHIP.x + (i % CHIP.perRow) * CHIP.pitch, cy = y + CHIP.y + Math.floor(i / CHIP.perRow) * CHIP.pitch;
    g.rect(cx, cy, CHIP.size, CHIP.size).fill(CHIP_COLORS[row.status] ?? CHIP_COLORS.todo);
    // Not-yet-started tasks are hollow, so the board reads without telling the colors apart.
    if (row.status === "todo" || !(row.status in CHIP_COLORS)) g.rect(cx + 1, cy + 1, 1, 1).fill(PAPER);
  });
  root.addChild(g);
  root.hitArea = new Rectangle(x, y, BOARD.w, BOARD.h);
  root.eventMode = "static";
  root.cursor = "pointer";
  root.on("pointertap", onOpen);
  return root;
}

/** The "done of total" count, in screen pixels (the caller's scale), or null for an empty board. */
export function whiteboardCount(r: RoomLayout, rows: BoardRow[], scale: number) {
  if (!rows.length) return null;
  const { done, total } = boardCounts(rows);
  const text = new Text({ text: `${done}/${total} done`, style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10, fontWeight: "700", fill: INK } });
  const { x, y } = origin(r);
  text.position.set((x + 3) * scale, (y + 2) * scale);
  text.eventMode = "none";
  return text;
}
