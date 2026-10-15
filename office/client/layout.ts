// Where everything goes: a pure function of server state and the available width. Units are art pixels.
import type { Employee, OfficeState, Room } from "../server/office.ts";

export const CELL = { w: 36, h: 64 };
export const ROOM = { cols: 3, wall: 22, pad: 6 };
const MARGIN = 8;
const GAP = 8;

export type Desk = { x: number; y: number; employee?: Employee };
export type RoomLayout = { room: Room; x: number; y: number; w: number; h: number; empty: boolean; desks: Desk[] };

export function layoutOffice(state: OfficeState, width: number): { rooms: RoomLayout[]; height: number } {
  const staff = Object.values(state.employees);
  const rooms = Object.values(state.rooms).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const roomW = ROOM.pad * 2 + ROOM.cols * CELL.w;

  const out: RoomLayout[] = [];
  let x = MARGIN, y = MARGIN, rowH = 0;
  for (const room of rooms) {
    // Sorted by session id: stable while nobody joins or leaves, with no arrival order in the state.
    const people = staff.filter((e) => e.room === room.id).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const seats = Math.max(1, Math.ceil(people.length / ROOM.cols)) * ROOM.cols;
    const h = ROOM.wall + ROOM.pad * 2 + (seats / ROOM.cols) * CELL.h;
    if (x > MARGIN && x + roomW > width - MARGIN) {
      x = MARGIN;
      y += rowH + GAP;
      rowH = 0;
    }
    const desks = Array.from({ length: seats }, (_, i) => ({
      x: x + ROOM.pad + (i % ROOM.cols) * CELL.w,
      y: y + ROOM.wall + ROOM.pad + Math.floor(i / ROOM.cols) * CELL.h,
      employee: people[i],
    }));
    out.push({ room, x, y, w: roomW, h, empty: people.length === 0, desks });
    x += roomW + GAP;
    rowH = Math.max(rowH, h);
  }
  return { rooms: out, height: y + rowH + MARGIN };
}
