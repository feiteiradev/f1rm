// `f1rm status [--json]`: what each hire of this repo is really doing, from its transcript and its branch, never from the status text `claude agents` shows.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "../server/board.ts";
import { agents, commitTimeArgs, machine } from "../server/machine.ts";
import { pathTooLong, projectFolder as folder } from "./hire.ts";
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
  /** What the office's recovery noted about it (it stopped again after a wake, it could not be woken, its turn ended without a report); null if it noted nothing. */
  recovery: string | null;
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

/** Where the office keeps what its recovery tick remembers of a project's hires: `~/.f1rm/recovery/<repo>.json`, written by the office and read here. */
export const recoveryFile = (home: string, repo: string) => join(home, ".f1rm", "recovery", `${repoKey(repo)}.json`);

/** The notes the office left on this project's hires, by name; none when the file is missing, cut or of another shape. */
function recoveryNotes(home: string, repo: string): Record<string, string> {
  try {
    const entries = JSON.parse(readFileSync(recoveryFile(home, repo), "utf8"));
    return Object.fromEntries(Object.entries(entries).flatMap(([name, e]) => (typeof (e as any)?.note === "string" ? [[name, (e as any).note as string]] : [])));
  } catch {
    return {};
  }
}

/** An ended hire older than this is history, not something to wake. */
const ENDED_WINDOW_MS = 24 * 60 * 60_000;
const TAIL = 256 * 1024;
const HEAD = 64 * 1024;

/** Whether a recorded `cwd` is the repo's main working directory or under it (a worktree, a subfolder). */
const inRepo = (cwd: string, repo: string) => cwd === repo || cwd.startsWith(`${repo}/`);


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
/** `head` and `tail` without blocking the event loop: the office reads transcripts while it serves the hooks. A file that vanished reads as empty; any other error shows. */
async function slice(path: string, from: number, to: number): Promise<string> {
  try {
    return await Bun.file(path).slice(from, to).text();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}
export const headAsync = (path: string) => slice(path, 0, HEAD);
export const tailAsync = async (path: string) => {
  // A missing file reads as empty; any other error (EACCES) shows.
  const size = await Bun.file(path).stat().then((st) => st.size, (e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  });
  const from = Math.max(0, size - TAIL);
  const text = await slice(path, from, size);
  return from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
};

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
export const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => String(b?.text ?? "")).join("") : "");

/** A task-notification is the session's own background task finishing, not anyone's message. */
const isNotification = (content: unknown) => textOf(content).trimStart().startsWith("<task-notification>");

/**
 * Whether a transcript line starts a turn: a prompt or a delivered message, a cross-session message included (it is logged as an isMeta user line, often with no enqueue before it).
 * Not a tool result, a task-notification, or the other isMeta bodies (a skill's, a local command's caveat, an image note).
 */
export function startsTurn(line: any): boolean {
  if (line?.isSidechain) return false;
  if (line?.type === "queue-operation") return line.operation === "enqueue" && !isNotification(line.content);
  if (line?.type !== "user") return false;
  const content = line.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return false;
  if (isNotification(content)) return false;
  return line.isMeta !== true || /^\s*(?:Another Claude session sent a message|<cross-session-message)/.test(textOf(content));
}

/**
 * The last line of the conversation in a piece of transcript: an assistant or user line, or a message put in the queue (an enqueue; the queue emptying or being edited is
 * no message), past whatever bookkeeping Claude Code writes after a turn. A task-notification is the session's own background task finishing, not anyone's message.
 */
export function lastTurn(end: string): any {
  for (const l of end.split("\n").reverse()) {
    if (!TURN_LINE.test(l)) continue;
    try {
      const line = JSON.parse(l);
      if (!(line.type === "assistant" ? !line.isSidechain : startsTurn(line))) continue; // an assistant line of the conversation, or what starts a turn
      return line;
    } catch {} // a cut or odd line is not a turn
  }
  return null;
}

