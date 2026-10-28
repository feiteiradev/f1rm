// Seam: the office's recovery tick. createRecovery against an injected `claude agents --json --all`, transcripts, boards, store, clock, wake and tell; the real wake code (planWake) for the caps.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryFile } from "../cli/status.ts";
import { HireRefused, LOAD_FIRST } from "../cli/hire.ts";
import { planWake } from "../cli/wake.ts";
import { parseBoard, type BoardRow } from "./board.ts";
import { sleepGrace } from "./sleep.ts";
import { createRecovery, fileStore, resetAt, type Entries } from "./recovery.ts";

setDefaultTimeout(30_000);
const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const REPO = "/code/shop";
const T0 = at("2026-10-22T18:00:00Z"); // 19:00 in Lisbon
const wt = (task: string) => `${REPO}/.claude/worktrees/${task}`;

type Listed = Record<string, unknown>;
// What `claude agents --json --all` lists: a live session has a pid; one whose process ended has none.
const entry = (name: string, sessionId: string, cwd: string, more: Listed = {}): Listed => ({ id: sessionId.slice(0, 8), kind: "background", name, sessionId, cwd, startedAt: 1000, ...more });
const live = (name: string, sessionId: string, cwd: string, more: Listed = {}) => entry(name, sessionId, cwd, { pid: 100 + sessionId.length, state: "working", status: "busy", ...more });
const ended = (name: string, sessionId: string, cwd: string, more: Listed = {}) => entry(name, sessionId, cwd, { state: "stopped", ...more });

// Transcript lines as Claude Code writes them (the wording and keys of real ones, nothing else).
const say = (text: string, ago: number, now = T0) => JSON.stringify({ type: "assistant", uuid: `u${ago}-${text.length}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } });
const limitStop = (until: string | null, ago: number, now = T0, kind = "session") =>
  JSON.stringify({ type: "assistant", timestamp: new Date(now - ago * MIN).toISOString(), isApiErrorMessage: true, apiError: "usage_limit_reached", message: { role: "assistant", content: [{ type: "text", text: `You've hit your ${kind} limit${until ? ` · resets ${until}` : ""}` }] } });
// The shapes real sessions write: a reply with thinking is several lines sharing one message.id, and a report is a SendMessage tool_use, then its tool_result, then closing prose.
const block = (id: string, ago: number, content: any, now = T0) => JSON.stringify({ type: "assistant", uuid: `${id}-${content.type}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { id, role: "assistant", content: [content] } });
const result = (ago: number, now = T0) => JSON.stringify({ type: "user", uuid: `r${ago}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sent" }] } });
const prompt = (text: string, ago: number, now = T0) => JSON.stringify({ type: "user", uuid: `p${ago}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: text } });
const sent = (message: string, closing: string, ago: number, now = T0) => [
  block("msg_r", ago + 1, { type: "tool_use", id: "t1", name: "SendMessage", input: { to: "lead-shop", message } }, now),
  result(ago + 0.5, now),
  block("msg_s", ago, { type: "text", text: closing }, now),
];
const row = (owner: string, status: string, task: string): BoardRow => ({ id: "T1", owner, status, branch: `worktree-${task}`, task: "x" });

/** A fake office: the listing, transcripts, boards and clock are set by the test; wakes and tells are recorded. */
function office(over: { real?: number; resting?: (now: number) => boolean; wake?: (repo: string, name: string, note: string) => Promise<void>; prompts?: Record<string, string> } = {}) {
  const w = {
    now: T0 + 5 * MIN,
    list: [] as Listed[],
    transcripts: {} as Record<string, string[]>,
    mtimes: {} as Record<string, number>,
    boards: { pm: [] as BoardRow[], shop: [] as BoardRow[] } as Record<string, BoardRow[]>,
    commits: {} as Record<string, number>,
    /** When (ms) each hire last ran `f1rm report`, by name. */
    reports: {} as Record<string, number>,
    woke: [] as { repo: string; name: string; note: string }[],
    told: [] as { to: string; message: string }[],
    toldSession: [] as (string | undefined)[],
    tailCalls: [] as string[],
    commitCalls: 0,
    inbox: true,
    /** A promise `sessions` waits for, to hold a tick in flight. */
    gate: undefined as Promise<void> | undefined,
    store: {} as Record<string, Entries>,
    /** The project is paused. */
    paused: false,
    /** The waits the resume asked for; `onSleep` runs at each, so a test can free a slot. */
    slept: [] as number[],
    onSleep: () => {},
  };
  const make = () => createRecovery({
    now: () => w.now,
    sessions: async () => (await w.gate, w.list),
    // The real readers are asynchronous (nothing may block the office's event loop), so the fakes are too.
    tail: async (_cwd, sid) => (w.tailCalls.push(sid), (w.transcripts[sid] ?? []).join("\n")),
    mtime: async (_cwd, sid) => w.mtimes[sid] ?? null,
    promptOf: async (_cwd, sid) => over.prompts?.[sid] ?? null,
    board: async (_repo, team) => w.boards[team ?? "pm"] ?? [],
    commitTime: async (_repo, branch) => (w.commitCalls++, w.commits[branch] ?? null),
    reportAt: async (_repo, name) => w.reports[name] ?? null,
    wake: over.wake ?? (async (repo, name, note) => void w.woke.push({ repo, name, note })),
    tell: async (_repo, to, message, sessionId) => (w.told.push({ to, message }), w.toldSession.push(sessionId), w.inbox),
    store: { load: (repo) => structuredClone(w.store[repo] ?? {}), save: (repo, e) => void (w.store[repo] = structuredClone(e)) },
    paused: () => w.paused,
    sleep: async (ms) => (w.slept.push(ms), w.onSleep()),
    // The fake clock jumps between ticks, so the sleep rule is off unless a test asks for the real one (`real`: the tick interval in ms).
    ...(over.real ? { everyMs: over.real } : { resting: over.resting ?? (() => false) }),
  });
  const rec = make();
  return { w, rec, make, tick: (repos = [REPO]) => rec.tick(repos) };
}

test("the reset time of a limit stop is read from its text: a time of day, a date, a weekday, each in the zone it names", () => {
  // 2026-10-22 is a Thursday; Lisbon is UTC+1 until Sunday 2026-10-25, UTC after.
  const stoppedAt = at("2026-10-22T18:00:00Z"); // 19:00 in Lisbon
  expect(resetAt("8:40pm (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-22T19:40:00Z"));
  expect(resetAt("6pm (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-23T17:00:00Z")); // 18:00 has passed: tomorrow's
  expect(resetAt("Oct 27, 9am (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-27T09:00:00Z"));
  expect(resetAt("Monday 9:00 (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-26T09:00:00Z"));
  expect(resetAt("Thursday 9:00 (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-29T09:00:00Z")); // today's 9:00 has passed: next week's
  expect(resetAt("11pm (America/New_York)", stoppedAt)).toBe(at("2026-10-23T03:00:00Z"));
  expect(resetAt("12am (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-22T23:00:00Z"));
  expect(resetAt("Jan 3, 9am (Europe/Lisbon)", stoppedAt)).toBe(at("2027-01-03T09:00:00Z")); // a date already past this year is next year's
  // The weekly limit says "Oct 28 at 6am" (no comma, the word "at").
  expect(resetAt("Oct 28 at 6am (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-28T06:00:00Z"));
  expect(resetAt("Oct 28 at 6:30am (Europe/Lisbon)", stoppedAt)).toBe(at("2026-10-28T06:30:00Z"));
  expect(resetAt("Nov 3 at 9pm (Europe/Lisbon)", stoppedAt)).toBe(at("2026-11-03T21:00:00Z"));
  expect(resetAt("Oct 28 at 6am", at("2026-10-22T18:00:00Z"))).not.toBeNull(); // no zone: this machine's
});

test("a text that names no time, or a zone that does not exist, has no reset time", () => {
  const stoppedAt = at("2026-10-22T18:00:00Z");
  for (const text of ["unknown", "soon", "", "25pm (Europe/Lisbon)", "9am (Mars/Olympus)", "Funday 9:00 (Europe/Lisbon)", "Oct 40, 9am (Europe/Lisbon)"]) expect([text, resetAt(text, stoppedAt)]).toEqual([text, null]);
});

const DEV = "shop.backend-dev-checkout";
const DEV_CWD = wt("checkout");
const NOTE_LIMIT = "resumed after the session limit; continue your task";
const NOTE_ENDED = "resumed after your session ended; continue your task";

/** The dev of the shop team stopped, its row doing, its transcript ending on `last`. */
function stoppedDev(o: ReturnType<typeof office>, last: string[], more: Listed = {}) {
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD, more)];
  o.w.transcripts["dev-1"] = [say("working on it", 30), ...last];
  o.w.mtimes["dev-1"] = T0;
  o.w.boards.shop = [row(DEV, "doing", "checkout")];
}

test("a hire that stopped on the session limit is woken about a minute after the reset time its text names, on a fake clock", async () => {
  // Stopped at 18:00Z (19:00 in Lisbon); "8:40pm (Europe/Lisbon)" is 19:40Z.
  const cases: [string, string, string][] = [
    ["8:40pm (Europe/Lisbon)", "2026-10-22T19:40:00Z", "the time of day"],
    ["Oct 27, 9am (Europe/Lisbon)", "2026-10-27T09:00:00Z", "a date"],
    ["Monday 9:00 (Europe/Lisbon)", "2026-10-26T09:00:00Z", "a weekday"],
  ];
  for (const [until, resets, label] of cases) {
    const o = office();
    stoppedDev(o, [limitStop(until, 0)]);
    const reset = at(resets);
    for (const now of [T0 + MIN, reset - MIN, reset, reset + 59_000]) {
      o.w.now = now;
      await o.tick();
      expect([label, new Date(now).toISOString(), o.w.woke]).toEqual([label, new Date(now).toISOString(), []]);
    }
    o.w.now = reset + MIN;
    await o.tick();
    expect([label, o.w.woke]).toEqual([label, [{ repo: REPO, name: DEV, note: NOTE_LIMIT }]]);
    o.w.now = reset + 5 * MIN;
    await o.tick();
    expect([label, o.w.woke.length]).toEqual([label, 1]); // each stop is woken once
  }
});

test("a hire that stopped on the WEEKLY limit is woken a minute after the date it names, 'You've hit your weekly limit · resets Oct 28 at 6am (Europe/Lisbon)', like a session limit stop", async () => {
  const o = office();
  stoppedDev(o, [limitStop("Oct 28 at 6am (Europe/Lisbon)", 0, T0, "weekly")]);
  const reset = at("2026-10-28T06:00:00Z");
  for (const now of [T0 + MIN, at("2026-10-27T12:00:00Z"), reset, reset + 59_000]) {
    o.w.now = now;
    await o.tick();
    expect([new Date(now).toISOString(), o.w.woke, o.w.told]).toEqual([new Date(now).toISOString(), [], []]);
  }
  expect(o.w.store[REPO][DEV].note).toContain("waits for the session limit to lift (resets Oct 28 at 6am (Europe/Lisbon))");
  o.w.now = reset + MIN;
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_LIMIT }]);
  o.w.now = reset + 5 * MIN;
  await o.tick();
  expect(o.w.woke).toHaveLength(1);
  // The session form still reads as before, beside it.
  const session = office();
  stoppedDev(session, [limitStop("8:40pm (Europe/Lisbon)", 0)]);
  session.w.now = at("2026-10-22T19:41:00Z");
  await session.tick();
  expect(session.w.woke).toHaveLength(1);
});

test("a limit stop that names no time is not woken: the session it reports to is told, once", async () => {
  const o = office();
  stoppedDev(o, [limitStop(null, 0)]);
  for (const min of [1, 2, 3]) {
    o.w.now = T0 + min * MIN;
    await o.tick();
  }
  expect(o.w.woke).toEqual([]);
  expect(o.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped at the session limit; f1rm wake ${DEV}` }]);
  expect(o.w.store[REPO][DEV].note).toContain(`stopped at the session limit; f1rm wake ${DEV}`);
});

test("a hire whose session ended with no limit stop (an update, a crash, a shutdown) is woken at once", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
  expect(o.w.told).toEqual([]);
});

