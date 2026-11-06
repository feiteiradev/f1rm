// Seam: the office's resume after a pause (the tick that judged and woke hires is gone: the scheduler restarts a step that ended). createRecovery against an injected `claude agents --json --all`, transcripts, boards, store, clock, wake and tell; the real wake code (planWake) for the hire checks.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryFile } from "../cli/status.ts";
import { HireRefused, LOAD_FIRST, UsageHold } from "../cli/hire.ts";
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
function office(over: { held?: () => boolean; real?: number; resting?: (now: number) => boolean; wake?: (repo: string, name: string, note: string) => Promise<void>; prompts?: Record<string, string> } = {}) {
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
    /** The 5-hour usage the held tests' fake reads. */
    usagePct: 0,
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
    ...(over.held && { held: over.held }),
    tell: async (_repo, to, message, sessionId) => (w.told.push({ to, message }), w.toldSession.push(sessionId), w.inbox),
    store: { load: (repo) => structuredClone(w.store[repo] ?? {}), save: (repo, e) => void (w.store[repo] = structuredClone(e)) },
    paused: () => w.paused,
    sleep: async (ms) => (w.slept.push(ms), w.onSleep()),
    // The fake clock jumps between ticks, so the sleep rule is off unless a test asks for the real one (`real`: the tick interval in ms).
    ...(over.real ? { everyMs: over.real } : { resting: over.resting ?? (() => false) }),
  });
  const rec = make();
  return { w, rec, make };
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

// A simple task's dev has no team: its row is on the PM's board, it reports to the PM, and the tick treats it like a team member otherwise.
const SOLO = "backend-dev-x";
function soloDev(o: ReturnType<typeof office>, last: string[], dev: Listed) {
  o.w.list = [live("pm-shop", "pm-sid", REPO, { status: "idle" }), dev];
  o.w.transcripts["solo-1"] = [say("working on it", 30), ...last];
  o.w.mtimes["solo-1"] = T0;
  o.w.boards.pm = [row(SOLO, "doing", "x")];
}

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

// ── round 3: one rule ─────────────────────────────────────────────────────
// A cross-session message is logged as an isMeta user line with no enqueue before it, and it starts a turn.
const crossSession = (ago: number, now = T0) => JSON.stringify({ type: "user", isMeta: true, uuid: `x${ago}`, timestamp: new Date(now - ago * MIN).toISOString(), message: { role: "user", content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="lead-shop">Re-review please</cross-session-message>' } });
// ── round 4: a record holds only while its session stays ended ─────────────
// ── round 5 ────────────────────────────────────────────────────────────────
// ── reports as files ───────────────────────────────────────────────────────
// ── pause and resume ───────────────────────────────────────────────────────
// The fixed note, plus the sentence a Haiku hire needed to act on it (the stop reason stays in its conversation).
const NOTE_PAUSE = "resumed after a pause; continue your task. The PM lifted the pause: the stop reason in your conversation no longer applies.";
/** An office whose wake is the real planWake against the fake listing, reading usage from `home`; a woken session joins the listing as a live working one. */
const resuming = (home = "/nonexistent-home") => {
  const o: ReturnType<typeof office> = office({
    wake: async (repo, name, note) => {
      const plan = await planWake({ target: name, message: note, cwd: repo }, {
        agents: async (all) => (all ? o.w.list : o.w.list.filter((a) => a.pid || a.state === "blocked")),
        gitCommonDir: () => `${repo}/.git`, home, now: T0, exists: () => true, modelOf: () => null, promptOf: () => null,
      });
      o.w.woke.push({ repo, name, note });
      o.w.list.push(live(name, `new-${name}`, plan.cwd));
    },
  });
  return o;
};
const DEV_B = "shop.backend-dev-other";
/** The shop's lead and two devs the pause stopped, a third dev whose row is done, and `others` working elsewhere. */
const pausedShop = (o: ReturnType<typeof office>, others: Listed[]) => {
  o.w.list = [...others, ended("lead-shop", "lead-old", REPO), ended(DEV, "dev-1", DEV_CWD), ended(DEV_B, "dev-2", wt("other")), ended("shop.backend-dev-done", "dev-3", wt("done"))];
  o.w.boards.pm = [row("lead-shop", "doing", "shop")];
  o.w.boards.shop = [row(DEV, "doing", "checkout"), row(DEV_B, "review", "other"), row("shop.backend-dev-done", "done", "done")];
};

test("a resume wakes the hires the pause stopped one at a time, leads first, with 9 working elsewhere and no wait: there is no machine cap", async () => {
  const o = resuming();
  pausedShop(o, Array.from({ length: 9 }, (_, i) => live(`far.designer-${i}`, `far-${i}`, `/code/far/.claude/worktrees/t${i}`)));
  const stop = new AbortController();
  o.w.onSleep = () => stop.abort(); // a wait would be a cap: end the resume there
  const where = `${NOTE_PAUSE} You stopped at checkpoint cp-9: your task other.`;
  await o.rec.resume(REPO, [DEV, "shop.backend-dev-done", DEV_B, "lead-shop"], stop.signal, undefined, { [DEV_B]: where });
  // Leads first; the one whose row is done is not woken; a hire with a where-it-stopped note from the manifest gets it, the others the plain pause note.
  expect(o.w.woke).toEqual(["lead-shop", DEV, DEV_B].map((name) => ({ repo: REPO, name, note: name === DEV_B ? where : NOTE_PAUSE })));
  expect(o.w.slept).toEqual([]);
});

test("a resume under the usage hold waits and asks again until the hold lifts, then wakes the rest", async () => {
  const home = mkdtempSync(join(tmpdir(), "hold-"));
  mkdirSync(join(home, ".f1rm"), { recursive: true });
  const usage = (pct: number) => writeFileSync(join(home, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: pct, resetsAt: T0 / 1000 + 3600 }, readAt: 0 }));
  usage(95);
  const o = resuming(home);
  pausedShop(o, []);
  o.w.onSleep = () => {
    expect(o.w.woke).toEqual([]); // nothing starts while the hold is on
    if (o.w.slept.length >= 3) usage(50);
  };
  await o.rec.resume(REPO, [DEV, "shop.backend-dev-done", DEV_B, "lead-shop"]);
  expect(o.w.woke.map((x) => x.name)).toEqual(["lead-shop", DEV, DEV_B]);
  expect(o.w.slept).toEqual([10_000, 10_000, 10_000]); // the lead waits three times; the hold lifts at the third
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
  const stuck = office({ wake: async () => { throw new UsageHold("usage hold: 5-hour usage is 95% (resets 20:00); new sessions wait until 20:00", 1); } });
  stuck.w.boards.pm = [row("lead-shop", "doing", "shop")];
  const stop = new AbortController();
  stuck.w.onSleep = () => stop.abort();
  await stuck.rec.resume(REPO, ["lead-shop"], stop.signal);
  expect(stuck.w.slept).toEqual([10_000]);
});
