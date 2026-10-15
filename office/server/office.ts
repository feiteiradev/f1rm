// The office: hook payload normalizer and the pure state reducer.
import { basename } from "node:path";
import { nameFor, roleOfAgentType, type RoleId } from "../people.ts";

export type Status = "working" | "waiting" | "idle" | "offline";
export type Room = { id: string; name: string };
/** Where the session's terminal is, for Jump. Background sessions have neither. */
export type TerminalLocator = { itermSessionId?: string; termProgram?: string };
export type Employee = {
  sessionId: string;
  /** Unique among the employees present, and kept for as long as the employee stays. */
  name: string;
  /** The company role the session was started with (`--agent`), or null for a freelancer. */
  role: RoleId | null;
  /** The session's own title (`--name`, `/rename`), when it has one. */
  title?: string;
  status: Status;
  activity: string;
  /** The last tool the session used (e.g. Edit, Bash), or "" before any; the office animates from it. */
  tool: string;
  cwd: string;
  room: string;
  terminal: TerminalLocator;
  /** Clock time (ms) of the employee's latest event. */
  lastEventAt: number;
  /** The session's transcript file, whose mtime counts as liveness. */
  transcript?: string;
};
/** A sub-agent, shown walking out from its parent's desk until it stops. */
export type Intern = {
  agentId: string;
  /** The session id of the employee it works for. */
  parent: string;
  /** The sub-agent's type, e.g. Explore. */
  type: string;
};
export type OfficeState = { rooms: Record<string, Room>; employees: Record<string, Employee>; interns: Record<string, Intern> };

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
  /** Raw tool name; undefined keeps the previous one. */
  tool?: string;
  /** The session's role, when this event shows it; undefined keeps the previous one. */
  role?: RoleId;
  /** The session's title, when this event carries it; undefined keeps the previous one. */
  title?: string;
  /** On SubagentStart and SubagentStop: the sub-agent. */
  intern?: { id: string; type: string };
};

export const emptyOffice = (): OfficeState => ({ rooms: {}, employees: {}, interns: {} });

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
  // The cwd reaches `code` and `open` as an argument, where a leading "-" would be read as a flag.
  if (!valid || !payload.cwd.startsWith("/")) return null;
  const kind: string =
    payload.hook_event_name === "Notification"
      ? `Notification/${payload.notification_type}`
      : payload.hook_event_name;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const tool = toolName ? clip(describeTool(toolName, payload.tool_input)) : "";
  const activity: Record<string, string> = {
    UserPromptSubmit: "Thinking",
    PreToolUse: tool,
    PermissionRequest: tool,
    Stop: "",
  };
  const toolByKind: Record<string, string> = {
    UserPromptSubmit: "",
    PreToolUse: toolName,
    PermissionRequest: toolName,
    Stop: "",
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  // Inside a sub-agent, agent_type is the sub-agent's type, so only an event from the main session names its role.
  const agentId = str(payload.agent_id);
  const role = agentId ? undefined : roleOfAgentType(payload.agent_type);
  const title = str(payload.session_title);
  const subagent = kind === "SubagentStart" || kind === "SubagentStop";
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
    tool: toolByKind[kind],
    ...(role && { role }),
    ...(title && { title }),
    ...(subagent && agentId && { intern: { id: agentId, type: str(payload.agent_type) ?? "" } }),
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

const internsWhere = (interns: OfficeState["interns"], keep: (i: Intern) => boolean) =>
  Object.fromEntries(Object.entries(interns).filter(([, i]) => keep(i)));

export function reduce(state: OfficeState, e: F1rmEvent): OfficeState {
  const { [e.sessionId]: before, ...others } = state.employees;
  if (e.kind === "SessionEnd") return { ...state, employees: others, interns: internsWhere(state.interns, (i) => i.parent !== e.sessionId) };
  const role = e.role ?? before?.role ?? null;
  let interns = state.interns;
  // Claude Code's own helper agents (prompt suggestions, /btw) stop without ever starting; they say nothing about the parent.
  let strayStop = false;
  if (e.intern && e.kind === "SubagentStart") {
    interns = { ...interns, [e.intern.id]: { agentId: e.intern.id, parent: e.sessionId, type: e.intern.type } };
  } else if (e.intern && e.kind === "SubagentStop") {
    strayStop = !(e.intern.id in interns);
    interns = internsWhere(interns, (i) => i.agentId !== e.intern!.id);
  }
  return {
    rooms: { ...state.rooms, [e.room.id]: e.room },
    interns,
    employees: {
      ...others,
      [e.sessionId]: {
        sessionId: e.sessionId,
        name: before && before.role === role ? before.name : nameFor(e.sessionId, role, new Set(Object.values(others).map((o) => o.name))),
        role,
        title: e.title ?? before?.title,
        status: (strayStop ? undefined : STATUS[e.kind]) ?? (before && before.status !== "offline" ? before.status : "idle"),
        activity: e.activity ?? before?.activity ?? "",
        tool: e.tool ?? before?.tool ?? "",
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
  // A lost SubagentStop must not leave an intern walking after its parent has gone quiet or left.
  const interns = internsWhere(state.interns, (i) => !!employees[i.parent] && employees[i.parent].status !== "offline");
  changed ||= Object.keys(interns).length !== Object.keys(state.interns).length;
  return changed ? { ...state, employees, interns } : state;
}