test("each stop is woken once: the same ended session, a restart of the office, and the woken one still starting are no new stop", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  await o.tick();
  await o.tick();
  await o.make().tick([REPO]); // a restarted office reads what the first left
  expect(o.w.woke).toHaveLength(1);
  expect(o.w.told).toEqual([]); // the repeat is no new stop: not even a "stopped again" tell
});

test("a hire that ends again within 10 minutes of a wake with no progress is not woken again: its Report to is told, once", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  o.w.commits["worktree-checkout"] = T0 - 60 * MIN;
  await o.tick(); // woken at T0 + 5
  // The woken session (a new id) works a little and ends 4 minutes later: a reply and nothing more, no commit.
  const woke = o.w.now;
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
  o.w.transcripts["dev-2"] = [say("compiling", 1), say("on it", -1, woke)];
  o.w.mtimes["dev-2"] = woke + 4 * MIN;
  o.w.now = woke + 5 * MIN;
  await o.tick();
  await o.tick();
  expect(o.w.woke).toHaveLength(1);
  expect(o.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped again after a wake; f1rm wake ${DEV}` }]);
  expect(o.w.store[REPO][DEV].note).toContain("stopped again after a wake");
});

test("a hire that made progress before it ended again, or ended more than 10 minutes after the wake, is woken again", async () => {
  const run = async (progress: (o: ReturnType<typeof office>, woke: number) => void, endedAfter: number) => {
    const o = office();
    stoppedDev(o, [say("compiling", 1)]);
    o.w.commits["worktree-checkout"] = T0 - 60 * MIN;
    await o.tick();
    const woke = o.w.now;
    o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
    o.w.transcripts["dev-2"] = [say("compiling", 1), say("on it", -1, woke)];
    o.w.mtimes["dev-2"] = woke + endedAfter * MIN;
    progress(o, woke);
    o.w.now = woke + endedAfter * MIN + MIN;
    await o.tick();
    return o;
  };
  expect((await run((o, woke) => void (o.w.commits["worktree-checkout"] = woke + MIN), 4)).w.woke).toHaveLength(2); // a new commit
  expect((await run((o, woke) => void o.w.transcripts["dev-2"].push(say("tests", -2, woke), say("fixing", -3, woke)), 4)).w.woke).toHaveLength(2); // more than the reply to the wake
  const late = await run(() => {}, 11);
  expect(late.w.woke).toHaveLength(2);
  expect(late.w.told).toEqual([]);
});

test("a hire that stops on the limit again waits for the next reset, whatever the 10 minutes say", async () => {
  const o = office();
  stoppedDev(o, [limitStop("8:40pm (Europe/Lisbon)", 0)]);
  o.w.now = at("2026-10-22T19:41:00Z");
  await o.tick();
  expect(o.w.woke).toHaveLength(1);
  // Woken at 19:41, it hits the next limit at 19:45; the stop says it lifts at 11pm Lisbon (22:00Z).
  const stop = at("2026-10-22T19:45:00Z");
  o.w.list = [ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 }), live("lead-shop", "lead-sid", REPO, { status: "idle" })];
  o.w.transcripts["dev-2"] = [limitStop("11pm (Europe/Lisbon)", 0, stop)];
  o.w.mtimes["dev-2"] = stop;
  for (const now of [stop + MIN, at("2026-10-22T22:00:30Z")]) {
    o.w.now = now;
    await o.tick();
    expect(o.w.woke).toHaveLength(1);
  }
  o.w.now = at("2026-10-22T22:01:00Z");
  await o.tick();
  expect(o.w.woke.map((x) => [x.name, x.note])).toEqual([[DEV, NOTE_LIMIT], [DEV, NOTE_LIMIT]]);
  expect(o.w.told).toEqual([]);
});

test("a stop that cannot be woken (a refusal, an error) is told the same way, once", async () => {
  const o = office({ wake: async () => { throw new Error("can't list the sessions"); } });
  stoppedDev(o, [say("compiling", 1)]);
  await o.tick();
  await o.tick();
  expect(o.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped; f1rm wake ${DEV}` }]);
  const limited = office({ wake: async () => { throw new Error("no"); } });
  stoppedDev(limited, [limitStop("8:40pm (Europe/Lisbon)", 0)]);
  limited.w.now = at("2026-10-22T19:41:00Z");
  await limited.tick();
  expect(limited.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped at the session limit; f1rm wake ${DEV}` }]);
});

test("the session a hire reports to is the one its first prompt named; a lead reports to the PM; with no inbox the note says so", async () => {
  const o = office({ prompts: { "dev-1": "brief\nReport to: lead-shop-other" } });
  stoppedDev(o, [limitStop(null, 0)]);
  o.w.inbox = false;
  await o.tick();
  expect(o.w.told.map((t) => t.to)).toEqual(["lead-shop-other"]);
  expect(o.w.store[REPO][DEV].note).toContain("lead-shop-other has no inbox");

  const lead = office();
  lead.w.list = [ended("lead-shop", "lead-1", REPO)];
  lead.w.transcripts["lead-1"] = [limitStop(null, 0)];
  lead.w.mtimes["lead-1"] = T0;
  lead.w.boards.pm = [row("lead-shop", "doing", "shop")];
  await lead.tick();
  expect(lead.w.told).toEqual([{ to: "pm-shop", message: "lead-shop stopped at the session limit; f1rm wake lead-shop" }]);
});

test("a lead is woken when the PM's board has it doing; a Reviewer when the row for its task is in review", async () => {
  const o = office();
  o.w.list = [ended("lead-shop", "lead-1", REPO), ended("shop.reviewer-review-checkout", "rev-1", REPO)];
  o.w.transcripts = { "lead-1": [say("hiring", 3)], "rev-1": [say("reviewing", 3)] };
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "review", "checkout")];
  await o.tick();
  expect(o.w.woke.map((x) => x.name)).toEqual(["lead-shop", "shop.reviewer-review-checkout"]);
});

test("the caps are the same code as hire and wake: a full team is not woken past its cap, and its Report to is told", async () => {
  // The wake is planWake itself, against the fake listing: its refusals are the ones `f1rm wake` gives.
  const planning = () => {
    const o: ReturnType<typeof office> = office({
      wake: async (repo, name, note) => {
        const list = o.w.list;
        await planWake({ target: name, message: note, cwd: repo }, {
          agents: async (all) => (all ? list : list.filter((a) => a.pid || a.state === "blocked")),
          gitCommonDir: () => `${REPO}/.git`, home: "/nonexistent-home", now: T0, exists: () => true, modelOf: () => null, promptOf: () => null,
        });
      },
    });
    return o;
  };
  const team = [live("lead-shop", "lead-sid", REPO), live("shop.designer-a", "a-sid", wt("a"))];
  const full = planning();
  stoppedDev(full, [say("compiling", 1)]);
  full.w.list = [...team, live("shop.designer-b", "b-sid", wt("b")), ended(DEV, "dev-1", DEV_CWD)];
  await full.tick();
  expect(full.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped; f1rm wake ${DEV}` }]);
  expect(full.w.store[REPO][DEV].note).toContain("already has 2 working");
  // The same stop with room in the team goes through planWake and is woken: no refusal, nobody told.
  const free = planning();
  stoppedDev(free, [say("compiling", 1)]);
  free.w.list = [...team, ended(DEV, "dev-1", DEV_CWD)];
  await free.tick();
  expect(free.w.told).toEqual([]);
  expect(free.w.store[REPO][DEV].wokeFrom).toBe("dev-1");
});

