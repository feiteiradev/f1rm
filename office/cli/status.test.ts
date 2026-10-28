// Seam: `f1rm status`, from a temp HOME's transcripts, an injected `claude agents --json` list, an injected clock and an injected commit lookup.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectFolder as folder } from "./hire.ts";
import { hireName } from "./letgo.ts";
import { longRepos } from "./long-repo.test-helper.ts";
import { reportFile } from "./report.ts";
import { pausedDirOf, pausedFile, writePaused } from "../server/pause.ts";
import { head, headAsync, hires, limitUntil, ls, parseArgs, status, statusFor, tail, tailAsync, watch, type Hire } from "./status.ts";

const REPO = "/code/shop";
const NOW = Date.parse("2026-10-21T12:00:00Z");
const MIN = 60_000;

const home = () => mkdtempSync(join(tmpdir(), "f1rm-status-"));

/**
 * Writes `lines` as the session's transcript under the encoded `cwd` folder, last written `agoMin` minutes before NOW. The last line is the system line Claude Code
 * ends a turn with, which records the folder the session ran in (`recorded`, the folder it is stored under unless a test says otherwise).
 */
function transcript(h: string, cwd: string, sessionId: string, lines: object[], agoMin: number, recorded = cwd, dirName = folder(cwd)) {
  const file = join(h, ".claude", "projects", dirName, `${sessionId}.jsonl`);
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
    ended: false, limitUntil: null, recovery: null, report: null,
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
  const json = await status({ json: true }, deps);
  expect(json.code).toBe(0);
  expect((JSON.parse(json.out) as Hire[]).map((x) => x.name)).toEqual(["shop.backend-dev-checkout", "lead-shop"]);
  const plain = await status({ json: false }, deps);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain("shop.backend-dev-checkout");
  expect(plain.out).toContain("limit until 8:40pm (Europe/Lisbon)");
  expect(plain.out).toContain("ended");
});

test("status says so on stderr and exits 1 when claude agents can't be read", async () => {
  const r = await status({ json: false }, { ...base(home(), []), loadAgents: async () => null });
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toContain("claude agents --json");
});

