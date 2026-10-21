// Seam: `f1rm status`, from a temp HOME's transcripts, an injected `claude agents --json` list, an injected clock and an injected commit lookup.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hireName } from "./letgo.ts";
import { head, hires, ls, status, tail, watch, type Hire } from "./status.ts";

const REPO = "/code/shop";
const NOW = Date.parse("2026-10-21T12:00:00Z");
const MIN = 60_000;

const home = () => mkdtempSync(join(tmpdir(), "f1rm-status-"));
/** Claude Code's folder for a working directory: every character that is not a letter or digit becomes `-`. */
const folder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Writes `lines` as the session's transcript under the encoded `cwd` folder, last written `agoMin` minutes before NOW. The last line is the system line Claude Code
 * ends a turn with, which records the folder the session ran in (`recorded`, the folder it is stored under unless a test says otherwise).
 */
function transcript(h: string, cwd: string, sessionId: string, lines: object[], agoMin: number, recorded = cwd) {
  const file = join(h, ".claude", "projects", folder(cwd), `${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...lines, { type: "system", subtype: "turn_duration", cwd: recorded }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(NOW - agoMin * MIN);
  utimesSync(file, t, t);
}

const talk = (text: string, extra: object = {}) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
// The line Claude Code writes when the subscription's limit stops a turn (the wording and keys of a real one, nothing else).
const limitStop = (text = "You've hit your session limit · resets 8:40pm (Europe/Lisbon)") =>
  talk(text, { error: "rate_limit", isApiErrorMessage: true, apiError: "usage_limit_reached" });
const named = (sessionId: string, name: string) => [{ type: "agent-name", agentName: name, sessionId }, { type: "custom-title", customTitle: name, sessionId }];

const live = (name: string, sessionId: string, cwd: string, more: object = {}) =>
  ({ id: sessionId.slice(0, 8), kind: "background", name, sessionId, cwd, state: "working", status: "busy", ...more });
const commits: Record<string, number> = { "worktree-checkout": NOW - 90 * MIN };
const base = (h: string, list: object[]) => ({ repo: REPO, home: h, agents: list, now: NOW, commitTime: (branch: string) => commits[branch] ?? null });

test("a live hire shows its name, role, team, agents status, transcript activity and last commit", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "aaaa1111", [talk("working on it")], 5);
  const [one, ...rest] = hires(base(h, [live("shop.backend-dev-checkout", "aaaa1111", cwd)]));
  expect(rest).toEqual([]);
  expect(one).toEqual({
    name: "shop.backend-dev-checkout", role: "backend-dev", team: "shop", sessionId: "aaaa1111", status: "busy", state: "working",
    lastActivity: new Date(NOW - 5 * MIN).toISOString(), idleMinutes: 5, lastCommit: new Date(NOW - 90 * MIN).toISOString(),
    ended: false, limitUntil: null,
  } satisfies Hire);
});

test("a lead has its team from its name, and no branch", () => {
  const h = home();
  transcript(h, REPO, "bbbb2222", [talk("planning")], 1);
  const [lead] = hires(base(h, [live("lead-shop", "bbbb2222", REPO, { status: "idle" })]));
  expect(lead).toMatchObject({ role: "lead", team: "shop", status: "idle", lastCommit: null, ended: false });
});

test("a hire whose last line of the conversation is the limit stop shows when the limit lifts, whatever agents says", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "cccc3333", [talk("step one"), limitStop(), { type: "cost-state", sessionId: "cccc3333" }], 3);
  const [one] = hires(base(h, [live("shop.backend-dev-checkout", "cccc3333", cwd)]));
  expect(one.limitUntil).toBe("8:40pm (Europe/Lisbon)");
  expect(one.status).toBe("busy"); // as agents says, not as it is
  expect(one.idleMinutes).toBe(3);
});

test("limitUntil needs the stop to be the last line of the conversation: a delivered resume or a reply clears it, a new stop replaces it", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  const until = (lines: object[]) => {
    transcript(h, cwd, "eeee9999", lines, 3);
    return hires(base(h, [live("shop.backend-dev-checkout", "eeee9999", cwd)]))[0].limitUntil;
  };
  const user = { type: "user", message: { role: "user", content: "resume" } };
  const noise = [{ type: "system", subtype: "turn_duration" }, { type: "cost-state" }, { type: "last-prompt" }]; // what Claude Code writes after any turn
  expect(until([talk("work"), limitStop(), ...noise])).toBe("8:40pm (Europe/Lisbon)");
  expect(until([limitStop(), ...noise, user])).toBeNull(); // the delivered resume
  expect(until([limitStop(), { type: "queue-operation", operation: "enqueue", content: "resume" }, ...noise])).toBeNull(); // delivered, not yet read
  expect(until([limitStop(), user, talk("on it")])).toBeNull();
  expect(until([limitStop(), user, limitStop("You've hit your session limit · resets 11pm (Europe/Lisbon)"), ...noise])).toBe("11pm (Europe/Lisbon)");
  // A line that carries a conversation line's type in its body does not count as one: the prefilter lets it through, the type check does not.
  expect(until([limitStop(), { type: "api-request-blob", body: { type: "user", message: "x" } }])).toBe("8:40pm (Europe/Lisbon)");
  expect(until([limitStop(), { type: "api-request-blob", body: '{"type":"user","type":"assistant"}' }])).toBe("8:40pm (Europe/Lisbon)");
  // Only an enqueue delivers a message: the queue emptying or being edited later does not.
  for (const operation of ["dequeue", "remove", "popAll"]) expect(until([limitStop(), { type: "queue-operation", operation }])).toBe("8:40pm (Europe/Lisbon)");
  // The hire's own background task finishing is not a `resume`, as an enqueue or as a user line.
  const note = "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>";
  expect(until([limitStop(), { type: "queue-operation", operation: "enqueue", content: note }, ...noise])).toBe("8:40pm (Europe/Lisbon)");
  expect(until([limitStop(), { type: "user", message: { role: "user", content: note } }])).toBe("8:40pm (Europe/Lisbon)");
  expect(until([limitStop(), { type: "user", message: { role: "user", content: [{ type: "text", text: note }] } }])).toBe("8:40pm (Europe/Lisbon)");
  // A resume that merely quotes the tag is still a resume, as an enqueue or a user line.
  const quoting = "resume — the build you started sent <task-notification>…</task-notification> while you were stopped";
  expect(until([limitStop(), { type: "queue-operation", operation: "enqueue", content: quoting }])).toBeNull();
  expect(until([limitStop(), { type: "user", message: { role: "user", content: [{ type: "text", text: quoting }] } }])).toBeNull();
  // A removed enqueue still clears the stop; the idle rule catches a hire that never saw the message.
  expect(until([limitStop(), { type: "queue-operation", operation: "enqueue", content: "resume" }, { type: "queue-operation", operation: "remove" }])).toBeNull();
  // A real resume after a notification still clears it.
  expect(until([limitStop(), { type: "queue-operation", operation: "enqueue", content: note }, { type: "queue-operation", operation: "enqueue", content: "resume" }])).toBeNull();
});

test("a limit stop followed by later work is no longer a stop, and the reset reads as the text gives it", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "dddd4444", [limitStop(), talk("resumed")], 3);
  expect(hires(base(h, [live("shop.backend-dev-checkout", "dddd4444", cwd)]))[0].limitUntil).toBeNull();
  transcript(h, cwd, "dddd4444", [limitStop("You've hit your usage limit · resets 1pm (Europe/Lisbon)")], 3);
  expect(hires(base(h, [live("shop.backend-dev-checkout", "dddd4444", cwd)]))[0].limitUntil).toBe("1pm (Europe/Lisbon)");
  transcript(h, cwd, "dddd4444", [limitStop("Claude usage limit reached.")], 3);
  expect(hires(base(h, [live("shop.backend-dev-checkout", "dddd4444", cwd)]))[0].limitUntil).toBe("unknown");
});

test("any limit on an API error line is a stop (weekly, model); the reset is the text after resets, whatever its form, and prose about a limit is not a stop", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  const until = (line: object) => {
    transcript(h, cwd, "weekly01", [line], 3);
    return hires(base(h, [live("shop.backend-dev-checkout", "weekly01", cwd)]))[0].limitUntil;
  };
  expect(until(limitStop("You've hit your weekly limit · resets Oct 27, 9am (Europe/Lisbon)"))).toBe("Oct 27, 9am (Europe/Lisbon)");
  expect(until(limitStop("You've hit your Opus limit · resets 11:30pm (America/New_York)"))).toBe("11:30pm (America/New_York)");
  expect(until(limitStop("You've hit your weekly limit · resets Monday 9:00 (Europe/Lisbon)"))).toBe("Monday 9:00 (Europe/Lisbon)");
  expect(until(limitStop("You've hit your weekly limit"))).toBe("unknown");
  expect(until(talk("the session limit resets 8:40pm"))).toBeNull(); // no API error flag: just prose
});

test("a live hire with no transcript has no activity, and is not guessed at", () => {
  const h = home();
  const [one] = hires(base(h, [live("shop.backend-dev-checkout", "eeee5555", `${REPO}/.claude/worktrees/checkout`)]));
  expect(one).toMatchObject({ lastActivity: null, idleMinutes: null, limitUntil: null, ended: false });
});

test("a hire that agents no longer lists, with a transcript in this repo's folders, shows as ended", () => {
  const h = home();
  transcript(h, `${REPO}/.claude/worktrees/checkout`, "ffff6666", [...named("ffff6666", "shop.backend-dev-checkout"), limitStop()], 40);
  transcript(h, REPO, "ffff7777", [...named("ffff7777", "lead-shop"), talk("hi")], 30);
  const list = hires(base(h, []));
  expect(list.map((x) => x.name).sort()).toEqual(["lead-shop", "shop.backend-dev-checkout"]);
  const dev = list.find((x) => x.role === "backend-dev")!;
  expect(dev).toMatchObject({ ended: true, status: null, state: null, idleMinutes: 40, limitUntil: "8:40pm (Europe/Lisbon)", sessionId: "ffff6666" });
});

test("an ended hire is named by its last name line, so a rename counts, also past a transcript larger than the tail read", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "aaaa7001", [...named("aaaa7001", "shop.backend-dev-old"), talk("x"), ...named("aaaa7001", "shop.backend-dev-new")], 10);
  const filler = Array.from({ length: 300 }, () => talk("x".repeat(1000)));
  transcript(h, cwd, "aaaa7002", [...named("aaaa7002", "shop.frontend-dev-old"), ...filler, ...named("aaaa7002", "shop.frontend-dev-new")], 20);
  transcript(h, cwd, "aaaa7003", [...named("aaaa7003", "shop.designer-only"), ...filler], 30); // the one name line is far from the end
  expect(hires(base(h, [])).map((x) => x.name)).toEqual(["shop.backend-dev-new", "shop.frontend-dev-new", "shop.designer-only"]);
});

test("a transcript that vanishes between the folder listing and the read is skipped; other hires still show", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "gone0001", [talk("x")], 5);
  transcript(h, cwd, "here0002", [talk("x")], 5);
  // The listing sees the entry, the stat finds nothing behind it: as a transcript `claude rm` removes in between.
  const dir = join(h, ".claude", "projects", folder(cwd));
  rmSync(join(dir, "gone0001.jsonl"));
  symlinkSync(join(h, "nowhere.jsonl"), join(dir, "gone0001.jsonl"));
  const list = hires(base(h, [live("shop.backend-dev-checkout", "gone0001", cwd), live("shop.frontend-dev-ui", "here0002", cwd)]));
  expect(list.map((x) => [x.name, x.lastActivity === null])).toEqual([["shop.backend-dev-checkout", true], ["shop.frontend-dev-ui", false]]);
});

test("the readers treat a file or folder that vanished as empty, and let any other error through", () => {
  const h = home();
  const missing = join(h, "gone.jsonl");
  expect([head(missing), tail(missing), ls(join(h, "gone-folder"))]).toEqual(["", "", []]);
  // A folder is there but is not a file: that is not "vanished", so it must show.
  expect(() => head(h)).toThrow();
  expect(() => tail(h)).toThrow();
  const file = join(h, "a-file");
  writeFileSync(file, "x");
  expect(() => ls(join(file, "x"))).toThrow(); // ENOTDIR on any machine, not ENOENT
});

test("a name that is listed live is not also shown from an older ended transcript, and a reused name shows once", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "1111aaaa", [...named("1111aaaa", "shop.backend-dev-checkout")], 300);
  transcript(h, cwd, "2222bbbb", [...named("2222bbbb", "shop.backend-dev-checkout")], 200);
  transcript(h, cwd, "3333cccc", [...named("3333cccc", "shop.frontend-dev-ui")], 600);
  transcript(h, cwd, "3333dddd", [...named("3333dddd", "shop.frontend-dev-ui")], 100);
  const list = hires(base(h, [live("shop.backend-dev-checkout", "2222bbbb", cwd)]));
  expect(list.map((x) => [x.name, x.sessionId, x.ended])).toEqual([["shop.backend-dev-checkout", "2222bbbb", false], ["shop.frontend-dev-ui", "3333dddd", true]]);
});

test("an ended hire older than a day is history, not listed", () => {
  const h = home();
  transcript(h, REPO, "99990000", [...named("99990000", "lead-old")], 25 * 60);
  expect(hires(base(h, []))).toEqual([]);
});

test("another repo's sessions and transcripts are never listed, even one whose folder name starts with this repo's", () => {
  const h = home();
  const mine = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, mine, "aaaa0001", [talk("mine")], 5);
  for (const other of ["/code/shop-two", "/code/other", "/code/shop-two/.claude/worktrees/x"]) {
    transcript(h, other, "bbbb0002", [...named("bbbb0002", "backend-dev-theirs")], 5);
  }
  const list = hires(base(h, [
    live("backend-dev-theirs", "bbbb0002", "/code/shop-two/.claude/worktrees/x"),
    live("lead-other", "bbbb0003", "/code/other"),
    live("shop.backend-dev-checkout", "aaaa0001", mine),
    live("pm-shop", "aaaa0004", REPO, { kind: "interactive" }), // the PM, and the user's own sessions, are not hires
  ]));
  expect(list.map((x) => x.name)).toEqual(["shop.backend-dev-checkout"]);
});

test("two repos whose folders Claude Code encodes alike are told apart by the cwd their transcripts record", () => {
  const h = home();
  // /code/shop-app and /code/shop.app are stored in the same projects folder.
  const here = { ...base(h, []), repo: "/code/shop-app" };
  transcript(h, "/code/shop-app", "aaaa8001", [...named("aaaa8001", "lead-mine")], 5);
  transcript(h, "/code/shop-app", "aaaa8002", [...named("aaaa8002", "lead-theirs")], 5, "/code/shop.app");
  transcript(h, "/code/shop-app", "aaaa8003", [...named("aaaa8003", "shop.backend-dev-wt")], 5, "/code/shop-app/.claude/worktrees/wt");
  transcript(h, "/code/shop-app", "aaaa8004", [...named("aaaa8004", "lead-theirs-too")], 5, "/code/shop.app/.claude/worktrees/wt");
  expect(hires(here).map((x) => x.name).sort()).toEqual(["lead-mine", "shop.backend-dev-wt"]);
});

test("an assistant line whose content is a string is read like a block list", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  const stop = { type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: "You've hit your session limit · resets 8:40pm (Europe/Lisbon)" } };
  transcript(h, cwd, "str00001", [stop], 3);
  expect(hires(base(h, [live("shop.backend-dev-checkout", "str00001", cwd)]))[0].limitUntil).toBe("8:40pm (Europe/Lisbon)");
});

test("status never reads the office's database", () => {
  expect(readFileSync(join(import.meta.dir, "status.ts"), "utf8")).not.toContain("events.db");
});

test("status --json prints one array of hires and exits 0; the plain output is a table with the note", async () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "cccc3333", [limitStop()], 3);
  transcript(h, REPO, "ffff7777", [...named("ffff7777", "lead-shop")], 30);
  const deps = { ...base(h, []), loadAgents: async () => [live("shop.backend-dev-checkout", "cccc3333", cwd)] };
  const json = await status(["--json"], deps);
  expect(json.code).toBe(0);
  expect((JSON.parse(json.out) as Hire[]).map((x) => x.name)).toEqual(["shop.backend-dev-checkout", "lead-shop"]);
  const plain = await status([], deps);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain("shop.backend-dev-checkout");
  expect(plain.out).toContain("limit until 8:40pm (Europe/Lisbon)");
  expect(plain.out).toContain("ended");
});

test("status says so on stderr and exits 1 when claude agents can't be read", async () => {
  const r = await status([], { ...base(home(), []), loadAgents: async () => null });
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toContain("claude agents --json");
});

test("status rejects an unknown flag", async () => {
  const r = await status(["--bogus"], { ...base(home(), []), loadAgents: async () => [] });
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: f1rm status [--json]");
});

// f1rm status --watch <name>...: the stall rule the PM's and the leads' background watcher runs. The clock and the sleep are injected, so nothing here waits.
type Member = { name: string; ago?: number | null; limit?: boolean; ended?: boolean };

/** The agents list of some hires, with a transcript each: `ago` minutes since its last write (null: none), `limit` ends it on a limit stop, `ended` leaves it out of the list. */
function fleet(h: string, members: Member[]) {
  const listed: object[] = [];
  members.forEach((m, i) => {
    const { role, task } = hireName(m.name)!;
    const cwd = role === "lead" ? REPO : `${REPO}/.claude/worktrees/${task}`;
    const sessionId = `w${i}aaaaaa`;
    if (m.ago !== null) transcript(h, cwd, sessionId, [...(m.ended ? named(sessionId, m.name) : []), m.limit ? limitStop() : talk("x")], m.ago ?? 3);
    if (!m.ended) listed.push(live(m.name, sessionId, cwd));
  });
  return listed;
}

/** Runs the watcher on a fleet. Each sleep moves the clock on; after `cap` sleeps without a wake it gives up and says `woke: false`. */
async function watchFleet(names: string[], members: Member[], cap = 30) {
  const h = home();
  const listed = fleet(h, members);
  let clock = NOW, sleeps = 0;
  try {
    const r = await watch(names, {
      repo: REPO, home: h, now: () => clock, commitTime: () => null, loadAgents: async () => listed,
      sleep: async (ms) => { if (++sleeps > cap) throw new Error("never woke"); clock += ms; },
    });
    return { ...r, sleeps, woke: true };
  } catch (e) {
    if ((e as Error).message === "never woke") return { out: "", err: "", code: -1, sleeps, woke: false };
    throw e;
  }
}

const a = (extra: Partial<Member> = {}): Member => ({ name: "lead-a", ago: 3, ...extra });

test("watch sleeps first, then names each stalled session with its reason on the first poll that finds one, and exits 0", async () => {
  for (const [why, extra, reason] of [
    ["idle", { ago: 19 }, "lead-b: idle 20 minutes"],
    ["ended", { ended: true }, "lead-b: ended"],
    ["limit", { limit: true }, "lead-b: limit stop until 8:40pm (Europe/Lisbon)"],
    ["no activity time", { ago: null }, "lead-b: no activity time"],
  ] as const) {
    const r = await watchFleet(["lead-a", "lead-b"], [a(), a({ name: "lead-b", ...extra })]);
    expect([why, r.code, r.sleeps, r.out, r.err]).toEqual([why, 0, 1, expect.stringContaining(reason), ""]);
    expect(r.out).not.toContain("lead-a");
  }
});

test("watch keeps polling a quiet session once a minute until it has been idle 20 minutes, and ignores a stalled one it was not asked about", async () => {
  const r = await watchFleet(["lead-a"], [a(), { name: "lead-z", ended: true, ago: 99 }]);
  expect([r.woke, r.sleeps, r.out]).toEqual([true, 17, "lead-a: idle 20 minutes\n"]); // 3 minutes idle at the start, 20 after 17 polls
  expect((await watchFleet(["lead-a"], [a({ ago: 19 })])).sleeps).toBe(1);
});

test("watch wakes for a named session that the list does not have", async () => {
  expect(await watchFleet(["lead-a", "lead-gone"], [a()])).toMatchObject({ woke: true, sleeps: 1, out: "lead-gone: missing from the list\n" });
  expect(await watchFleet(["lead-gone"], [])).toMatchObject({ woke: true, sleeps: 1, out: "lead-gone: missing from the list\n" });
});

test("watch skips empty names, and with none left prints no names and exits 0 without polling", async () => {
  expect(await watchFleet([], [a()])).toMatchObject({ code: 0, out: "no names\n", sleeps: 0 });
  expect(await watchFleet(["", ""], [a({ ended: true })])).toMatchObject({ code: 0, out: "no names\n", sleeps: 0 });
  expect(await watchFleet(["lead-a", ""], [a()])).toMatchObject({ sleeps: 17 }); // a stray empty name is not a missing session
});

test("watch exits 1 with the reason on stderr when claude agents can't be read, at the first poll or a later one", async () => {
  const h = home();
  const listed = fleet(h, [a()]);
  let clock = NOW, polls = 0;
  const deps = (readable: number) => ({ repo: REPO, home: h, now: () => clock, commitTime: () => null, sleep: async (ms: number) => void (clock += ms), loadAgents: async () => (++polls > readable ? null : listed) });
  for (const readable of [0, 3]) {
    polls = 0;
    const r = await watch(["lead-a"], deps(readable));
    expect([r.code, r.out, r.err]).toEqual([1, "", expect.stringContaining("claude agents --json")]);
    expect(polls).toBe(readable + 1);
  }
});

test("a lead is stalled only when it and every hire of its team are quiet: ended or without activity counts as quiet, a hire of another team does not count", async () => {
  const lead = (extra: Partial<Member> = {}): Member => ({ name: "lead-t", ago: 45, ...extra });
  const member = (ago: number | null, extra: Partial<Member> = {}): Member => ({ name: "t.backend-dev-x", ago, ...extra });
  const sleeps = async (members: Member[]) => (await watchFleet(["lead-t"], members)).sleeps;
  expect(await sleeps([lead(), member(3)])).toBe(17); // woken when its last active hire went quiet, not at the first poll
  expect(await sleeps([lead(), member(3), { name: "t.reviewer-review-x", ago: 60 }])).toBe(17);
  expect(await sleeps([lead(), member(40)])).toBe(1);
  expect(await sleeps([lead()])).toBe(1);
  expect(await sleeps([lead(), member(null)])).toBe(1); // no activity time is not an active hire
  expect(await sleeps([lead(), member(5, { ended: true })])).toBe(1); // nor is one let go a moment ago
  expect(await sleeps([lead(), { name: "other.backend-dev-x", ago: 3 }])).toBe(1); // nor one of another team
  expect(await sleeps([lead({ ago: 5, ended: true }), member(3)])).toBe(1); // a lead that ended wakes at once, whatever its hires do
  expect(await sleeps([lead({ ago: 5, limit: true }), member(3)])).toBe(1);
  expect(await sleeps([lead({ ago: 5 }), member(40)])).toBe(15); // quiet itself after 15 more minutes
});

test("a lead waiting on a hire stopped by a limit is not stalled, until that hire has been silent for 6 hours", async () => {
  const lead: Member = { name: "lead-t", ago: 45 };
  const limited = (ago: number): Member => ({ name: "t.backend-dev-x", ago, limit: true });
  expect((await watchFleet(["lead-t"], [lead, limited(40)], 100)).woke).toBe(false); // still waiting for the reset
  expect((await watchFleet(["lead-t"], [lead, limited(350)])).sleeps).toBe(10); // 360 minutes: the reset is long past, so the lead wakes
});

test("an ended hire whose recorded folder is a subfolder of the repo is listed, one of another repo with a similar name is not", () => {
  const h = home();
  transcript(h, REPO, "sub00001", [...named("sub00001", "lead-sub")], 5, `${REPO}/src/deep`);
  transcript(h, REPO, "sub00002", [...named("sub00002", "lead-near")], 5, `${REPO}-two`);
  expect(hires(base(h, [])).map((x) => x.name)).toEqual(["lead-sub"]);
});