/**
 * When a limit stop lifts, as its text gives it: what follows "resets" ("8:40pm (Europe/Lisbon)", "Monday 9:00 (Europe/Lisbon)"). "unknown" if the text
 * names none; null unless the last line of the conversation is an API error about a limit, so a delivered `resume` or a reply clears it.
 */
export function limitUntil(end: string): string | null {
  const line = lastTurn(end);
  if (line?.type !== "assistant" || line.isApiErrorMessage !== true) return null;
  const text = textOf(line.message?.content);
  if (!/limit/i.test(text)) return null;
  return /\bresets\s+(.+)/i.exec(text)?.[1].trim() ?? "unknown";
}

type Transcript = { id: string; path: string; mtime: number; tail?: string };
/** The end of a transcript, read once. */
const tailOf = (t: Transcript) => (t.tail ??= tail(t.path));

/** The newest write under a folder, none if it is not there: a session busy in a long sub-agent writes only to its `subagents/` transcripts. */
function newest(dir: string): number {
  return Math.max(0, ...ls(dir).map((f) => {
    const st = statSync(join(dir, f), { throwIfNoEntry: false });
    return st ? (st.isDirectory() ? newest(join(dir, f)) : st.mtimeMs) : 0;
  }));
}

/** Every transcript in this repo's own folder and in the folders of its worktrees (statusFor refuses a path too long for those names to stay whole); the ended ones are told apart by the folder they record. */
function transcripts(home: string, repo: string, listedIds: Set<unknown>, now: number): Transcript[] {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const own = folder(repo);
  const mine = readdirSync(root).filter((d) => d === own || d.startsWith(`${own}--claude-worktrees-`));
  // A folder or a transcript that `claude rm` removes between the listing and the stat is skipped; any other error stays visible.
  return mine.flatMap((d) =>
    ls(join(root, d)).filter((f) => f.endsWith(".jsonl")).flatMap((f) => {
      const path = join(root, d, f);
      const st = statSync(path, { throwIfNoEntry: false });
      const id = f.slice(0, -".jsonl".length);
      if (!st) return [];
      // The sub-agent walk is only for a session that is listed or was written inside the window.
      const matters = listedIds.has(id) || now - st.mtimeMs <= ENDED_WINDOW_MS;
      return [{ id, path, mtime: matters ? Math.max(st.mtimeMs, newest(join(root, d, id, "subagents"))) : st.mtimeMs }];
    }),
  );
}

/** The hires of `repo`: the live ones `agents` lists there, then the ended ones its transcripts still hold from the last day, newest first. */
export function hires({ repo, home, agents: listed, now, commitTime }: HiresDeps): Hire[] {
  const listedIds = new Set(listed.map((a) => a?.sessionId));
  const files = transcripts(home, repo, listedIds, now);
  const byId = new Map(files.map((t) => [t.id, t]));
  const notes = recoveryNotes(home, repo);
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
      recovery: notes[name] ?? null,
    };
  };

  const liveNames = new Set<string>();
  const out = listed
    .filter((a) => a?.kind === "background" && typeof a.name === "string" && hireName(a.name) && typeof a.cwd === "string" && repoOf(a.cwd) === repo)
    .map((a) => (liveNames.add(a.name), make(a.name, String(a.sessionId ?? ""), byId.get(String(a.sessionId)), a)));

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
    if (name && cwd && inRepo(cwd, repo) && hireName(name) && !liveNames.has(name) && !ended.has(name)) ended.set(name, t);
  }
  return [...out, ...[...ended].map(([name, t]) => make(name, t.id, t))];
}

const usage = "usage: f1rm status [--json] | f1rm status --watch <name>[:waiting]...";
type Result = { out: string; err: string; code: number };
const NO_NAMES: Result = { out: "no names\n", err: "", code: 0 };

const WAITING = ":waiting";
export type WatchName = { name: string; waiting: boolean };
/** What the arguments of `f1rm status` ask for: a usage error, a listing, or a watch of some names (empty ones dropped, a `:waiting` suffix read once). */
export type Args = { error: string } | { watch: false; json: boolean } | { watch: true; names: WatchName[] };