test("the arguments are parsed once: usage errors, no names, and the names with their :waiting suffix, empty ones dropped", () => {
  expect(parseArgs([])).toEqual({ watch: false, json: false });
  expect(parseArgs(["--json"])).toEqual({ watch: false, json: true });
  for (const bad of [["--bogus"], ["--json", "x"], ["--watch", "--json"], ["--watch", "a", "-x"], ["x", "--watch"]]) expect([bad, parseArgs(bad)]).toEqual([bad, { error: expect.stringContaining("usage: f1rm status [--json] | f1rm status --watch <name>[:waiting]...") }]);
  expect(parseArgs(["--watch", "a:waiting", "b", "", "c:waiting"])).toEqual({ watch: true, names: [{ name: "a", waiting: true }, { name: "b", waiting: false }, { name: "c", waiting: true }] });
  expect(parseArgs(["--watch", ":waiting", ""])).toEqual({ watch: true, names: [] }); // a bare suffix is no name
  expect(parseArgs(["--watch"])).toEqual({ watch: true, names: [] });
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

/** The names of a `--watch` call, parsed as the command parses them. */
const namesOf = (names: string[]) => {
  const parsed = parseArgs(["--watch", ...names]);
  if (!("names" in parsed)) throw new Error("not a watch");
  return parsed.names;
};

/** Runs the watcher on a fleet. Each sleep moves the clock on; after `cap` sleeps without a wake it gives up and says `woke: false`. */
async function watchFleet(names: string[], members: Member[], cap = 30, onSleep: (n: number, h: string, clock: number) => unknown = () => {}, h = home()) {
  const listed = fleet(h, members);
  let clock = NOW, sleeps = 0, loads = 0;
  try {
    const r = await watch(namesOf(names), {
      repo: REPO, home: h, now: () => clock,
      loadAgents: async () => { if (++loads > 100) throw new Error("runaway"); return listed; },
      sleep: async (ms) => { if (++sleeps > cap) throw new Error("never woke"); clock += ms; const jump = onSleep(sleeps, h, clock); if (typeof jump === "number") clock += jump; }, // a number it returns is a sleep: the clock jumps by that many ms
    });
    return { ...r, sleeps, woke: true };
  } catch (e) {
    if ((e as Error).message === "never woke") return { out: "", err: "", code: -1, sleeps, woke: false };
    throw e;
  }
}

const a = (extra: Partial<Member> = {}): Member => ({ name: "lead-a", ago: 3, ...extra });

test("a name given as name:waiting is judged only for ended, missing and a limit stop: never idle, never without an activity time", async () => {
  expect(await watchFleet(["lead-a"], [a({ ago: 600 })])).toMatchObject({ woke: true, out: "lead-a: idle 601 minutes\n" }); // the plain name is judged for idle
  expect((await watchFleet(["lead-a:waiting"], [a({ ago: 600 })], 100)).woke).toBe(false); // the waiting one is not
  expect((await watchFleet(["lead-a:waiting"], [a({ ago: null })], 100)).woke).toBe(false); // nor for a missing activity time
  expect(await watchFleet(["lead-a:waiting"], [a({ ended: true })])).toMatchObject({ woke: true, sleeps: 1, out: "lead-a: ended\n" });
  expect(await watchFleet(["lead-a:waiting"], [a({ limit: true })])).toMatchObject({ woke: true, sleeps: 1, out: "lead-a: limit stop until 8:40pm (Europe/Lisbon)\n" });
  expect(await watchFleet(["lead-gone:waiting"], [a()])).toMatchObject({ woke: true, sleeps: 1, out: "lead-gone: missing from the list\n" });
  // A waiting lead is judged on itself, not on its team; a plain name beside it still wakes for idle.
  expect((await watchFleet(["lead-t:waiting"], [{ name: "lead-t", ago: 90 }, { name: "t.backend-dev-x", ago: 90 }], 100)).woke).toBe(false);
  expect(await watchFleet(["lead-a:waiting", "lead-b"], [a({ ago: 600 }), a({ name: "lead-b", ago: 19 })])).toMatchObject({ sleeps: 1, out: "lead-b: idle 20 minutes\n" });
});

test("a quiet fleet is polled once a minute after a first sleep: 17 sleeps to reach 20 minutes idle; the fake loader's budget makes a watcher that never sleeps fail", async () => {
  // watchFleet throws "runaway" after 100 polls, so a watcher that never sleeps fails the test instead of hanging.
  const r = await watchFleet(["lead-a"], [a()]);
  expect(r.sleeps).toBe(17);
});

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
  let clock = NOW, polls = 0, sleeps = 0;
  const deps = (readable: number) => ({ repo: REPO, home: h, now: () => clock, sleep: async (ms: number) => { if (++sleeps > 100) throw new Error("runaway"); clock += ms; }, loadAgents: async () => (++polls > readable ? null : listed) });
  for (const readable of [0, 3]) {
    polls = 0;
    sleeps = 0;
    const r = await watch(namesOf(["lead-a"]), deps(readable));
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

test("activity a session does only in its sub-agents' transcripts counts: the newest of them is the session's last activity", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "sub11111", [talk("waiting on a sub-agent")], 40);
  const dir = join(h, ".claude", "projects", folder(cwd), "sub11111", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [name, ago] of [["agent-a.jsonl", 30], ["agent-b.jsonl", 2]] as const) {
    writeFileSync(join(dir, name), "{}\n");
    utimesSync(join(dir, name), new Date(NOW - ago * MIN), new Date(NOW - ago * MIN));
  }
  const [one] = hires(base(h, [live("shop.backend-dev-checkout", "sub11111", cwd)]));
  expect([one.idleMinutes, one.lastActivity]).toEqual([2, new Date(NOW - 2 * MIN).toISOString()]);
});

test("a live session in a folder under the repo that is not a worktree (a repo nested in it) is not this repo's hire", () => {
  const h = home();
  transcript(h, REPO, "nest0001", [talk("x")], 5, `${REPO}/vendor/lib`);
  const nested = hires(base(h, [live("shop.backend-dev-vendor", "nest0001", `${REPO}/vendor/lib`)]));
  expect(nested).toEqual([]);
});

test("with two entries of one name, the stall is judged on the one with the newest activity", async () => {
  // an old session left next to a re-hired one: 300 minutes silent beside 3 minutes
  const r = await watchFleet(["lead-a"], [a({ ago: 300 }), a({ ago: 3 })]);
  expect([r.sleeps, r.out]).toEqual([17, "lead-a: idle 20 minutes\n"]);
});

test("a waiting name is watched as a plain one as soon as it writes again: an approved hire that then goes idle wakes, one that never writes stays waiting", async () => {
  const touch = (at: number) => (n: number, h: string, clock: number) => {
    if (n !== at) return;
    const cwd = `${REPO}/.claude/worktrees/x`;
    const file = join(h, ".claude", "projects", folder(cwd), "w0aaaaaa.jsonl");
    utimesSync(file, new Date(clock), new Date(clock));
  };
  const hire: Member = { name: "shop.backend-dev-x", ago: 3 };
  // It writes at the 5th minute, so it is plain from the 5th poll, and idle for 20 minutes at the 25th.
  const approved = await watchFleet(["shop.backend-dev-x:waiting"], [hire], 100, touch(5));
  expect([approved.woke, approved.sleeps, approved.out]).toEqual([true, 25, "shop.backend-dev-x: idle 20 minutes\n"]);
  // One that never writes (a Reviewer waiting after CHANGES REQUESTED, one waiting for letgo) is never woken for being quiet.
  expect((await watchFleet(["shop.backend-dev-x:waiting"], [hire], 100)).woke).toBe(false);
  // A waiting name with no transcript yet that starts writing is plain from then on too.
  const late = await watchFleet(["shop.backend-dev-x:waiting"], [{ name: "shop.backend-dev-x", ago: null }], 100, (n, h, clock) => {
    if (n === 2) transcript(h, `${REPO}/.claude/worktrees/x`, "w0aaaaaa", [talk("x")], 0);
  });
  expect([late.woke, late.sleeps]).toEqual([true, 20]); // its first line is at NOW, so it is idle for 20 minutes at the 20th poll
});

test("a fresh re-hire with no transcript yet is the newest entry of its name, not the old one beside it", async () => {
  const r = await watchFleet(["lead-a"], [a({ ago: 300 }), a({ ago: null })]);
  expect([r.sleeps, r.out]).toEqual([1, "lead-a: no activity time\n"]);
});

test("an ended hire whose main transcript is outside the window is not listed, whatever its sub-agents wrote", () => {
  const h = home();
  transcript(h, REPO, "old00001", [...named("old00001", "lead-old")], 30 * 60);
  const dir = join(h, ".claude", "projects", folder(REPO), "old00001", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-a.jsonl"), "{}\n");
  utimesSync(join(dir, "agent-a.jsonl"), new Date(NOW - 5 * MIN), new Date(NOW - 5 * MIN));
  expect(hires(base(h, []))).toEqual([]);
});

test("a stop whose text says only rate_limit_error is a limit stop with no time", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "rle00001", [limitStop("API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}")], 3);
  expect(hires(base(h, [live("shop.backend-dev-checkout", "rle00001", cwd)]))[0].limitUntil).toBe("unknown");
});

