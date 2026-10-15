// Where everything goes: a pure function of server state and the available width. Units are art pixels.
import type { Employee, OfficeState, Room } from "../server/office.ts";
import { ROLE_IDS } from "../people.ts";

export const CELL = { w: 36, h: 64 };
export const ROOM = { cols: 3, wall: 22, pad: 6 };
const MARGIN = 8;
const GAP = 8;

/** `hot` desks are the shared ones at the back of a room, where freelancers sit. */
export type Desk = { x: number; y: number; hot: boolean; employee?: Employee };
export type RoomLayout = { room: Room; x: number; y: number; w: number; h: number; empty: boolean; desks: Desk[] };

export function layoutOffice(state: OfficeState, width: number): { rooms: RoomLayout[]; height: number } {
  const staff = Object.values(state.employees);
  const rooms = Object.values(state.rooms).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const roomW = ROOM.pad * 2 + ROOM.cols * CELL.w;

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
    const crewSeats = Math.ceil(crew.length / ROOM.cols) * ROOM.cols;
    const seats = Math.max(ROOM.cols, crewSeats + Math.ceil(freelancers.length / ROOM.cols) * ROOM.cols);
    const people = [...crew, ...Array(crewSeats - crew.length).fill(undefined), ...freelancers];
    const h = ROOM.wall + ROOM.pad * 2 + (seats / ROOM.cols) * CELL.h;
    if (x > MARGIN && x + roomW > width - MARGIN) {
      x = MARGIN;
      y += rowH + GAP;
      rowH = 0;
    }
    const desks = Array.from({ length: seats }, (_, i) => ({
      x: x + ROOM.pad + (i % ROOM.cols) * CELL.w,
      y: y + ROOM.wall + ROOM.pad + Math.floor(i / ROOM.cols) * CELL.h,
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