test("it never wakes an interactive session, the PM, a let-go hire, a stop whose report was sent, or a project that is not registered", async () => {
  const stopped = async (patch: (o: ReturnType<typeof office>) => void, repos = [REPO]) => {
    const o = office();
    stoppedDev(o, [say("compiling", 1)]);
    patch(o);
    await o.tick(repos);
    return o.w;
  };
  expect((await stopped(() => {})).woke).toHaveLength(1); // the control: the same stop is woken
  expect((await stopped((o) => (o.w.list[1].kind = "interactive"))).woke).toEqual([]);
  expect((await stopped((o) => (o.w.list[1].kind = "foreground"))).woke).toEqual([]);
  for (const status of ["done", "todo", "blocked", "publish"]) expect([status, (await stopped((o) => (o.w.boards.shop = [row(DEV, status, "checkout")]))).woke]).toEqual([status, []]);
  expect((await stopped((o) => (o.w.boards.shop = []))).woke).toEqual([]); // let go: no row
  expect((await stopped((o) => (o.w.boards.shop = [row("shop.designer-landing", "doing", "landing")]))).woke).toEqual([]); // another hire's row
  expect((await stopped(() => {}, [])).woke).toEqual([]);
  expect((await stopped(() => {}, ["/code/other"])).woke).toEqual([]);
  expect((await stopped((o) => (o.w.list[1].cwd = "/code/other/.claude/worktrees/checkout"))).woke).toEqual([]); // another project's session of this name
  const pm = office();
  pm.w.list = [ended("pm-shop", "pm-1", REPO)];
  pm.w.transcripts["pm-1"] = [say("planning", 3)];
  pm.w.boards.pm = [row("pm-shop", "doing", "shop")];
  await pm.tick();
  expect(pm.w.woke).toEqual([]);
  for (const report of ["DONE checkout", "APPROVED", "CHANGES REQUESTED round 2", "BLOCKED checkout: no key", "ESCALATE x", "NEEDS YOU shop: a choice"]) {
    expect([report, (await stopped((o) => (o.w.transcripts["dev-1"] = [say("working", 30), ...sent(report, "Sent.", 1)]))).woke]).toEqual([report, []]);
  }
  expect((await stopped((o) => (o.w.transcripts["dev-1"] = [say("working", 30), say("Not DONE yet, compiling", 1)]))).woke).toHaveLength(1);
});

test("the note a woken hire gets never repeats the sentence that tells it which skills to load", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  await o.tick();
  expect(o.w.woke[0].note).not.toContain(LOAD_FIRST.trim());
});

// ── the nudge ──────────────────────────────────────────────────────────────
const NUDGE = "your turn ended without a report; send your DONE or BLOCKED";
const REVIEWER = "shop.reviewer-review-checkout";

/** The Reviewer is live and idle; its turn ended `ago` minutes before the office's clock with `last`. */
function idleReviewer(o: ReturnType<typeof office>, last: string, ago: number, more: Listed = {}) {
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), live(REVIEWER, "rev-1", REPO, { status: "idle", ...more })];
  o.w.transcripts["rev-1"] = [say("reviewing", ago + 10, o.w.now), say(last, ago, o.w.now)];
  o.w.mtimes["rev-1"] = o.w.now - ago * MIN;
  o.w.boards.shop = [row(DEV, "review", "checkout")];
}

test("a live idle hire whose turn ended without a report 20 minutes ago is nudged once, in its own inbox", async () => {
  const o = office();
  idleReviewer(o, "Review complete: the diff looks right.", 25);
  await o.tick();
  await o.tick();
  expect(o.w.told).toEqual([{ to: REVIEWER, message: NUDGE }]);
  // A new turn that ends without a report is a new nudge, after its own 20 minutes.
  o.w.now += 60 * MIN;
  o.w.transcripts["rev-1"].push(say("Checked again, still fine.", 30, o.w.now));
  o.w.mtimes["rev-1"] = o.w.now - 30 * MIN;
  await o.tick();
  expect(o.w.told).toHaveLength(2);
});

test("no nudge for a hire that is busy, quiet for less than 20 minutes, reported, or whose row is not doing/review", async () => {
  const none = async (patch: (o: ReturnType<typeof office>) => void, last = "Review complete.", ago = 25) => {
    const o = office();
    idleReviewer(o, last, ago);
    patch(o);
    await o.tick();
    return o.w.told;
  };
  expect(await none(() => {}, "Review complete.", 19)).toEqual([]);
  expect(await none((o) => (o.w.list[1].status = "busy"))).toEqual([]);
  for (const status of ["done", "todo", "blocked"]) expect([status, await none((o) => (o.w.boards.shop = [row(DEV, status, "checkout")]))]).toEqual([status, []]);
  for (const report of ["APPROVED abc123", "CHANGES REQUESTED: 2 findings", "DONE review", "BLOCKED review", "ESCALATE", "NEEDS YOU shop: x"]) expect([report, await none((o) => (o.w.transcripts["rev-1"] = [say("reviewing", 40, o.w.now), ...sent(report, "Sent.", 25, o.w.now)]))]).toEqual([report, []]);
  expect(await none((o) => (o.w.transcripts["rev-1"] = [say("reviewing", 40, o.w.now), limitStop("8pm", 25, o.w.now)]))).toEqual([]); // a limit stop is no turn end
  expect(await none((o) => (o.w.list = [o.w.list[0]]))).toEqual([]); // not listed
});

test("a lead waiting on a team that is still working is not nudged; one whose whole team is quiet is", async () => {
  const lead = async (member: Listed) => {
    const o = office();
    o.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), member];
    o.w.transcripts["lead-1"] = [say("Hired the dev; watching.", 30, o.w.now)];
    o.w.mtimes["lead-1"] = o.w.now - 30 * MIN;
    o.w.mtimes["m-1"] = o.w.now - 5 * MIN;
    o.w.boards.pm = [row("lead-shop", "doing", "shop")];
    await o.tick();
    return o.w.told;
  };
  expect(await lead(live(DEV, "m-1", DEV_CWD, { status: "busy" }))).toEqual([]);
  expect(await lead(live(DEV, "m-1", DEV_CWD, { status: "idle" }))).toEqual([]); // wrote 5 minutes ago
  const quiet = office();
  quiet.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), live(DEV, "m-1", DEV_CWD, { status: "idle" })];
  quiet.w.transcripts["lead-1"] = [say("Hired the dev; watching.", 30, quiet.w.now)];
  quiet.w.mtimes = { "lead-1": quiet.w.now - 30 * MIN, "m-1": quiet.w.now - 40 * MIN };
  quiet.w.boards.pm = [row("lead-shop", "doing", "shop")];
  await quiet.tick();
  expect(quiet.w.told).toEqual([{ to: "lead-shop", message: NUDGE }]);
});

test("when the inbox cannot be reached the nudge is shown in the hire's note, not claimed, and not retried", async () => {
  const o = office();
  o.w.inbox = false;
  idleReviewer(o, "Review complete.", 25);
  await o.tick();
  await o.tick();
  expect(o.w.told).toHaveLength(1);
  expect(o.w.store[REPO][REVIEWER].note).toContain("turn ended without a report");
  // The hire writes again: the note goes.
  o.w.transcripts["rev-1"].push(say("DONE review", 0, o.w.now));
  o.w.mtimes["rev-1"] = o.w.now;
  await o.tick();
  expect(o.w.store[REPO][REVIEWER].note).toBeUndefined();
});

test("a recovered hire, or one that is gone from the listing, loses its note and its memory", async () => {
  const o = office();
  stoppedDev(o, [limitStop(null, 0)]);
  await o.tick();
  expect(o.w.store[REPO][DEV].note).toBeDefined();
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), live(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
  await o.tick();
  expect(o.w.store[REPO][DEV]?.note).toBeUndefined();
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" })];
  await o.tick();
  expect(o.w.store[REPO][DEV]).toBeUndefined();
});