test("a waiting name whose wrap-up writes during the first minute stays waiting", async () => {
  const touch = (n: number, h: string, clock: number) => {
    if (n !== 1) return;
    const file = join(h, ".claude", "projects", folder(`${REPO}/.claude/worktrees/x`), "w0aaaaaa.jsonl");
    utimesSync(file, new Date(clock), new Date(clock));
  };
  expect((await watchFleet(["shop.backend-dev-x:waiting"], [{ name: "shop.backend-dev-x", ago: 3 }], 100, touch)).woke).toBe(false);
});

test("a sibling project's folder is never read, and the worktree folder of the longest repo f1rm status accepts is found, also with a task slug long enough for Claude Code to cut its name", () => {
  for (const length of [150, 100]) {
    const h = home();
    const repo = `/code/${"z".repeat(length - 6)}`; // "-code-" is 6 characters once encoded
    expect(folder(repo).length).toBe(length);
    // Folders of other projects whose names merely start like this repo's; each holds a hire that records this repo as its folder, so it would be listed if it were read.
    for (const [i, sibling] of [`${folder(repo)}-sibling`, `${folder(repo)}--other-project`, `${folder(repo)}--claude-worktrees`].entries()) {
      transcript(h, repo, `sib0000${i}`, [...named(`sib0000${i}`, `lead-sib${i}`)], 5, repo, sibling);
    }
    const cwd = `${repo}/.claude/worktrees/checkout`;
    transcript(h, cwd, "mine0001", [talk("x")], 4);
    expect(hires({ ...base(h, [live("shop.backend-dev-checkout", "mine0001", cwd)]), repo }).map((x) => [x.name, x.idleMinutes])).toEqual([["shop.backend-dev-checkout", 4]]);
  }
  // Task slugs have no length cap: at 150 a slug over 31 characters makes Claude Code cut the worktree folder's name (200 characters, then a hash), and the hire is still found
  // because the filter matches the folder by its `--claude-worktrees-` prefix, which the cut keeps whole.
  const repo = `/code/${"z".repeat(144)}`;
  const task = "t".repeat(60);
  const cwd = `${repo}/.claude/worktrees/${task}`;
  expect(folder(cwd).length).toBeGreaterThan(200);
  const h = home();
  // The hash suffix here is a guess; the match does not depend on it, only on the 200 characters that keep the whole prefix.
  transcript(h, cwd, "long0001", [talk("x")], 6, cwd, `${folder(cwd).slice(0, 200)}-9f8e7d`);
  expect(hires({ ...base(h, [live(`shop.backend-dev-${task}`, "long0001", cwd)]), repo }).map((x) => [x.name, x.idleMinutes])).toEqual([[`shop.backend-dev-${task}`, 6]]);
});

