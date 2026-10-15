// Turns a recorded event log into something safe to publish. Events are rebuilt from an allow-list of
// fields, so a field this module doesn't know can't leak. Anything left that looks private fails the run.
import type { F1rmEvent } from "../server/office.ts";

const FAKE_HOME = "/home/demo";
const BUILTIN_AGENTS = new Set(["Explore", "Plan", "general-purpose"]);
const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const WORD = /^[\w:.-]{1,40}$/;

const SECRETS = [
  /\b(?:sk|pk|rk)-[\w-]{8,}/,
  /\bgh[pousr]_\w{20,}/,
  /\bgithub_pat_\w{20,}/,
  /\bxox[abprs]-[\w-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[\w-]{30,}/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  /\bbearer\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth)\w*\s*[=:]\s*\S+/i,
  // ponytail: any 32+ character run is treated as a token, so a long real word trips it; loosen if that bites.
  /[A-Za-z0-9+_-]{32,}={0,2}/,
];
const PATHS = [
  /\/(?:Users|root|private|var|tmp|opt|etc|mnt|Volumes)\/\S*/,
  /\/home\/(?!demo(?:\/|$))\S*/,
  /\b[A-Za-z]:\\\S*/,
  /~\/\S*/,
];
const looksPrivate = (s: string) => [...SECRETS, ...PATHS].some((p) => p.test(s));

/** A short "what it's doing" line with every argument that could carry user text cut away. */
function activityOf(e: F1rmEvent): string | undefined {
  const a = e.activity;
  if (!a || a === "Thinking") return a;
  const tool = e.tool ?? "";
  const arg = a.slice(tool.length).replace(/^:?\s/, "");
  if (FILE_TOOLS.has(tool)) return /^[\w.@+-]{1,60}$/.test(arg) && !looksPrivate(arg) ? `${tool} ${arg}` : tool;
  // The program name is as much of a command as is safe to show.
  const program = arg.split(/\s/)[0];
  if (tool === "Bash") return /^[a-z][\w.-]{0,20}$/.test(program) ? `Bash: ${program}` : "Bash";
  return WORD.test(tool) ? tool : "";
}

export type ScrubOptions = {
  /** Room names and session titles known to be public. Every other room becomes `project-N` and every other title is dropped. */
  keep?: Iterable<string>;
};

export function scrub(events: F1rmEvent[], { keep = [] }: ScrubOptions = {}): F1rmEvent[] {
  const safe = new Set(keep);
  const sessions = new Map<string, string>();
  const agents = new Map<string, string>();
  const worktrees = new Map<string, string>();
  const rooms = new Map<string, { id: string; name: string; root: string }>();
  const idOf = (m: Map<string, string>, k: string, prefix: string) => {
    if (!m.has(k)) m.set(k, `${prefix}-${m.size + 1}`);
    return m.get(k)!;
  };
  const t0 = events[0]?.at ?? 0;

  const out = events.flatMap((e): F1rmEvent[] => {
    if (!/^[A-Za-z]+(?:\/[a-z_]+)?$/.test(e.kind)) return [];
    let room = rooms.get(e.room.id);
    if (!room) {
      const name = safe.has(e.room.name) ? e.room.name : `project-${rooms.size + 1}`;
      room = { id: `${FAKE_HOME}/${name}/.git`, name, root: `${FAKE_HOME}/${name}` };
      rooms.set(e.room.id, room);
    }
    // A worktree session stays under its repo; the task slug is user text.
    const task = /\/\.claude\/worktrees\/([^/]+)/.exec(e.cwd)?.[1];
    const cwd = task ? `${room.root}/.claude/worktrees/${idOf(worktrees, task, "task")}` : room.root;
    const type = e.intern?.type ?? "";
    const activity = activityOf(e);
    return [
      {
        sessionId: idOf(sessions, e.sessionId, "session"),
        kind: e.kind,
        cwd,
        room: { id: room.id, name: room.name },
        terminal: WORD.test(e.terminal?.termProgram ?? "") ? { termProgram: e.terminal.termProgram } : {},
        at: e.at - t0,
        ...(activity !== undefined && { activity }),
        ...(e.tool !== undefined && { tool: WORD.test(e.tool) ? e.tool : "" }),
        ...(e.role && { role: e.role }),
        ...(e.title && safe.has(e.title) && { title: e.title }),
        ...(e.intern && { intern: { id: idOf(agents, e.intern.id, "agent"), type: BUILTIN_AGENTS.has(type) ? type : "" } }),
      },
    ];
  });

  if (looksPrivate(JSON.stringify(out))) throw new Error("scrub left something that looks private, probably in a kept room name or title");
  return out;
}