test("a report sent with SendMessage counts, whatever prose closes the turn: an idle Reviewer that sent APPROVED is not nudged, an ended dev that sent DONE is not woken", async () => {
  for (const word of ["DONE checkout", "APPROVED shop-1", "CHANGES REQUESTED shop-1: fix x", "BLOCKED checkout: no key", "ESCALATE shop-1", "NEEDS YOU shop: a choice"]) {
    const reviewer = office();
    idleReviewer(reviewer, "x", 25);
    reviewer.w.transcripts["rev-1"] = [say("reviewing", 40, reviewer.w.now), ...sent(word, `I sent ${word.split(" ")[0]} to lead-shop.`, 25, reviewer.w.now)];
    await reviewer.tick();
    expect([word, reviewer.w.told]).toEqual([word, []]);
    const dev = office();
    stoppedDev(dev, sent(word, "I sent my report to lead-shop.", 1));
    await dev.tick();
    expect([word, dev.w.woke, dev.w.told]).toEqual([word, [], []]);
  }
});

test("a SendMessage that is no report, a report from an earlier turn, and prose that merely mentions one do not count", async () => {
  const nudged = async (lines: (now: number) => string[]) => {
    const o = office();
    idleReviewer(o, "x", 25);
    o.w.transcripts["rev-1"] = lines(o.w.now);
    await o.tick();
    return o.w.told;
  };
  const NUDGED = [{ to: REVIEWER, message: NUDGE }];
  expect(await nudged((now) => [say("reviewing", 40, now), ...sent("Can you check the contract?", "Asked the lead.", 25, now)])).toEqual(NUDGED);
  // The report is from before the prompt that started this turn (a resume, a fix round): the new turn has not reported.
  expect(await nudged((now) => [...sent("APPROVED shop-1", "Sent.", 60, now), prompt("one more round", 30, now), say("Looked at it again.", 25, now)])).toEqual(NUDGED);
  expect(await nudged((now) => [say("I will send APPROVED when the merge is clean.", 25, now)])).toEqual(NUDGED);
  // A report followed by tool results and more work in the same turn still counts as reported.
  expect(await nudged((now) => [prompt("review it", 60, now), ...sent("APPROVED shop-1", "Sent.", 40, now), block("msg_t", 30, { type: "text", text: "Cleaning up the scratch worktree." }, now)])).toEqual([]);
});

test("progress counts assistant messages, not transcript lines: one reply with thinking is two lines and one message", async () => {
  const run = async (after: (woke: number) => string[]) => {
    const o = office();
    stoppedDev(o, [say("compiling", 1)]);
    o.w.commits["worktree-checkout"] = T0 - 60 * MIN;
    await o.tick();
    const woke = o.w.now;
    o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
    o.w.transcripts["dev-2"] = [say("compiling", 1), ...after(woke)];
    o.w.mtimes["dev-2"] = woke + 4 * MIN;
    o.w.now = woke + 5 * MIN;
    await o.tick();
    return o.w;
  };
  // The reply to the wake: thinking, then text, one message id. Nothing else was written, so its Report to is told, not another wake.
  const reply = (woke: number) => [block("msg_w", -1, { type: "thinking", thinking: "resume" }, woke), block("msg_w", -1, { type: "text", text: "on it" }, woke)];
  const stuck = await run(reply);
  expect(stuck.woke).toHaveLength(1);
  expect(stuck.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped again after a wake; f1rm wake ${DEV}` }]);
  // A second message (its next step) is progress.
  const moved = await run((woke) => [...reply(woke), block("msg_x", -2, { type: "tool_use", id: "t9", name: "Bash", input: { command: "bun test" } }, woke)]);
  expect(moved.woke).toHaveLength(2);
  expect(moved.told).toEqual([]);
});

test("a board row counts when its status cell starts with doing or review, and when parseBoard clipped a long owner", async () => {
  const woken = async (status: string, owner: string, name = DEV) => {
    const o = office();
    stoppedDev(o, [say("compiling", 1)]);
    o.w.list[1] = ended(name, "dev-1", DEV_CWD);
    o.w.boards.shop = [row(owner, status, "checkout")];
    await o.tick();
    return o.w.woke.length;
  };
  expect(await woken("review (live proof waits for the user)", DEV)).toBe(1);
  expect(await woken("doing, blocked on the key", DEV)).toBe(1);
  expect(await woken("reviewed", DEV)).toBe(0);
  expect(await woken("doing-nothing", DEV)).toBe(0);
  const long = `shop.backend-dev-${"x".repeat(60)}`;
  const clipped = `${long.slice(0, 59)}…`; // what parseBoard keeps of a 60-character owner cell
  expect(clipped).toHaveLength(60);
  expect(await woken("doing", clipped, long)).toBe(1);
  expect(await woken("doing", `${"y".repeat(59)}…`, long)).toBe(0);
});

test("the file store writes a private file and never follows a link planted at its temp name", () => {
  const home = mkdtempSync(join(tmpdir(), "f1rm-store-"));
  const store = fileStore(home);
  store.save(REPO, { [DEV]: { note: "first" } });
  const file = recoveryFile(home, REPO);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(store.load(REPO)).toEqual({ [DEV]: { note: "first" } });
  const victim = join(home, "victim.txt");
  writeFileSync(victim, "keep");
  symlinkSync(victim, `${file}.tmp`);
  store.save(REPO, { [DEV]: { note: "second" } });
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(store.load(REPO)).toEqual({ [DEV]: { note: "second" } });
  writeFileSync(file, "{cut");
  expect(store.load(REPO)).toEqual({});
  rmSync(home, { recursive: true, force: true });
});

test("a reset time that falls in a spring-forward gap is the stated time plus the gap (JS Date's own rule), never an hour before; an hour that happens twice is the later one", () => {
  // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z), so 2:30am does not exist: it reads as 03:30 EDT.
  expect(resetAt("2:30am (America/New_York)", at("2026-03-08T05:00:00Z"))).toBe(at("2026-03-08T07:30:00Z"));
  // Lisbon 2027-03-28: 01:00 WET jumps to 02:00 WEST (01:00Z): 1:30am reads as 02:30 WEST.
  expect(resetAt("1:30am (Europe/Lisbon)", at("2027-03-27T12:00:00Z"))).toBe(at("2027-03-28T01:30:00Z"));
  // Lisbon 2026-10-25: 02:00 WEST falls back to 01:00 WET, so 1:30am happens at 00:30Z and again at 01:30Z; the later is when the limit has surely lifted.
  expect(resetAt("1:30am (Europe/Lisbon)", at("2026-10-24T23:00:00Z"))).toBe(at("2026-10-25T01:30:00Z"));
  // Ordinary days next to a change are unaffected.
  expect(resetAt("2:30am (America/New_York)", at("2026-03-09T05:00:00Z"))).toBe(at("2026-03-09T06:30:00Z"));
});

// Round 2: the ended path skips a hire only when its last turn ENDS with a delivered report; a limit stop is judged on its reset first.
const tool = (id: string, ago: number, name: string, input: any, now = T0) => block(id, ago, { type: "tool_use", id: `t-${id}`, name, input }, now);
const toolResult = (id: string, ago: number, now = T0, isError = false) =>
  JSON.stringify({ type: "user", uuid: `tr-${id}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t-${id}`, content: isError ? "refused" : "ok", ...(isError && { is_error: true }) }] } });
const notification = (ago: number, now = T0) => JSON.stringify({ type: "user", uuid: `n${ago}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: "<task-notification>background task finished</task-notification>" } });
const skillText = (ago: number, now = T0) => JSON.stringify({ type: "user", uuid: `s${ago}`, isMeta: true, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } });
const midReport = (word: string, now = T0) => [say("working", 40, now), ...sent(word, "Carrying on with the rest.", 30, now).slice(0, 2), tool("m2", 20, "Bash", { command: "bun test" }, now), toolResult("m2", 19, now)];

