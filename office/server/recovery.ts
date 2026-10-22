// The office's recovery tick: wakes the background hires and leads of a registered project whose process ended while their board row is doing/review, once per stop, and says so when it cannot.
// It nudges a live idle one whose turn ended without a report. Both go through code that already exists: planWake (the caps), machine.tell (the inbox), the boards and transcripts.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { firstPrompt, planWake, realWakeDeps, reportToOf, transcriptFile } from "../cli/wake.ts";
import { hireName, repoOf, type HireName } from "../cli/letgo.ts";
import { headAsync, lastTurn, limitUntil, recoveryFile, startsTurn, tailAsync } from "../cli/status.ts";
import { clip, MAX_CELL, type BoardRow } from "./board.ts";
import { agents, commitTimeArgs, machine, runAsync } from "./machine.ts";
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
 * when a limit has surely lifted; a time that does not exist (clocks going forward) reads with the offset from before the gap, as JS Date does (2:30am becomes 3:30am).
 * ponytail: Claude Code prints its reset from a real instant, so a time in a gap is hypothetical; no search for the first instant after it.
 */
function instant(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  // The zone's offset a day before and a day after the stated time, wherever it changes in between.
  const offsets = [-DAY, DAY].map((d) => wallMs(asUtc + d, tz) - (asUtc + d));
  const candidates = offsets.map((o) => asUtc - o);
  const exact = candidates.filter((t) => wallMs(t, tz) === asUtc);
  return Math.max(...(exact.length ? exact : candidates));
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
 * A stop is decided once per session id and recorded here with a `note`, which is what `f1rm status` shows: `wokeFrom` (woken), `told` (its Report to was told, or it had reported), `waitSid` with `wakeAt` (waiting
 * for its limit to lift). `judged` is the transcript write a live idle hire was last judged at, and `nudged` the turn that got its nudge. Later ticks read none of these transcripts again.
 */
export type Entry = { wokeAt?: number; wokeFrom?: string; tip?: number | null; told?: string; waitSid?: string; wakeAt?: number; judged?: number; nudged?: string; unreachable?: string; note?: string };
export type Entries = Record<string, Entry>;

export type RecoveryDeps = {
  now: () => number;
  /** `claude agents --json --all`; null if it can't say. */
  sessions: () => Promise<any[] | null>;
  // The readers may answer later: the real ones read the disk and ask git without blocking the event loop that serves the hooks.
  /** The end of a session's transcript, "" if there is none. */
  tail: (cwd: string, sessionId: string) => string | Promise<string>;
  /** When a session's transcript was last written (ms), or null. */
  mtime: (cwd: string, sessionId: string) => number | null | Promise<number | null>;
  /** The first prompt `f1rm hire` wrote, or null. */
  promptOf: (cwd: string, sessionId: string) => string | null | Promise<string | null>;
  /** The rows of the PM's board (team null) or of a team's. */
  board: (repo: string, team: string | null) => Promise<BoardRow[]>;
  /** The tip's commit time (ms) of a branch of the repo, or null. */
  commitTime: (repo: string, branch: string) => number | null | Promise<number | null>;
  /** Wakes the hire through `f1rm wake`'s own checks; throws what it refuses with. */
  wake: (repo: string, name: string, note: string) => Promise<void>;
  /** Puts a message into the inbox of a live session of this name in the project (the one with this session id, when given); false if none takes it. */
  tell: (repo: string, name: string, message: string, sessionId?: string) => Promise<boolean>;
  store: { load: (repo: string) => Entries; save: (repo: string, entries: Entries) => void };
};

/** The lines of the hire's last turn, oldest first: its assistant lines and the tool results, back to the last prompt or delivered message (see startsTurn). */
function lastTurnLines(tailText: string): any[] {
  const lines: any[] = [];
  for (const l of tailText.split("\n").reverse()) {
    let line: any;
    try {
      line = JSON.parse(l);
    } catch {
      continue; // a cut or odd line
    }
    if (!line || line.isSidechain) continue;
    if (startsTurn(line)) break;
    if (line.type === "assistant" || line.type === "user") lines.push(line);
  }
  return lines.reverse();
}

/**
 * What the hire's last turn reported. A report is a delivered SendMessage: its message starts with a report word and its tool result is no error (a send cut before its result, or refused by the gate
 * with "no live session", is not delivered). Text never counts: real hires report with SendMessage and close the turn with prose, and a refused send followed by "DONE ..., but the send was refused"
 * has not reported. `any`: the turn delivered a report (the nudge has nothing to ask for). `last`: that report is the turn's last tool call, so the turn ENDED reported (the stop of an ended hire needs no
 * wake); a hire that kept working after its report (a checkpoint) may have more to do, so hires checkpoint first.
 */
function turnReports(tailText: string): { any: boolean; last: boolean } {
  const turn = lastTurnLines(tailText);
  const failed = new Map<string, boolean>();
  for (const line of turn) if (line.type === "user" && Array.isArray(line.message?.content)) for (const b of line.message.content) if (b?.type === "tool_result") failed.set(String(b.tool_use_id), b.is_error === true);
  let any = false, last = false;
  for (const line of turn) {
    if (line.type !== "assistant") continue;
    for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (b?.type !== "tool_use") continue;
      last = b.name === "SendMessage" && REPORT.test(String(b.input?.message ?? "")) && failed.get(String(b.id)) === false;
      any ||= last;
    }
  }
  return { any, last };
}