/** Reads the arguments once, for `statusFor`, before it looks at the repo. */
export function parseArgs(argv: string[]): Args {
  if (argv[0] === "--watch") {
    const given = argv.slice(1);
    if (given.some((n) => n.startsWith("-"))) return { error: usage };
    const names = given.filter(Boolean).map((n) => (n.endsWith(WAITING) ? { name: n.slice(0, -WAITING.length), waiting: true } : { name: n, waiting: false }));
    return { watch: true, names: names.filter((n) => n.name) };
  }
  return argv.every((a) => a === "--json") ? { watch: false, json: argv.includes("--json") } : { error: usage };
}

const ago = (m: number | null) => (m == null ? "-" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m ago`);
const note = (h: Hire) => [h.ended ? "ended" : "", h.limitUntil ? `limit until ${h.limitUntil}` : "", h.recovery ?? ""].filter(Boolean).join(", ");

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

/** Runs `f1rm status` (the listing). Prints nothing itself; exit code 1 when `claude agents --json` can't be read. */
export async function status(args: { json: boolean }, deps: Omit<HiresDeps, "agents"> & { loadAgents: () => Promise<any[] | null> }): Promise<Result> {
  const listed = await deps.loadAgents();
  if (!listed) return { out: "", err: "f1rm: can't read `claude agents --json`, so there is nothing to report", code: 1 };
  const list = hires({ ...deps, agents: listed });
  return { out: args.json ? JSON.stringify(list, null, 2) + "\n" : table(list, deps.now), err: "", code: 0 };
}

const POLL_MS = 60_000;
const QUIET_MIN = 20;
/** A hire stopped by a limit keeps its lead from being stalled for this long, which is longer than any reset; after it the lead is told. */
const LIMITED_MIN = 360;

/** The entry that stands for a name: with two listed entries of one name (an old session beside a re-hired one) the newest, a fresh session with no transcript yet counting as the newest of all. */
function entryOf(name: string, list: Hire[]): Hire | undefined {
  const age = (x: Hire) => x.idleMinutes ?? -1;
  return list.filter((x) => x.name === name).reduce<Hire | undefined>((best, x) => (!best || age(x) < age(best) ? x : best), undefined);
}

/**
 * Why a named session is stalled, or null if it is not: missing, ended, on a limit stop, without an activity time, or idle for 20 minutes. A lead is idle only when its whole team is.
 * One that is waiting (for an answer, or for the user at its desk) is judged only for the first three, never for being quiet.
 */
function stalled(name: string, list: Hire[], waiting: boolean): string | null {
  const h = entryOf(name, list);
  if (!h) return "missing from the list";
  if (h.ended) return "ended";
  if (h.limitUntil) return `limit stop until ${h.limitUntil}`;
  if (waiting) return null;
  if (h.idleMinutes == null) return "no activity time";
  if (h.idleMinutes < QUIET_MIN) return null;
  // A hire that ended, has no activity time, or is quiet counts as quiet, unless a limit stop holds it (it waits for its reset, which a lead cannot hurry).
  const quiet = (x: Hire) => x.ended || x.idleMinutes == null || (x.idleMinutes >= QUIET_MIN && !(x.limitUntil && x.idleMinutes < LIMITED_MIN));
  if (h.role === "lead" && !list.filter((x) => x.team === h.team && x.role !== "lead").every(quiet)) return null;
  return `idle ${h.idleMinutes} minutes`;
}

export type WatchDeps = Omit<HiresDeps, "agents" | "now" | "commitTime"> & {
  now: () => number;
  loadAgents: () => Promise<any[] | null>;
  /** Waits `ms`; injected so a test needs no real time. */
  sleep: (ms: number) => Promise<void>;
};

/**
 * `f1rm status --watch <name>[:waiting]...`: sleeps a minute, then polls once a minute, and returns when a named session is stalled, with each such name and its reason (exit 0).
 * It fails closed: when `claude agents --json` can't be read it returns exit 1. With no name left it returns at once.
 * A waiting name is watched as a plain one as soon as it writes again. Its activity is noted at the first poll, a minute after the start, whatever that finds (none, for a session
 * with no transcript yet), so what it wrote in that first minute (a wrap-up after its report) does not count; any later write ends the wait, including a message sent to it. That is how
 * an approval at the hire's desk (no message reaches anyone) puts it back, while a Reviewer waiting after CHANGES REQUESTED, which writes nothing, stays waiting.
 */
export async function watch(names: WatchName[], deps: WatchDeps): Promise<Result> {
  if (!names.length) return NO_NAMES;
  const seen = new Map<string, number | null>();
  const plain = new Set<string>();
  for (;;) {
    await deps.sleep(POLL_MS);
    const listed = await deps.loadAgents();
    if (!listed) return { out: "", err: "f1rm: can't read `claude agents --json`, so the watch ends", code: 1 };
    const list = hires({ ...deps, commitTime: () => null, now: deps.now(), agents: listed });
    for (const n of names.filter((x) => x.waiting && !plain.has(x.name))) {
      const at = entryOf(n.name, list)?.lastActivity;
      const now = at ? Date.parse(at) : null;
      if (!seen.has(n.name)) seen.set(n.name, now);
      else if (now != null && now > (seen.get(n.name) ?? -Infinity)) plain.add(n.name);
    }
    const out = names.flatMap((n) => { const why = stalled(n.name, list, n.waiting && !plain.has(n.name)); return why ? [`${n.name}: ${why}`] : []; });
    if (out.length) return { out: out.join("\n") + "\n", err: "", code: 0 };
  }
}

export type RunDeps = { home: string; now: () => number; loadAgents: () => Promise<any[] | null>; sleep: (ms: number) => Promise<void>; commitTime: (branch: string) => number | null };

/**
 * `f1rm status` for a repo, given as its path, as null (not in git), or as a lookup called only when there is something to serve. It answers, in this order: a usage mistake, a watch with no names, a folder that is not a git repo, a path Claude Code would cut,
 * and else runs what `args` asks for. `deps` default to the real Claude Code, git and clock; a test injects them.
 */
export async function statusFor(args: Args, repoOrLookup: string | null | (() => string | null), deps: Partial<RunDeps> = {}): Promise<Result> {
  if ("error" in args) return { out: "", err: args.error, code: 1 };
  if (args.watch && !args.names.length) return NO_NAMES;
  const repo = typeof repoOrLookup === "function" ? repoOrLookup() : repoOrLookup; // asked for only now, when there is something to serve
  if (!repo) return { out: "", err: "f1rm: not in a git repo", code: 1 };
  const tooLong = pathTooLong(repo);
  if (tooLong) return { out: "", err: `f1rm: ${tooLong}`, code: 1 };
  const d: RunDeps = {
    home: process.env.HOME!,
    now: Date.now,
    loadAgents: () => agents(false),
    sleep: (ms) => Bun.sleep(ms),
    commitTime: (branch) => {
      const r = Bun.spawnSync(commitTimeArgs(repo, branch), { stdout: "pipe", stderr: "ignore" });
      return r.success && r.stdout.toString().trim() ? Number(r.stdout.toString()) * 1000 : null;
    },
    ...deps,
  };
  if (args.watch) return watch(args.names, { repo, home: d.home, now: d.now, loadAgents: d.loadAgents, sleep: d.sleep });
  return status(args, { repo, home: d.home, now: d.now(), loadAgents: d.loadAgents, commitTime: d.commitTime });
}

/** `f1rm status` run in `cwd`. */
export const statusIn = (argv: string[], cwd: string): Promise<Result> =>
  statusFor(parseArgs(argv), () => {
    const common = machine.gitCommonDir(cwd);
    return common ? dirname(common) : null;
  });
