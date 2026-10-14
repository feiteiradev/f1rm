// The office: hook payload normalizer and the pure state reducer.

export type Status = "working" | "waiting" | "idle";
export type Room = { id: string; name: string };
export type Employee = {
  sessionId: string;
  status: Status;
  activity: string;
  cwd: string;
  room: string;
};
export type OfficeState = { rooms: Record<string, Room>; employees: Record<string, Employee> };

export type F1rmEvent = {
  sessionId: string;
  kind: string;
  cwd: string;
  room: Room;
  activity: string;
};

export const emptyOffice = (): OfficeState => ({ rooms: {}, employees: {} });

export function normalize(payload: any, room: Room): F1rmEvent | null {
  if (typeof payload?.session_id !== "string" || typeof payload.hook_event_name !== "string") return null;
  return {
    sessionId: payload.session_id,
    kind: payload.hook_event_name,
    cwd: String(payload.cwd ?? ""),
    room,
    activity: "",
  };
}

export function reduce(state: OfficeState, e: F1rmEvent): OfficeState {
  return {
    rooms: { ...state.rooms, [e.room.id]: e.room },
    employees: {
      ...state.employees,
      [e.sessionId]: { sessionId: e.sessionId, status: "idle", activity: e.activity, cwd: e.cwd, room: e.room.id },
    },
  };
}