test("a limit stop is judged on its reset first: a report sent mid-turn, followed by more work and the stop, does not hide the hire", async () => {
  const o = office();
  stoppedDev(o, [...midReport("BLOCKED checkout: no API key; carrying on").slice(1), limitStop("8:40pm (Europe/Lisbon)", 10)]);
  o.w.now = at("2026-10-22T19:42:00Z");
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_LIMIT }]);
  // And one that names no time is told, not skipped.
  const none = office();
  stoppedDev(none, [...midReport("BLOCKED checkout: no API key").slice(1), limitStop(null, 10)]);
  await none.tick();
  expect(none.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped at the session limit; f1rm wake ${DEV}` }]);
});

test("an ended hire is skipped only when its last turn ends with a delivered report: more tool work after the report, a refused send, or none at all, wakes it", async () => {
  const woken = async (last: string[]) => {
    const o = office();
    stoppedDev(o, last);
    await o.tick();
    return o.w.woke.length;
  };
  const delivered = (word: string) => [tool("r1", 3, "SendMessage", { to: "lead-shop", message: word }), toolResult("r1", 2.5)];
  expect(await woken(delivered("DONE checkout"))).toBe(0); // the report closes the turn
  expect(await woken([...delivered("DONE checkout"), block("msg_c", 1, { type: "text", text: "Sent." })])).toBe(0); // only text after it
  expect(await woken(midReport("BLOCKED checkout: no key"))).toBe(1); // a crash after a mid-turn report and more work
  expect(await woken([...delivered("DONE checkout"), tool("w2", 2, "Bash", { command: "git status" })])).toBe(1); // work after it, cut off in the middle
  expect(await woken([tool("r1", 3, "SendMessage", { to: "lead-shop", message: "DONE checkout" }), toolResult("r1", 2.5, T0, true), block("msg_c", 1, { type: "text", text: "It was refused." })])).toBe(1); // never delivered
  expect(await woken([tool("r1", 3, "SendMessage", { to: "lead-shop", message: "DONE checkout" })])).toBe(1); // cut before its result
});

test("a background task finishing or a skill's meta line is no new turn, so a report before it still stands; a refused SendMessage is no report for the nudge either", async () => {
  const nudged = async (lines: (now: number) => string[]) => {
    const o = office();
    idleReviewer(o, "x", 25);
    o.w.transcripts["rev-1"] = lines(o.w.now);
    await o.tick();
    return o.w.told;
  };
  const reported = (now: number) => [tool("r1", 40, "SendMessage", { to: "lead-shop", message: "APPROVED shop-1" }, now), toolResult("r1", 39, now)];
  expect(await nudged((now) => [...reported(now), notification(30, now), block("msg_p", 25, { type: "text", text: "The merge check finished." }, now)])).toEqual([]);
  expect(await nudged((now) => [...reported(now), skillText(30, now), block("msg_p", 25, { type: "text", text: "Loaded it." }, now)])).toEqual([]);
  expect(await nudged((now) => [...reported(now), JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(now - 30 * MIN).toISOString(), content: "<task-notification>x</task-notification>" }), block("msg_p", 25, { type: "text", text: "Done with it." }, now)])).toEqual([]);
  const refused = (now: number) => [tool("r1", 40, "SendMessage", { to: "lead-shop", message: "APPROVED shop-1" }, now), toolResult("r1", 39, now, true), block("msg_p", 25, { type: "text", text: "The gate refused it." }, now)];
  expect(await nudged(refused)).toEqual([{ to: REVIEWER, message: NUDGE }]);
});

test("a Reviewer whose task slug is long matches the branch cell parseBoard clipped", async () => {
  const slug = "a-very-long-task-slug-".repeat(3).slice(0, 55);
  const reviewer = `shop.reviewer-review-${slug}`;
  const o = office();
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(reviewer, "rev-1", REPO)];
  o.w.transcripts["rev-1"] = [say("reviewing", 3)];
  // What the office reads from the file: every cell passed through parseBoard, which keeps 60 characters of the branch.
  const [parsed] = parseBoard(`| T1 | shop.backend-dev-x | review | worktree-${slug} | x |`);
  expect(parsed.branch).toHaveLength(60);
  o.w.boards.shop = [parsed];
  await o.tick();
  expect(o.w.woke.map((x) => x.name)).toEqual([reviewer]);
});

test("the Report to is told through its newest live session, not whichever seat comes first", async () => {
  const o = office();
  stoppedDev(o, [limitStop(null, 0)]);
  o.w.list = [...o.w.list, live("lead-shop", "lead-new", REPO, { startedAt: 5000, status: "idle" }), ended("lead-shop", "lead-gone", REPO, { startedAt: 9 })];
  await o.tick();
  expect(o.w.told.map((t) => t.to)).toEqual(["lead-shop"]);
  expect(o.w.toldSession).toEqual(["lead-new"]);
});

test("an ended session already woken or told is not read again, and the branch tip is asked for once per tick", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  o.w.commits["worktree-checkout"] = T0 - 60 * MIN;
  await o.tick();
  expect(o.w.woke).toHaveLength(1);
  o.w.tailCalls.length = 0;
  await o.tick();
  expect(o.w.tailCalls.filter((sid) => sid === "dev-1")).toEqual([]); // the 256 KB tail is not read for a stop that is handled
  // Ended again soon with progress (a commit): woken again, and the tip is asked for once.
  const woke = o.w.now;
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
  o.w.transcripts["dev-2"] = [say("compiling", 1)];
  o.w.mtimes["dev-2"] = woke + 4 * MIN;
  o.w.commits["worktree-checkout"] = woke + MIN;
  o.w.now = woke + 5 * MIN;
  o.w.commitCalls = 0;
  await o.tick();
  expect(o.w.woke).toHaveLength(2);
  expect(o.w.commitCalls).toBe(1);
});

// ── round 3: one rule ─────────────────────────────────────────────────────
test("only a delivered SendMessage that is the turn's last tool call is a report: text never is, and a refused send followed by 'DONE ...' text is still a nudge", async () => {
  const nudged = async (lines: (now: number) => string[]) => {
    const o = office();
    idleReviewer(o, "x", 25);
    o.w.transcripts["rev-1"] = lines(o.w.now);
    await o.tick();
    return o.w.told.length;
  };
  expect(await nudged((now) => [say("reviewing", 40, now), say("DONE checkout", 25, now)])).toBe(1);
  expect(await nudged((now) => [tool("r1", 40, "SendMessage", { to: "lead-shop", message: "DONE checkout" }, now), toolResult("r1", 39, now, true), say("DONE checkout, but the send was refused", 25, now)])).toBe(1);
  const woken = async (last: string[]) => {
    const o = office();
    stoppedDev(o, last);
    await o.tick();
    return o.w.woke.length;
  };
  expect(await woken([say("DONE checkout", 1)])).toBe(1);
  expect(await woken([tool("r1", 3, "SendMessage", { to: "lead-shop", message: "DONE checkout" }), toolResult("r1", 2.5, T0, true), say("DONE checkout, but the send was refused", 1)])).toBe(1);
  expect(await woken([tool("r1", 3, "SendMessage", { to: "lead-shop", message: "DONE checkout" }), toolResult("r1", 2.5), block("msg_w", 2, { type: "text", text: "Sent." })])).toBe(0);
});

test("a stop the office skips because the turn closed with a report is recorded once, with a NOTE, and its transcript is not read again", async () => {
  const o = office({ prompts: { "dev-1": "brief\nReport to: lead-shop" } });
  stoppedDev(o, sent("DONE checkout", "Sent.", 1));
  await o.tick();
  expect(o.w.woke).toEqual([]);
  expect(o.w.store[REPO][DEV]).toMatchObject({ told: "dev-1", note: "reported; waits on lead-shop" });
  o.w.tailCalls.length = 0;
  await o.tick();
  await o.tick();
  expect(o.w.tailCalls.filter((sid) => sid === "dev-1")).toEqual([]);
  expect(o.w.told).toEqual([]); // it reported; nobody is told it stopped
});

test("a limit stop that is not due yet is recorded once with its wake time and a NOTE, and woken from the store when due, without reading the transcript again", async () => {
  const o = office();
  stoppedDev(o, [limitStop("8:40pm (Europe/Lisbon)", 0)]);
  o.w.now = at("2026-10-22T18:30:00Z");
  await o.tick();
  expect(o.w.store[REPO][DEV]).toMatchObject({ waitSid: "dev-1", wakeAt: at("2026-10-22T19:41:00Z") });
  expect(o.w.store[REPO][DEV].note).toContain("waits for the session limit");
  o.w.tailCalls.length = 0;
  o.w.now = at("2026-10-22T19:00:00Z");
  await o.tick();
  expect(o.w.tailCalls.filter((sid) => sid === "dev-1")).toEqual([]);
  expect(o.w.woke).toEqual([]);
  o.w.now = at("2026-10-22T19:41:00Z");
  await o.tick();
  expect(o.w.tailCalls.filter((sid) => sid === "dev-1")).toEqual([]);
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_LIMIT }]);
  expect(o.w.store[REPO][DEV]).toMatchObject({ wokeFrom: "dev-1" });
  expect(o.w.store[REPO][DEV].waitSid).toBeUndefined();
  expect(o.w.store[REPO][DEV].note).toBeUndefined();
});

test("a live hire that is busy, or idle and already judged at this write, has its transcript left unread", async () => {
  const busy = office();
  idleReviewer(busy, "Review complete.", 25, { status: "busy" });
  await busy.tick();
  expect(busy.w.tailCalls).toEqual([]);
  const o = office();
  idleReviewer(o, "Review complete.", 25);
  await o.tick();
  expect(o.w.tailCalls).toEqual(["rev-1"]);
  expect(o.w.told).toHaveLength(1);
  await o.tick();
  await o.tick();
  expect(o.w.tailCalls).toEqual(["rev-1"]);
  expect(o.w.told).toHaveLength(1);
  // A new write is a new judgement.
  o.w.now += 60 * MIN;
  o.w.transcripts["rev-1"].push(say("Looked again.", 30, o.w.now));
  o.w.mtimes["rev-1"] = o.w.now - 30 * MIN;
  await o.tick();
  expect(o.w.tailCalls).toEqual(["rev-1", "rev-1"]);
  expect(o.w.told).toHaveLength(2);
});

test("when the tell to the newest session fails, the Report to is tried again by its title", async () => {
  const o = office();
  stoppedDev(o, [limitStop(null, 0)]);
  const tried: (string | undefined)[] = [];
  const make = createRecovery({
    resting: () => false,
    now: () => o.w.now, sessions: async () => o.w.list, tail: async (_c, sid) => (o.w.transcripts[sid] ?? []).join("\n"), mtime: async () => null, promptOf: async () => null,
    board: async (_r, team) => o.w.boards[team ?? "pm"] ?? [], commitTime: async () => null, wake: async () => {},
    tell: async (_r, _to, _m, sessionId) => (tried.push(sessionId), sessionId === undefined),
    store: { load: (repo) => structuredClone(o.w.store[repo] ?? {}), save: (repo, e) => void (o.w.store[repo] = structuredClone(e)) },
  });
  await make.tick([REPO]);
  expect(tried).toEqual(["lead-sid", undefined]);
  expect(o.w.store[REPO][DEV].note).not.toContain("no inbox");
});

// A cross-session message is logged as an isMeta user line with no enqueue before it, and it starts a turn.
const crossSession = (ago: number, now = T0) => JSON.stringify({ type: "user", isMeta: true, uuid: `x${ago}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="lead-shop">Re-review please</cross-session-message>' } });
test("a cross-session message starts a turn: a re-review that ends without a verdict is nudged although the earlier round reported", async () => {
  const o = office();
  idleReviewer(o, "x", 25);
  o.w.transcripts["rev-1"] = [say("reviewing", 90, o.w.now), ...sent("CHANGES REQUESTED checkout: 2 findings", "Sent.", 80, o.w.now), crossSession(40, o.w.now), say("Round 2 looks fine overall.", 25, o.w.now)];
  await o.tick();
  expect(o.w.told).toEqual([{ to: REVIEWER, message: NUDGE }]);
});

// ── round 4: a record holds only while its session stays ended ─────────────
test("a lead skipped because a member was still active is judged again when the team goes quiet, although its own transcript did not change", async () => {
  const o = office();
  const member = (status: string, ago: number) => live(DEV, "m-1", DEV_CWD, { status });
  o.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), member("busy", 1)];
  o.w.transcripts["lead-1"] = [say("Hired the dev; watching.", 30, o.w.now)];
  o.w.mtimes = { "lead-1": o.w.now - 30 * MIN, "m-1": o.w.now };
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  await o.tick();
  expect(o.w.told).toEqual([]);
  // The member writes its last line and goes quiet; the lead's transcript is unchanged.
  o.w.now += 25 * MIN;
  o.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), member("idle", 1)];
  o.w.mtimes = { "lead-1": o.w.now - 55 * MIN, "m-1": o.w.now - 22 * MIN };
  await o.tick();
  expect(o.w.told).toEqual([{ to: "lead-shop", message: NUDGE }]);
});

