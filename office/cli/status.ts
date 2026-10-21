// `f1rm status [--json]`: what each hire of this repo is really doing, from its transcript and its branch, never from the status text `claude agents` shows.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { agents, machine } from "../server/machine.ts";
import { hireName, repoOf } from "./letgo.ts";

export type Hire = {
  name: string;
  role: string;
  team: string | null;
  sessionId: string;
  /** What `claude agents` says; null for a session it no longer lists. */
  status: string | null;
  state: string | null;
  /** The transcript's last write (ISO), and the minutes since; null with no transcript. */
  lastActivity: string | null;
  idleMinutes: number | null;
  /** The tip of the hire's branch (ISO); null for a lead, a Reviewer, or a branch that isn't there. */
  lastCommit: string | null;
  ended: boolean;
  /** When the limit stop the transcript ends on lifts, as its text gives it after "resets" (see limitUntil below); "unknown" if it names none; else null. */
  limitUntil: string | null;
};

export type HiresDeps = {
  /** The repo's main working directory. */
  repo: string;
  home: string;
  /** `claude agents --json`. */
  agents: any[];
  now: number;
  /** The tip's commit time (ms) of a branch in the repo, or null. */
  commitTime: (branch: string) => number | null;
};

/** An ended hire older than this is history, not something to wake. */
const ENDED_WINDOW_MS = 24 * 60 * 60_000;
const TAIL = 256 * 1024;
const HEAD = 64 * 1024;

/** Claude Code's folder name for a working directory: every character that is not a letter or digit becomes `-`. */
const folder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function read(path: string, from: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, length, from));
  } finally {
    closeSync(fd);
  }
}

/** Runs `f`; `empty` if the file or folder it reads was removed since it was listed (`claude rm` during a letgo). Any other error shows. */
const gone = <T>(f: () => T, empty: T): T => {
  try {
    return f();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
};

// head, tail and ls are exported for the test only.
export const head = (path: string) => gone(() => read(path, 0, HEAD), "");
/** The session's current name in a piece of its transcript: the last name line, so a rename counts. */
const lastName = (text: string) => [...text.matchAll(/"(?:agentName|customTitle)":"([^"]+)"/g)].at(-1)?.[1];
/** The folder the session last ran in, as its lines record it. */
const lastCwd = (text: string) => [...text.matchAll(/"cwd":"([^"]+)"/g)].at(-1)?.[1];
/** ponytail: only the last 256 KB are read, so a limit line followed by more than that is missed; read backwards if it ever is. */
export const tail = (path: string) =>
  gone(() => {
    const size = statSync(path).size;
    const from = Math.max(0, size - TAIL);
    const text = read(path, from, Math.min(size, TAIL));
    return from > 0 ? text.slice(text.indexOf("\n") + 1) : text; // the first line may be cut
  }, "");

/** The entries of a folder, none if it was removed since it was listed. */
export const ls = (dir: string) => gone(() => readdirSync(dir), [] as string[]);

const TURN = ["assistant", "user", "queue-operation"];
const TURN_LINE = new RegExp(`"type":"(?:${TURN.join("|")})"`);

/** The text of a message's content: a string, or the text blocks of a list. */
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => String(b?.text ?? "")).join("") : "");

/**
 * The last line of the conversation in a piece of transcript: an assistant or user line, or a message put in the queue (an enqueue; the queue emptying or being edited is
 * no message), past whatever bookkeeping Claude Code writes after a turn. A task-notification is the session's own background task finishing, not anyone's message.
 */
function lastTurn(end: string): any {
  for (const l of end.split("\n").reverse()) {
    if (!TURN_LINE.test(l)) continue;
    try {
      const line = JSON.parse(l);
      if (!TURN.includes(line.type) || (line.type === "queue-operation" && line.operation !== "enqueue")) continue;
      if (line.type !== "assistant" && textOf(line.content ?? line.message?.content).trimStart().startsWith("<task-notification>")) continue; // one that merely quotes the tag is a message
      return line;
    } catch {} // a cut or odd line is not a turn
  }
  return null;
}

/**
 * When a limit stop lifts, as its text gives it: what follows "resets" ("8:40pm (Europe/Lisbon)", "Monday 9:00 (Europe/Lisbon)"). "unknown" if the text
 * names none; null unless the last line of the conversation is an API error about a limit, so a delivered `resume` or a reply clears it.
 */
function limitUntil(end: string): string | null {
  const line = lastTurn(end);
  if (line?.type !== "assistant" || line.isApiErrorMessage !== true) return null;
  const text = textOf(line.message?.content);
  if (!/\blimit\b/i.test(text)) return null;
  return /\bresets\s+(.+)/i.exec(text)?.[1].trim() ?? "unknown";
}

type Transcript = { id: string; path: string; mtime: number; tail?: string };
/** The end of a transcript, read once. */
const tailOf = (t: Transcript) => (t.tail ??= tail(t.path));

