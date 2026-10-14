// The office: hook payload normalizer and the pure state reducer.
import { basename } from "node:path";

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
  /** The hook event name, e.g. PreToolUse. */
  kind: string;
  cwd: string;
  room: Room;
  /** Short "what it's doing now"; undefined keeps the previous one. */
  activity?: string;
};

export const emptyOffice = (): OfficeState => ({ rooms: {}, employees: {} });

const MAX_ACTIVITY = 60;
const clip = (s: string) => (s.length > MAX_ACTIVITY ? s.slice(0, MAX_ACTIVITY - 1) + "…" : s);

function describeTool(tool: string, input: any): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${tool} ${basename(str(input?.file_path ?? input?.notebook_path))}`;
    case "Grep":
    case "Glob":
      return `${tool} ${str(input?.pattern)}`;
    case "Bash":
      return `Bash: ${str(input?.command).split("\n")[0]}`;
    case "WebFetch":
      return `WebFetch ${URL.parse(str(input?.url))?.host ?? ""}`;
    case "WebSearch":
      return `WebSearch ${str(input?.query)}`;
    case "Agent":
    case "Task":
      return `Agent: ${str(input?.description)}`;
    default:
      return tool;
  }
}

/** One raw hook payload -> one f1rm event, or null if it isn't a hook payload. */
export function normalize(payload: any, roomOf: (cwd: string) => Room): F1rmEvent | null {
  const valid = ["session_id", "hook_event_name", "cwd"].every((k) => typeof payload?.[k] === "string" && payload[k]);
  if (!valid) return null;
  const kind: string = payload.hook_event_name;
  const tool = typeof payload.tool_name === "string" ? clip(describeTool(payload.tool_name, payload.tool_input)) : "";
  const activity: Record<string, string> = {
    UserPromptSubmit: "Thinking",
    PreToolUse: tool,
    PermissionRequest: tool,
    Stop: "",
  };
  return {
    sessionId: payload.session_id,
    kind,
    cwd: payload.cwd,
    room: roomOf(payload.cwd),
    activity: activity[kind],
  };
}

const STATUS: Record<string, Status> = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "working",
  SubagentStart: "working",
  SubagentStop: "working",
  PermissionRequest: "waiting",
  Stop: "idle",
};

export function reduce(state: OfficeState, e: F1rmEvent): OfficeState {
  const { [e.sessionId]: before, ...others } = state.employees;
  if (e.kind === "SessionEnd") return { ...state, employees: others };
  return {
    rooms: { ...state.rooms, [e.room.id]: e.room },
    employees: {
      ...others,
      [e.sessionId]: {
        sessionId: e.sessionId,
        status: STATUS[e.kind] ?? before?.status ?? "idle",
        activity: e.activity ?? before?.activity ?? "",
        cwd: e.cwd,
        room: e.room.id,
      },
    },
  };
}
