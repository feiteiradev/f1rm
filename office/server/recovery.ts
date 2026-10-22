// The office's recovery tick: wakes the background hires and leads of a registered project whose process ended while their board row is doing/review, once per stop, and says so when it cannot.
// It nudges a live idle one whose turn ended without a report. Both go through code that already exists: planWake (the caps), machine.tell (the inbox), the boards and transcripts.
import { mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { firstPrompt, planWake, realWakeDeps, reportToOf, transcriptFile } from "../cli/wake.ts";
import { hireName, repoOf, type HireName } from "../cli/letgo.ts";
import { head, lastTurn, limitUntil, recoveryFile, tail, textOf } from "../cli/status.ts";
import type { BoardRow } from "./board.ts";
import { agents, machine } from "./machine.ts";
import { writePrivate } from "./private.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MONTHS =["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RESET = /^(?:([a-z]+)\s+)?(?:(\d{1,2})\s*,\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i;

/** The wall-clock parts of instant `t` in zone `tz` (a RangeError for a zone that does not exist). */
function wall(t: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: n("year"), month: n("month") - 1, day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** The wall clock of `tz` at instant `t`, as a number comparable with Date.UTC of the same parts. */
const wallMs = (t: number, tz: string) => {
  const w = wall(t, tz);
  return Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
};

/**
 * The instant at which the wall clock of `tz` reads the given date and time (day may run past the month; Date.UTC carries it). An hour that happens twice (clocks going back) gives the later,
 * when a limit has surely lifted; a time that does not exist (clocks going forward) gives the first instant after the gap.
 */
function instant(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  // The zone's offset a day before and a day after the stated time, wherever it changes in between.
  const offsets = [-DAY, DAY].map((d) => wallMs(asUtc + d, tz) - (asUtc + d));
  const exact = offsets.map((o) => asUtc - o).filter((t) => wallMs(t, tz) === asUtc);
  if (exact.length) return Math.max(...exact);
  let t = Math.min(...offsets.map((o) => asUtc - o));
  for (let i = 0; i < 24 * 60 && wallMs(t, tz) < asUtc; i++) t += MIN;
  return t;
}

/**
 * When a limit stop lifts, as epoch ms: the text after "resets" ("8:40pm (Europe/Lisbon)", "Oct 27, 9am (Europe/Lisbon)", "Monday 9:00 (Europe/Lisbon)"), read as the first such moment after `stoppedAt`.
 * A time without am/pm is a 24-hour one. No zone means this machine's. Null for a text that names no time or a zone that does not exist.
 */
export function resetAt(text: string, stoppedAt: number): number | null {
  const m = RESET.exec(text.trim());
  if (!m) return null;
  const [, word, dayOfMonth, h, min = "0", ampm, zone] = m;
  let hour = Number(h);
  const minute = Number(min);
  if (ampm ? hour < 1 || hour > 12 : hour > 23) return null;
  if (ampm) hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  if (minute > 59) return null;
  const month = word && dayOfMonth ? MONTHS.indexOf(word.slice(0, 3).toLowerCase()) : -1;
  const weekday = word && !dayOfMonth ? DAYS.indexOf(word.slice(0, 3).toLowerCase()) : -1;
  if (word && month < 0 && weekday < 0) return null;
  if (dayOfMonth && (Number(dayOfMonth) < 1 || Number(dayOfMonth) > 31)) return null;
  try {
    const tz = zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = wall(stoppedAt, tz);
    if (month >= 0) {
      const day = Number(dayOfMonth);
      if (new Date(Date.UTC(now.year, month, day)).getUTCMonth() !== month) return null; // Oct 40, Feb 31
      const t = instant(tz, now.year, month, day, hour, minute);
      return t > stoppedAt ? t : instant(tz, now.year + 1, month, day, hour, minute);
    }
    // Today and the next seven days: the first moment after the stop, on the stated weekday if one is.
    for (let i = 0; i < 8; i++) {
      const t = instant(tz, now.year, now.month, now.day + i, hour, minute);
      const w = wall(t, tz);
      if (t > stoppedAt && (weekday < 0 || new Date(Date.UTC(w.year, w.month, w.day)).getUTCDay() === weekday)) return t;
    }
    return null;
  } catch {
    return null; // a zone Intl does not know
  }
}

const WAKE_AFTER_RESET_MS = MIN; // the reset time is a minute old before the wake, so the limit has surely lifted
const AGAIN_MS = 10 * MIN; // ended again this soon after a wake, with nothing to show for it: no new wake
const QUIET_MS = 20 * MIN; // a turn ended this long ago without a report: one nudge
const REPORT = /^\s*(?:DONE|APPROVED|CHANGES REQUESTED|BLOCKED|ESCALATE|NEEDS YOU)\b/;
export const NOTE_LIMIT = "resumed after the session limit; continue your task";
export const NOTE_ENDED = "resumed after your session ended; continue your task";
export const NUDGE = "your turn ended without a report; send your DONE or BLOCKED";

/**
 * What the office remembers of one hire, per project, in `~/.f1rm/recovery/<repo>.json` so a restart keeps it and `f1rm status` can show it.
 * `wokeFrom` is the session id of the stop that was woken, and `told` the one whose Report to was told: a stop is handled once. `note` is what `f1rm status` shows.
 */
export type Entry = { wokeAt?: number; wokeFrom?: string; tip?: number | null; told?: string; nudged?: string; unreachable?: string; note?: string };
export type Entries = Record<string, Entry>;

export type RecoveryDeps = {
  now: () => number;
  /** `claude agents --json --all`; null if it can't say. */
  sessions: () => Promise<any[] | null>;
  /** The end of a session's transcript, "" if there is none. */
  tail: (cwd: string, sessionId: string) => string;
  /** When a session's transcript was last written (ms), or null. */
  mtime: (cwd: string, sessionId: string) => number | null;
  /** The first prompt `f1rm hire` wrote, or null. */
  promptOf: (cwd: string, sessionId: string) => string | null;
  /** The rows of the PM's board (team null) or of a team's. */
  board: (repo: string, team: string | null) => Promise<BoardRow[]>;
  /** The tip's commit time (ms) of a branch of the repo, or null. */
  commitTime: (repo: string, branch: string) => number | null;
  /** Wakes the hire through `f1rm wake`'s own checks; throws what it refuses with. */
  wake: (repo: string, name: string, note: string) => Promise<void>;
  /** Puts a message into the inbox of a live session of this name in the project (the one with this session id, when given); false if none takes it. */
  tell: (repo: string, name: string, message: string, sessionId?: string) => Promise<boolean>;
  store: { load: (repo: string) => Entries; save: (repo: string, entries: Entries) => void };
};

/**
 * Whether the hire's last turn (everything since the last prompt or delivered message that was not a tool result) reported: a SendMessage whose message starts with a report word, or text that does.
 * Real hires report through SendMessage and close with prose ("I sent APPROVED to lead-shop."), so the last line's text alone says nothing.
 */
function reportSent(tailText: string): boolean {
  for (const l of tailText.split("\n").reverse()) {
    let line: any;
    try {
      line = JSON.parse(l);
    } catch {
      continue; // a cut or odd line
    }
    if (line?.isSidechain) continue;
    if (line?.type === "assistant") {
      for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
        if (b?.type === "text" && REPORT.test(String(b.text ?? ""))) return true;
        if (b?.type === "tool_use" && b.name === "SendMessage" && REPORT.test(String(b.input?.message ?? ""))) return true;
      }
    } else if (line?.type === "user" ? !(Array.isArray(line.message?.content) && line.message.content.some((b: any) => b?.type === "tool_result")) : line?.type === "queue-operation" && line.operation === "enqueue") {
      return false; // the turn began here
    }
  }
  return false;
}

/** The progress a woken hire made: a commit on its branch, or more than one assistant message after the wake (the first is its reply; a reply with thinking is several lines of one message id). */
function madeProgress(tailText: string, since: number, tipBefore: number | null | undefined, tipNow: number | null): boolean {
  if (tipNow != null && (tipBefore == null || tipNow > tipBefore)) return true;
  const replies = new Set<string>();
  for (const l of tailText.split("\n")) {
    if (!l.includes('"type":"assistant"')) continue;
    try {
      const line = JSON.parse(l);
      if (line.type === "assistant" && !line.isSidechain && line.isApiErrorMessage !== true && Date.parse(line.timestamp) > since) replies.add(String(line.message?.id ?? line.uuid ?? l));
    } catch {} // a cut or odd line is no answer
  }
  return replies.size >= 2;
}

/** parseBoard keeps 60 characters of an owner cell and ends a longer one with "…". */
const owns = (owner: string, name: string) => owner === name || (owner.length === 60 && owner.endsWith("…") && name.startsWith(owner.slice(0, -1)));

/** A row is live when its status cell starts with doing or review: real boards annotate it ("review (live proof waits for the user)"). */
const active = (rows: BoardRow[], name: string, h: HireName) =>
  rows.some((r) => /^(?:doing|review)(?![\w-])/.test(r.status) && (owns(r.owner, name) || (h.reviewer && r.branch === `worktree-${h.task}`)));

/**
 * The recovery tick. For each registered project, each background hire or lead whose board row is doing or review is judged by its newest session:
 * ended, it is woken once per stop (a limit stop a minute after its reset time) or its Report to is told; live and idle for 20 minutes after a turn that ended without a report, it is nudged once.
 * Nothing here starts a session itself: `deps.wake` runs the same checks as `f1rm wake`, caps included.
 */
export function createRecovery(d: RecoveryDeps) {
  async function recoverRepo(repo: string, all: any[]) {
    const entries = d.store.load(repo);
    const before = JSON.stringify(entries);
    const mine = all.filter((a) => a?.kind === "background" && typeof a.name === "string" && typeof a.cwd === "string" && hireName(a.name) && repoOf(a.cwd) === repo);
    const newest = new Map<string, any>();
    for (const a of mine) if (!newest.has(a.name) || (a.startedAt ?? 0) > (newest.get(a.name).startedAt ?? 0)) newest.set(a.name, a);
    for (const name of Object.keys(entries)) if (!newest.has(name)) delete entries[name];
    const boards = new Map<string | null, BoardRow[]>();
    const rowsOf = async (team: string | null) => boards.get(team) ?? (boards.set(team, await d.board(repo, team)), boards.get(team)!);

    for (const [name, cur] of newest) {
      const h = hireName(name)!;
      const e = (entries[name] ??= {});
      const sid = String(cur.sessionId ?? cur.id);
      const cwd = String(cur.cwd);
      const now = d.now();
      if (!active(await rowsOf(h.role === "lead" ? null : h.team), name, h)) {
        delete e.note;
        delete e.unreachable;
        continue;
      }
      const tailText = d.tail(cwd, sid);
      const turn = lastTurn(tailText);
      const said = turn?.type === "assistant" && turn.isApiErrorMessage !== true ? textOf(turn.message?.content) : null;

      if (cur.pid) {
        // Live: a stop's note is stale. A nudge that could not be delivered stays until the hire writes again.
        const mt = d.mtime(cwd, sid);
        const quiet = cur.status === "idle" && mt != null && now - mt >= QUIET_MS && said !== null;
        const key = said !== null ? `${sid}:${turn.uuid ?? turn.timestamp ?? ""}` : null;
        if (!(e.unreachable && quiet && e.unreachable === key)) {
          delete e.note;
          delete e.unreachable;
        }
        if (!quiet || reportSent(tailText) || e.nudged === key) continue;
        if (h.role === "lead" && !teamQuiet(newest, h.team, now)) continue;
        e.nudged = key!;
        if (!(await safeTell(repo, name, NUDGE, sid))) {
          e.unreachable = key!;
          e.note = `turn ended without a report ${Math.floor((now - mt!) / MIN)}m ago; ${name} has no inbox to nudge`;
        }
        continue;
      }

      // Ended. A stop is handled once; a hire that had reported (its row waits on a review, or an answer) has nothing to continue.
      if (e.wokeFrom === sid || e.told === sid || reportSent(tailText)) continue;
      const first = d.promptOf(cwd, sid);
      /** A lead and a Reviewer have no branch of their own. */
      const tipOf = () => (h.role === "lead" || h.reviewer ? null : d.commitTime(repo, `worktree-${h.task}`));
      const stoppedAt = d.mtime(cwd, sid) ?? now;
      const limit = limitUntil(tailText);
      const tell = async (message: string, reason?: string) => {
        e.told = sid;
        const to = reportToOf(h, first, repo);
        const ok = await safeTell(repo, to, message);
        e.note = `${message}${reason ? ` (${reason})` : ""}${ok ? "" : `; ${to} has no inbox`}`;
      };
      const wakeIt = async (note: string, failed: string) => {
        try {
          await d.wake(repo, name, note);
        } catch (err) {
          return tell(failed, (err as Error).message);
        }
        e.wokeAt = now;
        e.wokeFrom = sid;
        e.tip = tipOf();
        delete e.told;
        delete e.note;
      };

      if (limit !== null) {
        const stopTime = Date.parse(turn?.timestamp) || stoppedAt;
        const reset = limit === "unknown" ? null : resetAt(limit, stopTime);
        const message = `${name} stopped at the session limit; f1rm wake ${name}`;
        if (reset === null) await tell(message, "no reset time");
        else if (now >= reset + WAKE_AFTER_RESET_MS) await wakeIt(NOTE_LIMIT, message);
        continue;
      }
      const soon = e.wokeAt !== undefined && stoppedAt - e.wokeAt <= AGAIN_MS;
      if (soon && !madeProgress(tailText, e.wokeAt!, e.tip, tipOf())) {
        await tell(`${name} stopped again after a wake; f1rm wake ${name}`);
        continue;
      }
      await wakeIt(NOTE_ENDED, `${name} stopped; f1rm wake ${name}`);
    }
    for (const [name, e] of Object.entries(entries)) if (!Object.keys(e).length) delete entries[name];
    if (JSON.stringify(entries) !== before) d.store.save(repo, entries);
  }

  const safeTell = (repo: string, name: string, message: string, sessionId?: string) => d.tell(repo, name, message, sessionId).catch(() => false);

  /** A lead is quiet when every member of its team is: idle, and its transcript written 20 minutes ago or more (an ended one counts as quiet). */
  function teamQuiet(newest: Map<string, any>, team: string | null, now: number): boolean {
    return [...newest.values()].every((m) => {
      const hm = hireName(m.name);
      if (!hm || hm.role === "lead" || hm.team !== team || !m.pid) return true;
      const mt = d.mtime(String(m.cwd), String(m.sessionId ?? m.id));
      return m.status === "idle" && mt != null && now - mt >= QUIET_MS;
    });
  }

  return {
    async tick(repos: string[]) {
      const all = repos.length ? await d.sessions() : null;
      if (!all) return;
      for (const repo of repos) await recoverRepo(repo, all).catch((err) => console.log(`recovery ${basename(repo)}: ${(err as Error).message}`));
    },
  };
}

/** The store on disk: `~/.f1rm/recovery/<repo>.json`, read back whole by `f1rm status`. A file that is cut or odd reads as empty; a write goes through a temp file so a reader never sees half of it. */
export function fileStore(home: string): RecoveryDeps["store"] {
  return {
    load(repo) {
      try {
        const raw = JSON.parse(readFileSync(recoveryFile(home, repo), "utf8"));
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      } catch {
        return {};
      }
    },
    save(repo, entries) {
      const file = recoveryFile(home, repo);
      mkdirSync(dirname(file), { recursive: true });
      writePrivate(`${file}.tmp`, JSON.stringify(entries, null, 2) + "\n");
      renameSync(`${file}.tmp`, file);
    },
  };
}

/** The real Claude Code, disk, git and clock for the tick; the server adds the boards and the inboxes. */
export function realRecoveryDeps(home: string): Omit<RecoveryDeps, "board" | "tell"> {
  return {
    now: Date.now,
    sessions: () => agents(true),
    tail: (cwd, sessionId) => tail(transcriptFile(home, cwd, sessionId)),
    mtime: (cwd, sessionId) => statSync(transcriptFile(home, cwd, sessionId), { throwIfNoEntry: false })?.mtimeMs ?? null,
    promptOf: (cwd, sessionId) => firstPrompt(head(transcriptFile(home, cwd, sessionId))),
    commitTime: (repo, branch) => {
      const r = Bun.spawnSync(["git", "-C", repo, "log", "-1", "--format=%ct", `refs/heads/${branch}`], { stdout: "pipe", stderr: "ignore" });
      return r.success && r.stdout.toString().trim() ? Number(r.stdout.toString()) * 1000 : null;
    },
    // The same checks as `f1rm wake`, caps included; the start is `claude --bg --resume` in the hire's own folder.
    wake: async (repo, name, note) => {
      const plan = await planWake({ target: name, message: note, cwd: repo }, realWakeDeps(home));
      await machine.spawnBackground(plan.argv, plan.cwd);
    },
    store: fileStore(home),
  };
}