test("statusFor outside git says so, and asks for the repo only when there is something to serve", async () => {
  const deps = { home: home(), now: () => NOW, loadAgents: async () => [], sleep: async () => {}, commitTime: () => null };
  expect(await statusFor(parseArgs(["--json"]), null, deps)).toEqual({ out: "", err: "f1rm: not in a git repo", code: 1 });
  expect(await statusFor(parseArgs(["--watch", "lead-a"]), null, deps)).toMatchObject({ code: 1, err: "f1rm: not in a git repo" });
  let asked = 0;
  const lazy = () => (asked++, "/code/shop");
  await statusFor(parseArgs(["--bogus"]), lazy, deps);
  await statusFor(parseArgs(["--watch", ":waiting"]), lazy, deps);
  expect(asked).toBe(0); // a usage mistake and a watch with no names never ask git
  expect((await statusFor(parseArgs(["--json"]), lazy, deps)).code).toBe(0);
  expect(asked).toBe(1);
});

test("a named watch gets past the length check at 150 characters, and is refused at 151, with the work injected", async () => {
  const repos = longRepos();
  try {
    const deps = { home: home(), now: () => NOW, loadAgents: async () => null, sleep: async () => {}, commitTime: () => null };
    const args = parseArgs(["--watch", "lead-a"]);
    // At 150 it goes on to poll (and here finds claude agents unreadable): the error is that, not the path.
    const fine = await statusFor(args, repos.repo(150, { git: false }), deps);
    expect([fine.code, fine.err]).toEqual([1, expect.stringContaining("claude agents --json")]);
    expect(fine.err).not.toContain("too long");
    // statusFor answers, before it looks at the path: no names, and a usage mistake.
    const longRepo = repos.repo(151, { git: false });
    expect(await statusFor(parseArgs(["--watch"]), longRepo, deps)).toEqual({ out: "no names\n", err: "", code: 0 });
    expect(await statusFor(parseArgs(["--watch", ":waiting"]), longRepo, deps)).toMatchObject({ out: "no names\n", code: 0 });
    expect(await statusFor(parseArgs(["--bogus"]), longRepo, deps)).toMatchObject({ code: 1, err: expect.stringContaining("usage: f1rm status") });
    const long = await statusFor(args, longRepo, deps);
    expect([long.code, long.err]).toEqual([1, expect.stringContaining("this repo's path is too long for f1rm status (Claude Code cuts the project folder name; the limit is 150 characters, so the `--claude-worktrees-` prefix of a worktree's folder stays whole)")]);
  } finally {
    repos.cleanup();
  }
});