/** The progress a woken hire made: a commit on its branch, or more than one assistant message after the wake (the first is its reply; a reply with thinking is several lines of one message id). */
function madeProgress(tailText: string, since: number, tipBefore: number | null | undefined, tipNow: number | null | undefined): boolean {
  // An unknown tip (git failed, then or now: undefined) says nothing; a known one with no earlier tip is a first commit.
  if (tipNow != null && tipBefore !== undefined && (tipBefore === null || tipNow > tipBefore)) return true;
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

/**
 * A row is live when its status cell starts with doing or review (real boards annotate it: "review (live proof waits for the user)") and it is the hire's: parseBoard clips the owner and the branch cell
 * (to 60 characters, ending a longer one with "…"), so the name and the branch are compared as clipped. Two names that clip to the same 60 characters cannot be told apart on a board: that is the ceiling.
 */
const active = (rows: BoardRow[], name: string, h: HireName) =>
  rows.some((r) => /^(?:doing|review)(?![\w-])/.test(r.status) && (r.owner === clip(name, MAX_CELL.owner) || (h.reviewer && r.branch === clip(`worktree-${h.task}`, MAX_CELL.branch))));

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
    const newer = (a: any, best: any) => !best || (a.startedAt ?? 0) > (best.startedAt ?? 0);
    const newest = new Map<string, any>();
    for (const a of mine) if (newer(a, newest.get(a.name))) newest.set(a.name, a);
    // The newest live session of each name in the project: a message goes to it, since an older seat of the same title may hold a dead socket or be another session.
    const liveByName = new Map<string, any>();
    for (const a of all) if (a?.pid && typeof a.name === "string" && typeof a.cwd === "string" && repoOf(a.cwd) === repo && newer(a, liveByName.get(a.name))) liveByName.set(a.name, a);
    for (const name of Object.keys(entries)) if (!newest.has(name)) delete entries[name];
    const boards = new Map<string | null, BoardRow[]>();
    const rowsOf = async (team: string | null) => boards.get(team) ?? (boards.set(team, await d.board(repo, team)), boards.get(team)!);

    // One hire's failure is logged and the others are still decided, so the record of what was decided earlier in the tick is saved.
    const judge = async (name: string, cur: any) => {
      const h = hireName(name)!;
      const e = (entries[name] ??= {});
      const sid = String(cur.sessionId ?? cur.id);
      const cwd = String(cur.cwd);
      const now = d.now();
      // A record holds only while its session stays ended: one resumed in place (the user's attach, a flagless resume) keeps its id, and its next stop is a new one.
      if (cur.pid) {
        if (e.told === sid) delete e.told;
        if (e.wokeFrom === sid) delete e.wokeFrom;
        if (e.waitSid === sid) {
          delete e.waitSid;
          delete e.wakeAt;
        }
      }
      if (!active(await rowsOf(h.role === "lead" ? null : h.team), name, h)) {
        delete e.note;
        delete e.unreachable;
        return;
      }

      if (cur.pid) {
        // Live: a stop's note is stale. A nudge that could not be delivered stays until the hire writes again. Only an idle hire that has been quiet since a write not yet judged has its transcript read.
        const mt = await d.mtime(cwd, sid);
        if (cur.status !== "idle" || mt == null || now - mt < QUIET_MS) {
          delete e.note;
          delete e.unreachable;
          delete e.judged;
          return;
        }
        if (e.judged === mt) return;
        // A lead whose members are still active is not judged yet, and its transcript is not read: it is looked at again on the next tick, whatever its own transcript does.
        if (h.role === "lead" && !(await teamQuiet(newest, h.team, now))) return;
        delete e.note;
        delete e.unreachable;
        const tailText = await d.tail(cwd, sid);
        const turn = lastTurn(tailText);
        if (turn?.type !== "assistant" || turn.isApiErrorMessage === true) {
          e.judged = mt; // the last line is no turn end (a limit stop, a message not yet answered)
          return;
        }
        const key = `${sid}:${turn.uuid ?? turn.timestamp ?? ""}`;
        if (e.nudged === key || turnReports(tailText).any) {
          e.judged = mt;
          return;
        }
        e.judged = mt;
        e.nudged = key;
        if (!(await safeTell(repo, name, NUDGE, sid))) {
          e.unreachable = key;
          e.note = `turn ended without a report ${Math.floor((now - mt) / MIN)}m ago; ${name} has no inbox to nudge`;
        }
        return;
      }

      // Ended. A stop is decided once, recorded, and its transcript is not read again.
      if (e.wokeFrom === sid || e.told === sid) return;
      /** The branch tip, asked for only where it is needed; a lead and a Reviewer have no branch (null), and a git that hangs or fails leaves the tip unknown (undefined, logged) instead of stopping the tick. */
      let tipAsked: Promise<number | null | undefined> | undefined;
      const tipOf = () =>
        (tipAsked ??= (async () => {
          if (h.role === "lead" || h.reviewer) return null;
          try {
            return await d.commitTime(repo, `worktree-${h.task}`);
          } catch (err) {
            console.log(`recovery ${basename(repo)}/${name}: ${(err as Error).message}`);
            return undefined; // unknown, which is not the same as no branch
          }
        })());
      const reportTo = async () => reportToOf(h, await d.promptOf(cwd, sid), repo);
      const tell = async (message: string, reason?: string) => {
        const to = await reportTo(); // before anything is recorded: a stop whose prompt cannot be read stays undecided and is tried again
        // The newest live session of that name first; if its inbox fails (a /clear moved the seat, a row with no session id), any seat with the title.
        const target = liveByName.get(to);
        const ok = (await safeTell(repo, to, message, target && String(target.sessionId ?? target.id))) || (target !== undefined && (await safeTell(repo, to, message)));
        e.told = sid;
        delete e.waitSid;
        delete e.wakeAt;
        e.note = `${message}${reason ? ` (${reason})` : ""}${ok ? "" : `; ${to} has no inbox`}`;
      };
      const wakeIt = async (note: string, failed: string) => {
        const wokeAt = d.now(); // before the wake: replies written while it starts count as progress
        const tip = await tipOf();
        try {
          await d.wake(repo, name, note);
        } catch (err) {
          return tell(failed, (err as Error).message);
        }
        e.wokeAt = wokeAt;
        e.wokeFrom = sid;
        e.tip = tip;
        delete e.told;
        delete e.waitSid;
        delete e.wakeAt;
        delete e.note;
      };
      const limited = `${name} stopped at the session limit; f1rm wake ${name}`;

      if (e.waitSid === sid) {
        if (now >= e.wakeAt!) await wakeIt(NOTE_LIMIT, limited);
        return;
      }
      const tailText = await d.tail(cwd, sid);
      const turn = lastTurn(tailText);
      const stoppedAt = (await d.mtime(cwd, sid)) ?? now;
      const limit = limitUntil(tailText);
      // A limit stop is judged on its reset whatever the turn held.
      if (limit !== null) {
        const reset = limit === "unknown" ? null : resetAt(limit, Date.parse(turn?.timestamp) || stoppedAt);
        if (reset === null) await tell(limited, "no reset time");
        else if (now >= reset + WAKE_AFTER_RESET_MS) await wakeIt(NOTE_LIMIT, limited);
        else {
          e.waitSid = sid;
          e.wakeAt = reset + WAKE_AFTER_RESET_MS;
          e.note = `waits for the session limit to lift (resets ${limit})`;
        }
        return;
      }
      // Any other end skips a hire whose last turn closed with its report (its row waits on a review, or an answer).
      if (turnReports(tailText).last) {
        e.note = `reported; waits on ${await reportTo()}`;
        e.told = sid;
        return;
      }
      const soon = e.wokeAt !== undefined && stoppedAt - e.wokeAt <= AGAIN_MS;
      if (soon && !madeProgress(tailText, e.wokeAt!, e.tip, await tipOf())) {
        await tell(`${name} stopped again after a wake; f1rm wake ${name}`);
        return;
      }
      await wakeIt(NOTE_ENDED, `${name} stopped; f1rm wake ${name}`);
    };
    for (const [name, cur] of newest) await judge(name, cur).catch((err) => console.log(`recovery ${basename(repo)}/${name}: ${(err as Error).message}`));
    for (const [name, e] of Object.entries(entries)) if (!Object.keys(e).length) delete entries[name];
    if (JSON.stringify(entries) !== before) d.store.save(repo, entries);
  }

  const safeTell = (repo: string, name: string, message: string, sessionId?: string) => d.tell(repo, name, message, sessionId).catch(() => false);

  /** A lead is quiet when every member of its team is: idle, and its transcript written 20 minutes ago or more (an ended one counts as quiet). */
  async function teamQuiet(newest: Map<string, any>, team: string | null, now: number): Promise<boolean> {
    for (const m of newest.values()) {
      const hm = hireName(m.name);
      if (!hm || hm.role === "lead" || hm.team !== team || !m.pid) continue;
      const mt = await d.mtime(String(m.cwd), String(m.sessionId ?? m.id));
      if (!(m.status === "idle" && mt != null && now - mt >= QUIET_MS)) return false;
    }
    return true;
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
    tail: (cwd, sessionId) => tailAsync(transcriptFile(home, cwd, sessionId)),
    mtime: (cwd, sessionId) => stat(transcriptFile(home, cwd, sessionId)).then((st) => st.mtimeMs, () => null),
    promptOf: async (cwd, sessionId) => firstPrompt(await headAsync(transcriptFile(home, cwd, sessionId))),
    commitTime: async (repo, branch) => {
      const out = await runAsync(commitTimeArgs(repo, branch));
      return out ? Number(out) * 1000 : null;
    },
    // The same checks as `f1rm wake`, caps included; the start is `claude --bg --resume` in the hire's own folder.
    wake: async (repo, name, note) => {
      const plan = await planWake({ target: name, message: note, cwd: repo }, realWakeDeps(home));
      await machine.spawnBackground(plan.argv, plan.cwd);
    },
    store: fileStore(home),
  };
}