test("a session resumed in place (it keeps its id) and then ended again without a report is a new stop, whatever was recorded for the first", async () => {
  const o = office();
  stoppedDev(o, sent("DONE checkout", "Sent.", 1));
  await o.tick();
  expect(o.w.store[REPO][DEV]).toMatchObject({ told: "dev-1", note: "reported; waits on lead-shop" });
  // The user attaches: the same session id runs again for a tick.
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), live(DEV, "dev-1", DEV_CWD)];
  await o.tick();
  expect(o.w.store[REPO][DEV]?.told).toBeUndefined();
  // It works on and its process ends in the middle of a tool call, with no report.
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD)];
  o.w.transcripts["dev-1"] = [...sent("DONE checkout", "Sent.", 5), prompt("one more fix", 3), tool("w2", 2, "Bash", { command: "bun test" })];
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
});

test("a stale wait for a limit is dropped when the session runs again, so a later stop is not woken at the old time with the limit note", async () => {
  const o = office();
  stoppedDev(o, [limitStop("8:40pm (Europe/Lisbon)", 0)]);
  o.w.now = at("2026-10-22T18:30:00Z");
  await o.tick();
  expect(o.w.store[REPO][DEV].waitSid).toBe("dev-1");
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), live(DEV, "dev-1", DEV_CWD)]; // resumed in place
  await o.tick();
  expect(o.w.store[REPO][DEV]?.waitSid).toBeUndefined();
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD)];
  o.w.transcripts["dev-1"] = [say("working", 10), tool("w2", 1, "Bash", { command: "bun test" })];
  o.w.now = at("2026-10-22T18:45:00Z");
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
});

test("a hung git does not stop the tick: the hire is woken without a tip, the others are decided and saved, and nobody is told twice", async () => {
  const o = office();
  const second = "shop.backend-dev-search";
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(second, "dev-2", wt("search"))];
  o.w.transcripts = { "dev-1": [say("compiling", 1)], "dev-2": [limitStop(null, 0)] };
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row(second, "doing", "search")];
  const make = createRecovery({
    resting: () => false,
    now: () => o.w.now, sessions: async () => o.w.list, tail: async (_c, sid) => (o.w.transcripts[sid] ?? []).join("\n"), mtime: async () => null, promptOf: async () => null,
    board: async (_r, team) => o.w.boards[team ?? "pm"] ?? [],
    commitTime: async () => { throw new Error("git timed out after 10000 ms"); },
    wake: async (repo, name, note) => void o.w.woke.push({ repo, name, note }),
    tell: async (_r, to, message) => (o.w.told.push({ to, message }), true),
    store: { load: (repo) => structuredClone(o.w.store[repo] ?? {}), save: (repo, e) => void (o.w.store[repo] = structuredClone(e)) },
  });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await make.tick([REPO]);
    await make.tick([REPO]);
  } finally {
    console.log = log;
  }
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
  expect(o.w.told.map((t) => t.message)).toEqual([`${second} stopped at the session limit; f1rm wake ${second}`]);
  expect(o.w.store[REPO][DEV]).toMatchObject({ wokeFrom: "dev-1" });
  expect(o.w.store[REPO][DEV].tip).toBeUndefined(); // unknown, not "no branch"
  expect(logged.some((l) => l.includes("git timed out"))).toBe(true);
});

test("the wake time is taken before the wake, so replies written while it starts count as progress", async () => {
  const o = office({ wake: async () => { o.w.now += 3 * MIN; } });
  stoppedDev(o, [say("compiling", 1)]);
  const before = o.w.now;
  await o.tick();
  expect(o.w.store[REPO][DEV].wokeAt).toBe(before);
});

// ── round 5 ────────────────────────────────────────────────────────────────
test("the nudge skips a turn that delivered ANY report, even when the hire kept working after it; only the ended-path skip needs the report to be the last tool call", async () => {
  const nudged = async (lines: (now: number) => string[]) => {
    const o = office();
    idleReviewer(o, "x", 25);
    o.w.transcripts["rev-1"] = lines(o.w.now);
    await o.tick();
    return o.w.told;
  };
  // BLOCKED mid-turn, then the work goes on and the turn ends in prose: the report was made, no nudge.
  expect(await nudged((now) => [...midReport("BLOCKED checkout: no key", now), block("msg_e", 25, { type: "text", text: "Carrying on with the rest, nothing else to send." }, now)])).toEqual([]);
  // The same turn on the ended path: the report is not the last tool call, so the hire is woken.
  const dev = office();
  stoppedDev(dev, midReport("BLOCKED checkout: no key"));
  await dev.tick();
  expect(dev.w.woke).toHaveLength(1);
});

