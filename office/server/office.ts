// The office: hook payload normalizer and the pure state reducer.
import { basename } from "node:path";

export type Status = "working" | "waiting" | "idle" | "offline";
export type Room = { id: string; name: string };
/** Where the session's terminal is, for Jump. Background sessions have neither. */
export type TerminalLocator = { itermSessionId?: string; termProgram?: string };
export type Employee = {
  sessionId: string;
  status: Status;
  activity: string;
  cwd: string;
  room: string;
  terminal: TerminalLocator;
  /** Clock time (ms) of the employee's latest event. */
  lastEventAt: number;
  /** The session's transcript file, whose mtime counts as liveness. */
  transcript?: string;
};
export type OfficeState = { rooms: Record<string, Room>; employees: Record<string, Employee> };

export type F1rmEvent = {
  sessionId: string;
  /** The hook event name, e.g. PreToolUse, or Notification/<type>. */
  kind: string;
  cwd: string;
  room: Room;
  terminal: TerminalLocator;
  /** Clock time (ms) the server received the event. */
  at: number;
  transcript?: string;
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
export function normalize(payload: any, headers: Headers, roomOf: (cwd: string) => Room, at: number): F1rmEvent | null {
  const valid = ["session_id", "hook_event_name", "cwd"].every((k) => typeof payload?.[k] === "string" && payload[k]);
  if (!valid) return null;
  const kind: string =
    payload.hook_event_name === "Notification"
      ? `Notification/${payload.notification_type}`
      : payload.hook_event_name;
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
    // Unset env vars arrive as empty headers.
    terminal: {
      ...(headers.get("x-f1rm-iterm-session") && { itermSessionId: headers.get("x-f1rm-iterm-session")! }),
      ...(headers.get("x-f1rm-term-program") && { termProgram: headers.get("x-f1rm-term-program")! }),
    },
    at,
    ...(typeof payload.transcript_path === "string" && { transcript: payload.transcript_path }),
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
  "Notification/permission_prompt": "waiting",
  Stop: "idle",
  "Notification/idle_prompt": "idle",
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
        status: STATUS[e.kind] ?? (before && before.status !== "offline" ? before.status : "idle"),
        activity: e.activity ?? before?.activity ?? "",
        cwd: e.cwd,
        room: e.room.id,
        terminal: e.terminal,
        lastEventAt: e.at,
        transcript: e.transcript ?? before?.transcript,
      },
    },
  };
}

export type Timeouts = { offlineAfter: number; removeAfter: number };

/**
 * Employees quiet for `offlineAfter` ms go offline and for `removeAfter` ms leave, unless `alive`
 * says Claude Code still runs them. `lastActive` is the later of an employee's last event and transcript write.
 */
export function sweep(
  state: OfficeState,
  now: number,
  t: Timeouts,
  lastActive: (e: Employee) => number,
  alive: ReadonlySet<string>,
): OfficeState {
  const employees: Record<string, Employee> = {};
  let changed = false;
  for (const [id, e] of Object.entries(state.employees)) {
    const quiet = now - lastActive(e);
    if (alive.has(id) || quiet < t.offlineAfter) {
      employees[id] = e.status === "offline" ? { ...e, status: "idle" } : e;
      changed ||= e.status === "offline";
    }
    else if (quiet >= t.removeAfter) changed = true;
    else if (e.status === "offline") employees[id] = e;
    else {
      employees[id] = { ...e, status: "offline" };
      changed = true;
    }
  }
  return changed ? { ...state, employees } : state;
}
