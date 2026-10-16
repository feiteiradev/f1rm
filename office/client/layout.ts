// Where everything goes: a pure function of server state and the available width. Units are art pixels.
import type { Employee, OfficeState, Room } from "../server/office.ts";
import { ROLE_IDS } from "../people.ts";

export const CELL = { w: 36, h: 64 };
export const ROOM = { cols: 3, wall: 22, pad: 6, maxCols: 6 };
/** The PM's glass corner at the left of every room: its table (a desk cell) and a chair for you beside it. */
export const CORNER = { w: 62, h: 72, table: { x: 4, y: 6 } };
const MARGIN = 8;
const GAP = 8;

/** `hot` desks are the shared ones at the back of a room, where freelancers sit; the `table` is the PM's, in the corner. */
export type Desk = { x: number; y: number; hot: boolean; table?: boolean; employee?: Employee };
export type Box = { x: number; y: number; w: number; h: number };
/** `desks[0]` is always the PM's table. */
export type RoomLayout = Box & { room: Room; empty: boolean; corner: Box; desks: Desk[] };

/** Integer art scale keeps pixels square; narrow windows drop to 2x and wide ones step up. */
export const scaleFor = (px: number) => (px < 760 ? 2 : px < 1100 ? 3 : 4);

// ponytail: an open room seats at most six per row, one per role; a wider screen gets more floor around the desks, not a longer row.
/** With `fill` (the view's height), the one room open fills the whole view: its walls and floor reach every edge and the desks sit in the middle. */
export function layoutOffice(state: OfficeState, width: number, fill: number | null = null): { rooms: RoomLayout[]; height: number } {
  const solo = fill !== null;
  const staff = Object.values(state.employees);
  const rooms = Object.values(state.rooms).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const cols = solo ? Math.min(ROOM.maxCols, Math.max(ROOM.cols, Math.floor((width - MARGIN * 2 - ROOM.pad * 2 - CORNER.w) / CELL.w))) : ROOM.cols;
  const roomW = Math.max(ROOM.pad * 2 + CORNER.w + cols * CELL.w, solo ? width - MARGIN * 2 : 0);
  // The desks center in the floor right of the corner.
  const inset = CORNER.w + Math.floor((roomW - CORNER.w - cols * CELL.w) / 2);

  // The page opens one project at a time, so rooms just stack; only the roster lays out several, and only for their order.
  const out: RoomLayout[] = [];
  let y = MARGIN;
  for (const room of rooms) {
    // Company staff take the front desks in role order (shifts of a role by counter), freelancers the hot desks behind
    // them, by session id. Both orders are stable while nobody joins or leaves, with no arrival order in the state.
    const here = staff.filter((e) => e.room === room.id);
    const company = here
      .filter((e) => e.role)
      .sort((a, b) => ROLE_IDS.indexOf(a.role!) - ROLE_IDS.indexOf(b.role!) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    // The first PM takes the table; a second one works at a desk like everyone else.
    const pm = company[0]?.role === "pm" ? company[0] : undefined;
    const crew = pm ? company.slice(1) : company;
    const freelancers = here.filter((e) => !e.role).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const crewSeats = Math.ceil(crew.length / cols) * cols;
    const seats = Math.max(cols, crewSeats + Math.ceil(freelancers.length / cols) * cols);
    const people = [...crew, ...Array(crewSeats - crew.length).fill(undefined), ...freelancers];
    const h = Math.max(ROOM.wall + ROOM.pad * 2 + (seats / cols) * CELL.h, ROOM.wall + CORNER.h + ROOM.pad, solo ? fill - MARGIN * 2 : 0);
    // Whole plank rows (8), so the floor lines meet the desks the same way in every room.
    const slack = Math.floor((h - (ROOM.wall + ROOM.pad * 2 + (seats / cols) * CELL.h)) / 16) * 8;
    const corner = { x: MARGIN, y: y + ROOM.wall, w: CORNER.w, h: CORNER.h };
    const table: Desk = { x: corner.x + CORNER.table.x, y: corner.y + CORNER.table.y, hot: false, table: true, employee: pm };
    const desks = Array.from({ length: seats }, (_, i) => ({
      x: MARGIN + inset + (i % cols) * CELL.w,
      y: y + ROOM.wall + ROOM.pad + slack + Math.floor(i / cols) * CELL.h,
      hot: i >= crewSeats && freelancers.length > 0,
      employee: people[i],
    }));
    out.push({ room, x: MARGIN, y, w: roomW, h, empty: here.length === 0, corner, desks: [table, ...desks] });
    y += h + GAP;
  }
  return { rooms: out, height: y - GAP + MARGIN };
}

/** Employees in the order the office lays them out, so keyboard order does not change as events arrive. */
export const rosterOf = (state: OfficeState): Employee[] =>
  layoutOffice(state, 0).rooms.flatMap((r) => r.desks.flatMap((d) => d.employee ?? []));