test("a throwing promptOf leaves the stop undecided: nothing is recorded as told, and the next tick tells it", async () => {
  const o = office();
  stoppedDev(o, [limitStop(null, 0)]);
  let broken = true;
  const make = createRecovery({
    resting: () => false,
    now: () => o.w.now, sessions: async () => o.w.list, tail: async (_c, sid) => (o.w.transcripts[sid] ?? []).join("\n"), mtime: async () => null,
    promptOf: async () => { if (broken) throw new Error("EACCES"); return null; },
    board: async (_r, team) => o.w.boards[team ?? "pm"] ?? [], commitTime: async () => null, wake: async () => {},
    tell: async (_r, to, message) => (o.w.told.push({ to, message }), true),
    store: { load: (repo) => structuredClone(o.w.store[repo] ?? {}), save: (repo, e) => void (o.w.store[repo] = structuredClone(e)) },
  });
  const log = console.log;
  console.log = () => {};
  try {
    await make.tick([REPO]);
  } finally {
    console.log = log;
  }
  expect(o.w.told).toEqual([]);
  expect(o.w.store[REPO]?.[DEV]?.told).toBeUndefined();
  broken = false;
  await make.tick([REPO]);
  expect(o.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped at the session limit; f1rm wake ${DEV}` }]);
  expect(o.w.store[REPO][DEV]).toMatchObject({ told: "dev-1" });
  // The same for a report skip: the NOTE is computed before the stop is recorded.
  const r = office();
  stoppedDev(r, sent("DONE checkout", "Sent.", 1));
  const failing = createRecovery({
    resting: () => false,
    now: () => r.w.now, sessions: async () => r.w.list, tail: async (_c, sid) => (r.w.transcripts[sid] ?? []).join("\n"), mtime: async () => null,
    promptOf: async () => { throw new Error("EACCES"); },
    board: async (_r, team) => r.w.boards[team ?? "pm"] ?? [], commitTime: async () => null, wake: async () => {}, tell: async () => true,
    store: { load: (repo) => structuredClone(r.w.store[repo] ?? {}), save: (repo, e) => void (r.w.store[repo] = structuredClone(e)) },
  });
  console.log = () => {};
  try {
    await failing.tick([REPO]);
  } finally {
    console.log = log;
  }
  expect(r.w.store[REPO]?.[DEV]?.told).toBeUndefined();
});

test("a git that failed at the wake leaves the tip unknown, so a real tip later is not counted as a new commit", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  let failing = true;
  const make = createRecovery({
    resting: () => false,
    now: () => o.w.now, sessions: async () => o.w.list, tail: async (_c, sid) => (o.w.transcripts[sid] ?? []).join("\n"), mtime: async (_c, sid) => o.w.mtimes[sid] ?? null, promptOf: async () => null,
    board: async (_r, team) => o.w.boards[team ?? "pm"] ?? [],
    commitTime: async () => { if (failing) throw new Error("git timed out after 10000 ms"); return T0 - 60 * MIN; },
    wake: async (repo, name, note) => void o.w.woke.push({ repo, name, note }),
    tell: async (_r, to, message) => (o.w.told.push({ to, message }), true),
    store: { load: (repo) => structuredClone(o.w.store[repo] ?? {}), save: (repo, e) => void (o.w.store[repo] = structuredClone(e)) },
  });
  const log = console.log;
  console.log = () => {};
  try {
    await make.tick([REPO]);
  } finally {
    console.log = log;
  }
  expect(o.w.woke).toHaveLength(1);
  expect(o.w.store[REPO][DEV].tip).toBeUndefined();
  failing = false;
  const woke = o.w.now;
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
  o.w.transcripts["dev-2"] = [say("compiling", 1), block("msg_w", -1, { type: "text", text: "on it" }, woke)];
  o.w.mtimes["dev-2"] = woke + 4 * MIN;
  o.w.now = woke + 5 * MIN;
  await make.tick([REPO]);
  expect(o.w.woke).toHaveLength(1);
  expect(o.w.told).toEqual([{ to: "lead-shop", message: `${DEV} stopped again after a wake; f1rm wake ${DEV}` }]);
});

test("a lead whose members are active is skipped before its transcript is read", async () => {
  const o = office();
  o.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), live(DEV, "m-1", DEV_CWD, { status: "busy" })];
  o.w.transcripts["lead-1"] = [say("Hired the dev; watching.", 30, o.w.now)];
  o.w.mtimes = { "lead-1": o.w.now - 30 * MIN, "m-1": o.w.now };
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  await o.tick();
  await o.tick();
  expect(o.w.tailCalls).toEqual([]);
});

test("an office-woken stop whose old session is resumed in place and ends again is woken again", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  await o.tick();
  expect(o.w.store[REPO][DEV].wokeFrom).toBe("dev-1");
  // The woken copy is gone, and the OLD session is attached to by hand: it runs under its own id for a tick.
  o.w.now += 60 * MIN;
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), live(DEV, "dev-1", DEV_CWD)];
  await o.tick();
  expect(o.w.store[REPO][DEV]?.wokeFrom).toBeUndefined();
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD)];
  o.w.transcripts["dev-1"] = [say("working", 10), tool("w2", 1, "Bash", { command: "bun test" })];
  o.w.mtimes["dev-1"] = o.w.now;
  o.w.now += 5 * MIN;
  await o.tick();
  expect(o.w.woke).toHaveLength(2);
});

test("one hire's failure is logged and the others are still decided and saved", async () => {
  const o = office();
  const second = "shop.backend-dev-search";
  o.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(second, "dev-2", wt("search"))];
  o.w.transcripts = { "dev-1": [say("compiling", 1)], "dev-2": [limitStop(null, 0)] };
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row(second, "doing", "search")];
  const make = createRecovery({
    resting: () => false,
    now: () => o.w.now, sessions: async () => o.w.list,
    tail: async (_c, sid) => { if (sid === "dev-1") throw new Error("EACCES: permission denied"); return (o.w.transcripts[sid] ?? []).join("\n"); },
    mtime: async () => null, promptOf: async () => null, board: async (_r, team) => o.w.boards[team ?? "pm"] ?? [], commitTime: async () => null,
    wake: async (repo, name, note) => void o.w.woke.push({ repo, name, note }),
    tell: async (_r, to, message) => (o.w.told.push({ to, message }), true),
    store: { load: (repo) => structuredClone(o.w.store[repo] ?? {}), save: (repo, e) => void (o.w.store[repo] = structuredClone(e)) },
  });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await make.tick([REPO]);
  } finally {
    console.log = log;
  }
  expect(o.w.told.map((t) => t.message)).toEqual([`${second} stopped at the session limit; f1rm wake ${second}`]);
  expect(o.w.store[REPO][second]).toMatchObject({ told: "dev-2" });
  expect(logged.some((l) => l.includes(DEV) && l.includes("EACCES"))).toBe(true);
});

test("a live idle lead whose team is busy loses an old stop NOTE at once, not when the team goes quiet", async () => {
  const o = office();
  o.w.list = [live("lead-shop", "lead-1", REPO, { status: "idle" }), live(DEV, "m-1", DEV_CWD, { status: "busy" })];
  o.w.transcripts["lead-1"] = [say("Hired the dev; watching.", 30, o.w.now)];
  o.w.mtimes = { "lead-1": o.w.now - 30 * MIN, "m-1": o.w.now };
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.store[REPO] = { "lead-shop": { note: "lead-shop stopped; f1rm wake lead-shop", judged: o.w.now - 90 * MIN } };
  await o.tick();
  expect(o.w.store[REPO]?.["lead-shop"]?.note).toBeUndefined();
  expect(o.w.told).toEqual([]);
});

// ── reports as files ───────────────────────────────────────────────────────
test("a hire whose SendMessage was lost but whose report.json is from this turn is not nudged; a report from before the turn does not count", async () => {
  const nudged = async (reportAgo: number | null) => {
    const o = office();
    idleReviewer(o, "Review complete: the diff looks right.", 25); // the turn began 35 minutes before `now`
    if (reportAgo !== null) o.w.reports[REVIEWER] = o.w.now - reportAgo * MIN;
    await o.tick();
    return o.w.told;
  };
  expect(await nudged(26)).toEqual([]); // written inside the turn
  expect(await nudged(60)).toEqual([{ to: REVIEWER, message: NUDGE }]); // an earlier round's report
  expect(await nudged(null)).toEqual([{ to: REVIEWER, message: NUDGE }]);
});

test("an ended hire whose turn closed with a report.json is not woken: its NOTE says reported, as for a delivered SendMessage", async () => {
  const o = office({ prompts: { "dev-1": "brief\nReport to: lead-shop" } });
  stoppedDev(o, [say("Committed and checked.", 1)]);
  o.w.reports[DEV] = T0 - 2 * MIN;
  await o.tick();
  expect(o.w.woke).toEqual([]);
  expect(o.w.store[REPO][DEV]).toMatchObject({ told: "dev-1", note: "reported; waits on lead-shop" });
  // The report of an earlier round, before this turn began, wakes it as before.
  const old = office();
  stoppedDev(old, [say("Committed and checked.", 1)]);
  old.w.reports[DEV] = T0 - 90 * MIN;
  await old.tick();
  expect(old.w.woke).toHaveLength(1);
});

// ── pause and resume ───────────────────────────────────────────────────────
// The fixed note, plus the sentence a Haiku hire needed to act on it (the stop reason stays in its conversation).
const NOTE_PAUSE = "resumed after a pause; continue your task. The PM lifted the pause: the stop reason in your conversation no longer applies.";
test("while the project is paused the tick wakes, nudges and notes nothing; after the resume the same stop is woken and the same quiet hire nudged", async () => {
  const o = office();
  stoppedDev(o, [say("compiling", 1)]);
  o.w.paused = true;
  await o.tick();
  await o.tick();
  expect([o.w.woke, o.w.told]).toEqual([[], []]);
  expect(o.w.store[REPO]).toBeUndefined();
  o.w.paused = false;
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);

  // The "stopped again" note is silent too.
  const again = office();
  stoppedDev(again, [say("compiling", 1)]);
  again.w.commits["worktree-checkout"] = T0 - 60 * MIN;
  await again.tick();
  const woke = again.w.now;
  again.w.list = [live("lead-shop", "lead-sid", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD), ended(DEV, "dev-2", DEV_CWD, { startedAt: 2000 })];
  again.w.transcripts["dev-2"] = [say("compiling", 1), say("on it", -1, woke)];
  again.w.mtimes["dev-2"] = woke + 4 * MIN;
  again.w.now = woke + 5 * MIN;
  again.w.paused = true;
  await again.tick();
  expect(again.w.told).toEqual([]);
  expect(again.w.store[REPO][DEV].note).toBeUndefined();

  const quiet = office();
  idleReviewer(quiet, "Review complete: the diff looks right.", 25);
  quiet.w.paused = true;
  await quiet.tick();
  expect(quiet.w.told).toEqual([]);
  quiet.w.paused = false;
  await quiet.tick();
  expect(quiet.w.told).toEqual([{ to: REVIEWER, message: NUDGE }]);
});

test("a tick gap over 2 minutes is a sleep: for 5 minutes after it nobody is woken, told or nudged, then the tick judges again", async () => {
  for (const [setup, after] of [
    [(o: ReturnType<typeof office>) => stoppedDev(o, [say("compiling", 1)]), (o: ReturnType<typeof office>) => expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }])],
    [(o: ReturnType<typeof office>) => idleReviewer(o, "Review complete: the diff looks right.", 25), (o: ReturnType<typeof office>) => expect(o.w.told).toEqual([{ to: REVIEWER, message: NUDGE }])],
  ] as const) {
    const o = office({ resting: sleepGrace() });
    await o.tick(); // the last tick before the Mac slept
    o.w.now += 3 * MIN; // the timer did not fire for 3 minutes
    setup(o);
    const woke = o.w.now;
    for (let m = 0; m < 5; m++, o.w.now = woke + m * MIN) await o.tick();
    expect([o.w.woke, o.w.told]).toEqual([[], []]);
    expect(o.w.store[REPO]).toBeUndefined();
    await o.tick(); // 5 minutes after the gap
    after(o);
  }
});

test("a tick longer than the interval is no sleep: the ticks skipped while it runs are still seen by the sleep rule", async () => {
  const o = office({ real: 60_000 });
  stoppedDev(o, [say("compiling", 1)]);
  let open!: () => void;
  o.w.gate = new Promise((r) => (open = r));
  const slow = o.tick(); // in flight for 3 minutes
  o.w.now += MIN;
  await o.tick(); // the interval's next tick finds one running and does nothing, but is seen
  o.w.now += MIN;
  await o.tick();
  o.w.now += MIN;
  o.w.gate = undefined;
  open();
  await slow;
  expect(o.w.woke).toHaveLength(1); // the slow tick itself judged, no grace
  o.w.woke.length = 0;
  o.w.store = {};
  await o.tick(); // one minute after the last tick seen
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
});

test("a tick interval of 3 minutes is not a sleep every time: the gap that counts is more than twice the interval", async () => {
  const o = office({ real: 180_000 });
  await o.tick();
  stoppedDev(o, [say("compiling", 1)]);
  o.w.now += 3 * MIN;
  await o.tick();
  expect(o.w.woke).toHaveLength(1); // a normal interval: no grace
  const late = office({ real: 180_000 });
  await late.tick();
  stoppedDev(late, [say("compiling", 1)]);
  late.w.now += 7 * MIN; // the timer missed two
  await late.tick();
  expect(late.w.woke).toEqual([]);
});

test("a tick gap of exactly 2 minutes is no sleep", async () => {
  const o = office({ resting: sleepGrace() });
  await o.tick();
  stoppedDev(o, [say("compiling", 1)]);
  o.w.now += 2 * MIN;
  await o.tick();
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_ENDED }]);
});

test("a resume wakes the hires the pause stopped one at a time, leads first, and waits for a free slot when the cap of 8 is full", async () => {
  const DEV_B = "shop.backend-dev-other";
  const planning = () => {
    const o: ReturnType<typeof office> = office({
      wake: async (repo, name, note) => {
        const plan = await planWake({ target: name, message: note, cwd: repo }, {
          agents: async (all) => (all ? o.w.list : o.w.list.filter((a) => a.pid || a.state === "blocked")),
          gitCommonDir: () => `${repo}/.git`, home: "/nonexistent-home", now: T0, exists: () => true, modelOf: () => null, promptOf: () => null,
        });
        o.w.woke.push({ repo, name, note });
        o.w.list.push(live(name, `new-${name}`, plan.cwd)); // the woken session is a live working one: it holds a slot
      },
    });
    return o;
  };
  const o = planning();
  const others = Array.from({ length: 7 }, (_, i) => live(`far.designer-${i}`, `far-${i}`, `/code/far/.claude/worktrees/t${i}`));
  o.w.list = [...others, ended("lead-shop", "lead-old", REPO), ended(DEV, "dev-1", DEV_CWD), ended(DEV_B, "dev-2", wt("other")), ended("shop.backend-dev-done", "dev-3", wt("done"))];
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row(DEV_B, "review", "other"), row("shop.backend-dev-done", "done", "done")];
  // 7 working elsewhere: the lead takes the 8th slot. The next wake finds the cap full and waits; a slot is freed at the third wait.
  const freed: string[] = [];
  o.w.onSleep = () => {
    const far = (a: Listed) => String(a.name).startsWith("far.");
    if (o.w.slept.length >= 3 && o.w.list.some(far)) {
      const gone = o.w.list.findIndex(far);
      freed.push(String(o.w.list[gone].name));
      o.w.list.splice(gone, 1);
    }
    expect(o.w.woke.length).toBeLessThanOrEqual(1 + freed.length); // never past the cap
  };
  const where = `${NOTE_PAUSE} You stopped at checkpoint cp-9: your task other.`;
  await o.rec.resume(REPO, [DEV, "shop.backend-dev-done", DEV_B, "lead-shop"], undefined, undefined, { [DEV_B]: where });
  // Leads first; the one whose row is done is not woken; a hire with a where-it-stopped note from the manifest gets it, the others the plain pause note.
  expect(o.w.woke).toEqual(["lead-shop", DEV, DEV_B].map((name) => ({ repo: REPO, name, note: name === DEV_B ? where : NOTE_PAUSE })));
  expect(o.w.slept).toEqual([10_000, 10_000, 10_000, 10_000]); // the first dev waits three times (the third frees a slot), the second once
  expect(freed).toHaveLength(2);
});

test("a resume from a manifest gives each hire its own note, where it stopped, leads first, and the default pause note to one with none", async () => {
  const o = office();
  o.w.list = [ended("lead-shop", "lead-old", REPO), ended(DEV, "dev-1", DEV_CWD), ended("shop.backend-dev-b", "dev-2", wt("b"))];
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row("shop.backend-dev-b", "doing", "b")];
  await o.rec.resume(REPO, [DEV, "shop.backend-dev-b", "lead-shop"], undefined, undefined, { [DEV]: `${NOTE_PAUSE} You stopped at checkpoint cp-1.`, "lead-shop": `${NOTE_PAUSE} You stopped at checkpoint cp-1 (lead).` });
  expect(o.w.woke).toEqual([
    { repo: REPO, name: "lead-shop", note: `${NOTE_PAUSE} You stopped at checkpoint cp-1 (lead).` },
    { repo: REPO, name: DEV, note: `${NOTE_PAUSE} You stopped at checkpoint cp-1.` },
    { repo: REPO, name: "shop.backend-dev-b", note: NOTE_PAUSE },
  ]);
});

test("a resume tells a hire that is still live (the pause only ended its turn) in its inbox, and wakes only the ones whose process ended", async () => {
  const o = office();
  o.w.list = [live("lead-shop", "lead-live", REPO, { status: "idle" }), ended(DEV, "dev-1", DEV_CWD)];
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "review", "checkout")];
  await o.rec.resume(REPO, ["lead-shop", DEV]);
  expect(o.w.told).toEqual([{ to: "lead-shop", message: NOTE_PAUSE }]);
  expect(o.w.toldSession).toEqual(["lead-live"]);
  expect(o.w.woke).toEqual([{ repo: REPO, name: DEV, note: NOTE_PAUSE }]);
  // A live hire with no inbox is noted, for the session it reports to to message.
  const quiet = office();
  quiet.w.inbox = false;
  quiet.w.list = [live("lead-shop", "lead-live", REPO, { status: "idle" })];
  quiet.w.boards.pm = [row("lead-shop", "doing", "shop")];
  await quiet.rec.resume(REPO, ["lead-shop"]);
  expect(quiet.w.store[REPO]["lead-shop"].note).toContain("has no inbox");
});

test("a resume that is aborted stops waiting, and a wake refused for another reason is noted and the others still go", async () => {
  const o = office({ wake: async (repo, name, note) => { if (name === DEV) throw new Error(`${name} was let go; hire a new one`); o.w.woke.push({ repo, name, note }); } });
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row("shop.backend-dev-b", "doing", "b")];
  await o.rec.resume(REPO, [DEV, "shop.backend-dev-b", "lead-shop"]);
  expect(o.w.woke.map((x) => x.name)).toEqual(["lead-shop", "shop.backend-dev-b"]);
  expect(o.w.store[REPO][DEV].note).toContain("let go");
  const stuck = office({ wake: async () => { throw new HireRefused("8 hires are already working (the cap is 8).", 8); } });
  stuck.w.boards.pm = [row("lead-shop", "doing", "shop")];
  const stop = new AbortController();
  stuck.w.onSleep = () => stop.abort();
  await stuck.rec.resume(REPO, ["lead-shop"], stop.signal);
  expect(stuck.w.slept).toEqual([10_000]);
});