test("what the office's recovery noted about a hire shows as its NOTE and as `recovery` in --json; a hire it noted nothing about shows none", async () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "aaaa1111", [talk("working on it")], 5);
  transcript(h, `${REPO}/.claude/worktrees/landing`, "cccc3333", [talk("working on it")], 5);
  const dir = join(h, ".f1rm", "recovery");
  mkdirSync(dir, { recursive: true });
  const note = "shop.backend-dev-checkout stopped again after a wake; f1rm wake shop.backend-dev-checkout";
  writeFileSync(join(dir, "-code-shop.json"), JSON.stringify({ "shop.backend-dev-checkout": { note, wokeAt: 1 }, "shop.designer-landing": { wokeAt: 2 } }));
  const list = [live("shop.backend-dev-checkout", "aaaa1111", cwd), live("shop.designer-landing", "cccc3333", `${REPO}/.claude/worktrees/landing`)];
  const [dev, designer] = hires(base(h, list));
  expect([dev.recovery, designer.recovery]).toEqual([note, null]);
  const deps = { home: h, now: () => NOW, loadAgents: async () => list, sleep: async () => {}, commitTime: () => null };
  const text = await statusFor(parseArgs([]), REPO, deps);
  expect(text.out.split("\n")[1]).toContain(note);
  expect(JSON.parse((await statusFor(parseArgs(["--json"]), REPO, deps)).out)[0].recovery).toBe(note);
  // A file that is not JSON, or an entry of another shape, shows nothing and breaks nothing.
  writeFileSync(join(dir, "-code-shop.json"), "{cut");
  expect(hires(base(h, list)).map((x) => x.recovery)).toEqual([null, null]);
  writeFileSync(join(dir, "-code-shop.json"), JSON.stringify({ "shop.backend-dev-checkout": { note: 7 } }));
  expect(hires(base(h, list)).map((x) => x.recovery)).toEqual([null, null]);
});

test("headAsync and tailAsync read what head and tail read, a missing file as empty, and any other error through", async () => {
  const h = home();
  const file = join(h, "t.jsonl");
  const lines = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ type: "assistant", n: i, pad: "x".repeat(60) }));
  writeFileSync(file, lines.join("\n") + "\n");
  expect(await tailAsync(file)).toBe(tail(file));
  expect(await headAsync(file)).toBe(head(file));
  expect((await tailAsync(file)).split("\n").at(-2)).toContain('"n":5999');
  expect(await tailAsync(join(h, "none.jsonl"))).toBe("");
  expect(await headAsync(join(h, "none.jsonl"))).toBe("");
  await expect(tailAsync(h)).rejects.toThrow(); // a folder where a transcript should be
});

test("lastTurn skips what startsTurn says is no turn: a skill's meta body, a tool result and a sidechain line leave a limit stop standing; a cross-session message and a prompt end it", () => {
  const user = (content: unknown, more: object = {}) => ({ type: "user", message: { role: "user", content }, ...more });
  const stop = limitStop();
  const until = (...after: object[]) => {
    const text = [stop, ...after].map((l) => JSON.stringify(l)).join("\n");
    return limitUntil(text);
  };
  expect(until(user([{ type: "text", text: "Base directory for this skill: /x" }], { isMeta: true }))).toBe("8:40pm (Europe/Lisbon)");
  expect(until(user([{ type: "text", text: "<local-command-caveat>Caveat</local-command-caveat>" }], { isMeta: true }))).toBe("8:40pm (Europe/Lisbon)");
  expect(until(user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]))).toBe("8:40pm (Europe/Lisbon)");
  expect(until(talk("a sub-agent talking", { isSidechain: true }))).toBe("8:40pm (Europe/Lisbon)");
  expect(until(user('Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock">resume</cross-session-message>', { isMeta: true }))).toBeNull();
  expect(until(user("resume"))).toBeNull();
});

test("tailAsync reads a missing file as empty, and any other error shows: a file nobody may read, and a folder nobody may search (the stat path)", async () => {
  const h = home();
  const file = join(h, "locked.jsonl");
  writeFileSync(file, "x\n");
  const root = process.getuid?.() === 0;
  chmodSync(file, 0o000);
  try {
    if (!root) await expect(tailAsync(file)).rejects.toThrow();
  } finally {
    chmodSync(file, 0o600);
  }
  const dir = join(h, "closed");
  mkdirSync(dir);
  writeFileSync(join(dir, "t.jsonl"), "x\n");
  chmodSync(dir, 0o600); // readable and writable, not searchable: stat of a file in it fails with EACCES
  try {
    if (!root) await expect(tailAsync(join(dir, "t.jsonl"))).rejects.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(await tailAsync(join(h, "none.jsonl"))).toBe("");
});

// Reports as files: `f1rm report` writes ~/.f1rm/evidence/<repo>/<slug>/report.json, and the watcher wakes once per new seq of a watched hire.
const report = (h: string, slug: string, seq: number, more: object = {}) => {
  const file = reportFile(h, "shop", slug);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ kind: "DONE", slug, commit: "abc1234def", note: null, at: new Date(NOW).toISOString(), seq, ...more }));
};
const lead = { name: "lead-a", ago: 3 };
const dev = { name: "shop.backend-dev-x", ago: 3 };