/** Every transcript in this repo's own folder and in the folders of its worktrees, and in no other. */
function transcripts(home: string, repo: string): Transcript[] {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const own = folder(repo);
  const mine = readdirSync(root).filter((d) => d === own || d.startsWith(`${own}--claude-worktrees-`));
  // A folder or a transcript that `claude rm` removes between the listing and the stat is skipped; any other error stays visible.
  return mine.flatMap((d) =>
    ls(join(root, d)).filter((f) => f.endsWith(".jsonl")).flatMap((f) => {
      const path = join(root, d, f);
      const st = statSync(path, { throwIfNoEntry: false });
      return st ? [{ id: f.slice(0, -".jsonl".length), path, mtime: st.mtimeMs }] : [];
    }),
  );
}

/** The hires of `repo`: the live ones `agents` lists there, then the ended ones its transcripts still hold from the last day, newest first. */
export function hires({ repo, home, agents: listed, now, commitTime }: HiresDeps): Hire[] {
  const files = transcripts(home, repo);
  const byId = new Map(files.map((t) => [t.id, t]));
  const make = (name: string, sessionId: string, t: Transcript | undefined, a?: any): Hire => {
    const { role, team, task, reviewer } = hireName(name)!;
    const commit = role === "lead" || reviewer ? null : commitTime(`worktree-${task}`);
    return {
      name, role, team, sessionId,
      status: a ? String(a.status ?? "") || null : null,
      state: a ? String(a.state ?? "") || null : null,
      lastActivity: t ? new Date(t.mtime).toISOString() : null,
      idleMinutes: t ? Math.max(0, Math.floor((now - t.mtime) / 60_000)) : null,
      lastCommit: commit == null ? null : new Date(commit).toISOString(),
      ended: !a,
      limitUntil: t ? limitUntil(tailOf(t)) : null,
    };
  };

  const liveNames = new Set<string>();
  const out = listed
    .filter((a) => a?.kind === "background" && typeof a.name === "string" && hireName(a.name) && typeof a.cwd === "string" && repoOf(a.cwd) === repo)
    .map((a) => (liveNames.add(a.name), make(a.name, String(a.sessionId ?? ""), byId.get(String(a.sessionId)), a)));

  const listedIds = new Set(listed.map((a) => a?.sessionId));
  const ended = new Map<string, Transcript>();
  for (const t of files.sort((x, y) => y.mtime - x.mtime)) {
    if (listedIds.has(t.id) || now - t.mtime > ENDED_WINDOW_MS) continue;
    const end = tailOf(t);
    let name = lastName(end), cwd = lastCwd(end);
    if (!name || !cwd) {
      const start = head(t.path);
      name ??= lastName(start);
      cwd ??= lastCwd(start);
    }
    // Claude Code stores /code/shop.app and /code/shop-app in one folder, so the folder alone does not say whose it is; a transcript that records no folder is not guessed at.
    if (name && cwd && repoOf(cwd) === repo && hireName(name) && !liveNames.has(name) && !ended.has(name)) ended.set(name, t);
  }
  return [...out, ...[...ended].map(([name, t]) => make(name, t.id, t))];
}

const usage = "usage: f1rm status [--json]";
type Result = { out: string; err: string; code: number };

const ago = (m: number | null) => (m == null ? "-" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m ago`);
const note = (h: Hire) => [h.ended ? "ended" : "", h.limitUntil ? `limit until ${h.limitUntil}` : ""].filter(Boolean).join(", ");

function table(list: Hire[], now: number): string {
  if (!list.length) return "no hires\n";
  const rows = [["NAME", "ROLE", "TEAM", "AGENTS", "ACTIVITY", "COMMIT", "NOTE"]].concat(
    list.map((h) => [
      h.name, h.role, h.team ?? "-", [h.state, h.status].filter(Boolean).join("/") || "-", ago(h.idleMinutes),
      h.lastCommit ? ago(Math.max(0, Math.floor((now - Date.parse(h.lastCommit)) / 60_000))) : "-", note(h),
    ]),
  );
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd()).join("\n") + "\n";
}

/** Runs `f1rm status`: `argv` is what follows the command. Prints nothing itself; exit code 1 when `claude agents --json` can't be read. */
export async function status(argv: string[], deps: Omit<HiresDeps, "agents"> & { loadAgents: () => Promise<any[] | null> }): Promise<Result> {
  if (argv.some((a) => a !== "--json")) return { out: "", err: usage, code: 1 };
  const listed = await deps.loadAgents();
  if (!listed) return { out: "", err: "f1rm: can't read `claude agents --json`, so there is nothing to report", code: 1 };
  const list = hires({ ...deps, agents: listed });
  return { out: argv.includes("--json") ? JSON.stringify(list, null, 2) + "\n" : table(list, deps.now), err: "", code: 0 };
}

/** `f1rm status` run in `cwd`, against the real Claude Code, git and clock. */
export async function statusIn(argv: string[], cwd: string): Promise<Result> {
  const common = machine.gitCommonDir(cwd);
  if (!common) return { out: "", err: "f1rm: not in a git repo", code: 1 };
  const repo = dirname(common);
  return status(argv, {
    repo,
    home: process.env.HOME!,
    now: Date.now(),
    loadAgents: () => agents(false),
    commitTime: (branch) => {
      const r = Bun.spawnSync(["git", "-C", repo, "log", "-1", "--format=%ct", `refs/heads/${branch}`], { stdout: "pipe", stderr: "ignore" });
      return r.success && r.stdout.toString().trim() ? Number(r.stdout.toString()) * 1000 : null;
    },
  });
}
