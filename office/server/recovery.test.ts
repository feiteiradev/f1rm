// Seam: the office's recovery tick. createRecovery against an injected `claude agents --json --all`, transcripts, boards, store, clock, wake and tell; the real wake code (planWake) for the caps.
import { expect, setDefaultTimeout, test } from "bun:test";
import { LOAD_FIRST } from "../cli/hire.ts";
import { planWake } from "../cli/wake.ts";
import type { BoardRow } from "./board.ts";
import { createRecovery, resetAt, type Entries } from "./recovery.ts";

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
const limitStop = (until: string | null, ago: number, now = T0) =>
  JSON.stringify({ type: "assistant", timestamp: new Date(now - ago * MIN).toISOString(), isApiErrorMessage: true, apiError: "usage_limit_reached", message: { role: "assistant", content: [{ type: "text", text: `You've hit your session limit${until ? ` · resets ${until}` : ""}` }] } });
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
function office(over: { wake?: (repo: string, name: string, note: string) => Promise<void>; prompts?: Record<string, string> } = {}) {
  const w = {
    now: T0 + 5 * MIN,
    list: [] as Listed[],
    transcripts: {} as Record<string, string[]>,
    mtimes: {} as Record<string, number>,
    boards: { pm: [] as BoardRow[], shop: [] as BoardRow[] } as Record<string, BoardRow[]>,
    commits: {} as Record<string, number>,
    woke: [] as { repo: string; name: string; note: string }[],
    told: [] as { to: string; message: string }[],
    inbox: true,
    store: {} as Record<string, Entries>,
  };
  const make = () => createRecovery({
    now: () => w.now,
    sessions: async () => w.list,
    tail: (_cwd, sid) => (w.transcripts[sid] ?? []).join("\n"),
    mtime: (_cwd, sid) => w.mtimes[sid] ?? null,
    promptOf: (_cwd, sid) => over.prompts?.[sid] ?? null,
    board: async (_repo, team) => w.boards[team ?? "pm"] ?? [],
    commitTime: (_repo, branch) => w.commits[branch] ?? null,
    wake: over.wake ?? (async (repo, name, note) => void w.woke.push({ repo, name, note })),
    tell: async (_repo, to, message) => (w.told.push({ to, message }), w.inbox),
    store: { load: (repo) => structuredClone(w.store[repo] ?? {}), save: (repo, e) => void (w.store[repo] = structuredClone(e)) },
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
    expect([report, (await stopped((o) => (o.w.transcripts["dev-1"] = [say("working", 30), say(report, 1)]))).woke]).toEqual([report, []]);
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
  for (const report of ["APPROVED abc123", "CHANGES REQUESTED: 2 findings", "DONE review", "BLOCKED review", "ESCALATE", "NEEDS YOU shop: x"]) expect([report, await none(() => {}, report)]).toEqual([report, []]);
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