test("a watched hire's new report wakes the watcher with its kind, short commit and seq, and exit 0", async () => {
  const r = await watchFleet(["shop.backend-dev-x"], [dev], 100, (n, h) => n === 3 && report(h, "x", 3));
  expect(r).toMatchObject({ woke: true, sleeps: 3, code: 0, out: "shop.backend-dev-x: reported DONE (commit abc1234, report.json seq 3)\n" });
});

test("a Reviewer's report is read from review-<task>, a CHANGES one reads as CHANGES REQUESTED, and a report with no commit names none", async () => {
  const r = await watchFleet(["reviewer-review-x"], [{ name: "reviewer-review-x", ago: 3 }], 100, (n, h) => n === 1 && report(h, "review-x", 1, { kind: "CHANGES", commit: null }));
  expect(r.out).toBe("reviewer-review-x: reported CHANGES REQUESTED (report.json seq 1)\n");
});

test("a simple dev (no team) is watched like a team member: its report is read from its task, NEEDS reads as NEEDS YOU, and it stalls when quiet", async () => {
  const solo = { name: "backend-dev-x", ago: 3 };
  const needs = await watchFleet(["backend-dev-x"], [solo], 100, (n, h) => n === 2 && report(h, "x", 1, { kind: "NEEDS", commit: null }));
  expect(needs.out).toBe("backend-dev-x: reported NEEDS YOU (report.json seq 1)\n");
  expect((await watchFleet(["backend-dev-x"], [solo], 100, (n, h) => n === 1 && report(h, "x", 1))).out).toBe("backend-dev-x: reported DONE (commit abc1234, report.json seq 1)\n");
  expect(await watchFleet(["backend-dev-x"], [solo])).toMatchObject({ woke: true, out: "backend-dev-x: idle 20 minutes\n" });
  expect((await watchFleet(["backend-dev-x:waiting"], [solo], 100)).woke).toBe(false);
  expect(await watchFleet(["backend-dev-x"], [{ ...solo, ended: true }])).toMatchObject({ out: "backend-dev-x: ended\n" });
  const h = home();
  const table = (await status({ json: false }, { repo: REPO, home: h, now: NOW, commitTime: () => null, loadAgents: async () => fleet(h, [solo]) })).out.split("\n");
  expect(table[1]).toStartWith("backend-dev-x  backend-dev  -");
});

test("f1rm status shows a NEEDS report as NEEDS YOU, as the watcher does", async () => {
  const h = home();
  const listed = fleet(h, [dev]);
  report(h, "x", 1, { kind: "NEEDS", commit: null });
  const table = (await status({ json: false }, { repo: REPO, home: h, now: NOW, commitTime: () => null, loadAgents: async () => listed })).out;
  expect(table).toContain("NEEDS YOU #1");
});

test("a waiting name is woken by a new report, though it writes nothing", async () => {
  const r = await watchFleet(["shop.backend-dev-x:waiting"], [dev], 100, (n, h) => n === 4 && report(h, "x", 1));
  expect([r.woke, r.sleeps, r.out]).toEqual([true, 4, "shop.backend-dev-x: reported DONE (commit abc1234, report.json seq 1)\n"]);
});

