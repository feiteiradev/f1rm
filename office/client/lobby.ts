// The lobby's pure parts: what each door says, where the doors go, which project the URL names, and one project's slice of the office.
import type { OfficeState, Room } from "../server/office.ts";

export type Door = { room: Room; count: number; waiting: boolean };

// ponytail: the server's ELSEWHERE.id, repeated because importing office.ts as a value would bundle its node imports into the page.
/** The one door for sessions that are in no project. It has no edition, board, PM or Hire, and cannot be removed. */
export const ELSEWHERE_ID = "elsewhere";
export const isProject = (roomId: string) => roomId !== ELSEWHERE_ID;
/** Remove is offered on a project's door that nobody is in. */
export const canRemove = (d: Door) => d.count === 0 && isProject(d.room.id);
export type DoorSlot = Door & { x: number; y: number };

/** Units are art pixels. A cell is one door and the plaque under it; the wall runs the full width above the floor. */
export const DOOR = { w: 56, h: 108, wall: 64 };
const MARGIN = 8;

/** One door per project, by name, then id, with how many employees are inside and whether anyone is waiting for permission. */
export function doorsOf(state: OfficeState): Door[] {
  const staff = Object.values(state.employees);
  return Object.values(state.rooms)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((room) => {
      const here = staff.filter((e) => e.room === room.id);
      return { room, count: here.length, waiting: here.some((e) => e.status === "waiting") };
    });
}

// ponytail: every project gets a door and long lists just scroll; add grouping or a filter if people keep dozens of projects.
/** Doors fill a row of the hallway and wrap, each row centered; the rows sit a third of the way down a view `viewH` tall. */
export function layoutLobby(state: OfficeState, width: number, viewH = 0): { doors: DoorSlot[]; height: number } {
  const doors = doorsOf(state);
  const perRow = Math.max(1, Math.floor((width - MARGIN * 2) / DOOR.w));
  const rows = Math.max(1, Math.ceil(doors.length / perRow));
  const top = Math.max(MARGIN, Math.floor((viewH - rows * DOOR.h) / 3));
  const slots = doors.map((d, i) => {
    const inRow = Math.min(perRow, doors.length - Math.floor(i / perRow) * perRow);
    return { ...d, x: Math.floor((width - inRow * DOOR.w) / 2) + (i % perRow) * DOOR.w, y: top + Math.floor(i / perRow) * DOOR.h };
  });
  return { doors: slots, height: top + rows * DOOR.h + MARGIN };
}

/** The office as one project sees it: its room, employees, their interns and its board. */
export function projectState(state: OfficeState, roomId: string): OfficeState {
  const keep = <T>(all: Record<string, T>, test: (v: T) => boolean) => Object.fromEntries(Object.entries(all).filter(([, v]) => test(v)));
  const employees = keep(state.employees, (e) => e.room === roomId);
  const room = state.rooms[roomId];
  return {
    rooms: room ? { [roomId]: room } : {},
    employees,
    interns: keep(state.interns, (i) => i.parent in employees),
    ...(state.boards?.[roomId] && { boards: { [roomId]: state.boards[roomId] } }),
    ...(state.teamBoards?.[roomId] && { teamBoards: { [roomId]: state.teamBoards[roomId] } }),
    ...(state.editions?.[roomId] && { editions: { [roomId]: state.editions[roomId] } }),
  };
}

// ponytail: the URL fragment is the whole router; a second view with its own state would want a real one.
const PREFIX = "#/project/";
/** The URL fragment that opens a project; empty for the lobby. */
export const hashFor = (roomId: string | null) => (roomId === null ? "" : PREFIX + encodeURIComponent(roomId));
/** The project a fragment names, or null for the lobby. */
export function roomFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return null;
  try {
    return decodeURIComponent(hash.slice(PREFIX.length));
  } catch {
    return null;
  }
}
