// The whiteboard on a room's wall, and the sign over each team's pod: a count or the team's name, and one chip per task.
// The task text is in the board panel, never drawn here.
import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { BoardRow } from "../server/board.ts";
import { boardCounts, CHIP_COLORS } from "./board.ts";
import type { Pod, RoomLayout } from "./layout.ts";

// Art pixels in the room's frame.
const BOARD = { fromRight: 62, y: 2, w: 40, h: 17 };
const CHIP = { size: 3, pitch: 4, perRow: 9, rows: 2, x: 3, y: 8 };
const PAPER = 0xe9e4d6;
const INK = 0x2a3140;
// ponytail: the wall shows the first 18 tasks as chips; the count above them covers the rest.

// A team's sign, in the pod's frame: the name on the left, the chips on the right.
const SIGN = { x: 2, y: 1, w: 80, h: 12, chipsX: 42, chipsY: 2 };
const LABEL_CHARS = 12;

const origin = (r: RoomLayout) => ({ x: r.x + r.w - BOARD.fromRight, y: r.y + BOARD.y });

/** A paper board at (x, y) with up to 18 chips from (cx, cy), opening the board's panel when tapped. */
function board(x: number, y: number, w: number, h: number, rows: BoardRow[], cx0: number, cy0: number, onOpen: () => void) {
  const root = new Container();
  const g = new Graphics();
  g.rect(x, y, w, h).fill(0x9aa3b5);
  g.rect(x + 1, y + 1, w - 2, h - 2).fill(PAPER);
  rows.slice(0, CHIP.perRow * CHIP.rows).forEach((row, i) => {
    const cx = cx0 + (i % CHIP.perRow) * CHIP.pitch, cy = cy0 + Math.floor(i / CHIP.perRow) * CHIP.pitch;
    g.rect(cx, cy, CHIP.size, CHIP.size).fill(CHIP_COLORS[row.status] ?? CHIP_COLORS.todo);
    // Not-yet-started tasks are hollow, so the board reads without telling the colors apart.
    if (row.status === "todo" || !(row.status in CHIP_COLORS)) g.rect(cx + 1, cy + 1, 1, 1).fill(PAPER);
  });
  root.addChild(g);
  root.hitArea = new Rectangle(x, y, w, h);
  root.eventMode = "static";
  root.cursor = "pointer";
  root.on("pointertap", onOpen);
  return root;
}

/** The board and its chips, which open the board's panel when tapped. */
export function buildWhiteboard(r: RoomLayout, rows: BoardRow[], onOpen: () => void) {
  const { x, y } = origin(r);
  return board(x, y, BOARD.w, BOARD.h, rows, x + CHIP.x, y + CHIP.y, onOpen);
}

/** The sign over a team's pod, with its board's chips; tapping it opens the team's board. */
export function buildTeamSign(p: Pod, rows: BoardRow[], onOpen: () => void) {
  const x = p.x + SIGN.x, y = p.y + SIGN.y;
  return board(x, y, SIGN.w, SIGN.h, rows, x + SIGN.chipsX, y + SIGN.chipsY, onOpen);
}

/** The team's name on its sign, in screen pixels (the caller's scale). */
export function teamSignLabel(p: Pod, scale: number) {
  const name = p.team.length > LABEL_CHARS ? p.team.slice(0, LABEL_CHARS - 1) + "…" : p.team;
  const text = new Text({ text: name, style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10, fontWeight: "700", fill: INK } });
  text.anchor.set(0, 0.5);
  text.position.set((p.x + SIGN.x + 3) * scale, (p.y + SIGN.y + SIGN.h / 2) * scale);
  text.eventMode = "none";
  return text;
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
