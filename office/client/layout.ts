// Where everything goes: a pure function of server state and the available width. Units are art pixels.
import type { Employee, OfficeState, Room } from "../server/office.ts";
import { ROLE_IDS } from "../people.ts";

export const CELL = { w: 36, h: 64 };
export const ROOM = { cols: 3, wall: 22, pad: 6, maxCols: 6 };
const MARGIN = 8;
const GAP = 8;

/** `hot` desks are the shared ones at the back of a room, where freelancers sit. */
export type Desk = { x: number; y: number; hot: boolean; employee?: Employee };
export type RoomLayout = { room: Room; x: number; y: number; w: number; h: number; empty: boolean; desks: Desk[] };

/** Integer art scale keeps pixels square; narrow windows drop to 2x and wide ones step up. */
export const scaleFor = (px: number) => (px < 760 ? 2 : px < 1100 ? 3 : 4);

// ponytail: an open room seats at most six per row, one per role; a wider screen gets more floor around the desks, not a longer row.
/** With `fill` (the view's height), the one room open fills the whole view: its walls and floor reach every edge and the desks sit in the middle. */
export function layoutOffice(state: OfficeState, width: number, fill: number | null = null): { rooms: RoomLayout[]; height: number } {
  const solo = fill !== null;
  const staff = Object.values(state.employees);
  const rooms = Object.values(state.rooms).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const cols = solo ? Math.min(ROOM.maxCols, Math.max(ROOM.cols, Math.floor((width - MARGIN * 2 - ROOM.pad * 2) / CELL.w))) : ROOM.cols;
  const roomW = solo ? Math.max(ROOM.pad * 2 + cols * CELL.w, width - MARGIN * 2) : ROOM.pad * 2 + cols * CELL.w;
  const inset = Math.floor((roomW - cols * CELL.w) / 2);

  const out: RoomLayout[] = [];
  let x = MARGIN, y = MARGIN, rowH = 0;
  for (const room of rooms) {
    // Company staff take the front desks in role order (shifts of a role by counter), freelancers the hot desks behind
    // them, by session id. Both orders are stable while nobody joins or leaves, with no arrival order in the state.
    const here = staff.filter((e) => e.room === room.id);
    const crew = here
      .filter((e) => e.role)
      .sort((a, b) => ROLE_IDS.indexOf(a.role!) - ROLE_IDS.indexOf(b.role!) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const freelancers = here.filter((e) => !e.role).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const crewSeats = Math.ceil(crew.length / cols) * cols;
    const seats = Math.max(cols, crewSeats + Math.ceil(freelancers.length / cols) * cols);
    const people = [...crew, ...Array(crewSeats - crew.length).fill(undefined), ...freelancers];
    const h = Math.max(ROOM.wall + ROOM.pad * 2 + (seats / cols) * CELL.h, solo ? fill - MARGIN * 2 : 0);
    if (x > MARGIN && x + roomW > width - MARGIN) {
      x = MARGIN;
      y += rowH + GAP;
      rowH = 0;
    }
    // Whole plank rows (8), so the floor lines meet the desks the same way in every room.
    const slack = Math.floor((h - (ROOM.wall + ROOM.pad * 2 + (seats / cols) * CELL.h)) / 16) * 8;
    const desks = Array.from({ length: seats }, (_, i) => ({
      x: x + inset + (i % cols) * CELL.w,
      y: y + ROOM.wall + ROOM.pad + slack + Math.floor(i / cols) * CELL.h,
      hot: i >= crewSeats && freelancers.length > 0,
      employee: people[i],
    }));
    out.push({ room, x, y, w: roomW, h, empty: here.length === 0, desks });
    x += roomW + GAP;
    rowH = Math.max(rowH, h);
  }
  return { rooms: out, height: y + rowH + MARGIN };
}

/** Employees in the order the office lays them out, so keyboard order does not change as events arrive. */
export const rosterOf = (state: OfficeState): Employee[] =>
  layoutOffice(state, 0).rooms.flatMap((r) => r.desks.flatMap((d) => d.employee ?? []));