test("each seq wakes once: the announced one is kept in ~/.f1rm/watch/<repo>.json, a later watcher skips it, and the next seq wakes again", async () => {
  const h = home();
  report(h, "x", 1);
  const first = await watchFleet(["shop.backend-dev-x"], [dev], 100, () => {}, h);
  expect([first.woke, first.sleeps]).toEqual([true, 1]);
  const file = join(h, ".f1rm", "watch", "-code-shop.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "shop.backend-dev-x": 1 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // The same report is not announced again; the watcher runs on until the hire is quiet.
  expect(await watchFleet(["shop.backend-dev-x"], [dev], 100, () => {}, h)).toMatchObject({ sleeps: 17, out: "shop.backend-dev-x: idle 20 minutes\n" });
  const next = await watchFleet(["shop.backend-dev-x"], [dev], 100, (n, h2) => n === 2 && report(h2, "x", 2), h);
  expect([next.sleeps, next.out]).toEqual([2, "shop.backend-dev-x: reported DONE (commit abc1234, report.json seq 2)\n"]);
});

test("a report of a hire that is not named in the watch is not announced", async () => {
  const r = await watchFleet(["lead-a"], [lead, dev], 100, (n, h) => n === 1 && report(h, "x", 1));
  expect(r.out).toBe("lead-a: idle 20 minutes\n");
  expect(r.sleeps).toBe(17);
});

test("a report that is still there when the watch sees an ended hire is announced beside the stall", async () => {
  const r = await watchFleet(["shop.backend-dev-x"], [{ ...dev, ended: true }], 100, (n, h) => n === 1 && report(h, "x", 1));
  expect(r.out).toBe("shop.backend-dev-x: reported DONE (commit abc1234, report.json seq 1)\nshop.backend-dev-x: ended\n");
});

test("f1rm status shows each hire's last report (kind, seq, how long ago) in a REPORT column and a report field", async () => {
  const h = home();
  const listed = fleet(h, [dev, lead]);
  report(h, "x", 3, { kind: "BLOCKED", at: new Date(NOW - 12 * MIN).toISOString() });
  const deps = { repo: REPO, home: h, now: NOW, commitTime: () => null, loadAgents: async () => listed };
  const table = (await status({ json: false }, deps)).out.split("\n");
  expect(table[0]).toContain("REPORT");
  expect(table.find((l) => l.startsWith("shop.backend-dev-x"))).toContain("BLOCKED #3 12m ago");
  expect(table.find((l) => l.startsWith("lead-a"))).not.toContain("#");
  const json = JSON.parse((await status({ json: true }, deps)).out);
  expect(json.find((x: Hire) => x.name === "shop.backend-dev-x").report).toEqual({ kind: "BLOCKED", seq: 3, at: new Date(NOW - 12 * MIN).toISOString() });
  expect(json.find((x: Hire) => x.name === "lead-a").report).toBeNull();
});

test("a watcher that wakes from a sleep (a gap over 2 minutes between polls) judges no one stalled for 5 minutes, and then does", async () => {
  const r = await watchFleet(["lead-a"], [a({ ago: 600 })], 20, (n) => (n === 1 ? 3 * MIN : undefined));
  expect(r).toMatchObject({ woke: true, sleeps: 6, out: "lead-a: idle 609 minutes\n" }); // the poll that ends the grace is the 5th minute after the first one back
  // A gap of exactly 2 minutes (the poll's minute and one more) is no sleep.
  expect(await watchFleet(["lead-a"], [a({ ago: 600 })], 20, (n) => (n === 1 ? MIN : undefined))).toMatchObject({ woke: true, sleeps: 1 });
});

// ── a paused project ───────────────────────────────────────────────────────
const pause = (h: string, why = "") => writePaused(pausedFile(pausedDirOf(h), REPO), { by: "manual", at: NOW - 5 * MIN, why });
const SINCE = new Date(NOW - 5 * MIN).toISOString();

test("status says the project is paused on a line of its own above the table, and prints the table and the json as before otherwise", async () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "cccc3333", [talk("on it")], 3);
  const deps = { ...base(h, []), loadAgents: async () => [live("shop.backend-dev-checkout", "cccc3333", cwd)] };
  const before = await status({ json: false }, deps);
  expect(before.out.split("\n")[0]).toContain("NAME");
  const json = (await status({ json: true }, deps)).out;
  pause(h, "lunch");
  expect((await status({ json: false }, deps)).out).toBe(`PAUSED (manual) since ${SINCE}: lunch; \`f1rm resume\` wakes it\n${before.out}`);
  expect((await status({ json: false }, { ...deps, loadAgents: async () => [] })).out).toBe(`PAUSED (manual) since ${SINCE}: lunch; \`f1rm resume\` wakes it\nno hires\n`);
  pause(h);
  expect((await status({ json: false }, { ...deps, loadAgents: async () => [] })).out).toBe(`PAUSED (manual) since ${SINCE}; \`f1rm resume\` wakes it\nno hires\n`);
  expect((await status({ json: true }, deps)).out).toBe(json); // the json stays one array of hires
});

test("a watcher reports no stall while the project is paused, and the first poll after the resume does", async () => {
  const r = await watchFleet(["lead-a"], [a({ ago: 600 })], 20, (n, home) => {
    if (n === 1) pause(home);
    if (n === 5) rmSync(pausedFile(pausedDirOf(home), REPO));
  });
  expect(r).toMatchObject({ woke: true, sleeps: 5, out: "lead-a: idle 605 minutes\n" }); // polls 1 to 4 find it idle for 20 minutes and say nothing
});
