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
import { endedBefore, head, headAsync, hires, limitUntil, ls, parseArgs, status, statusFor, tail, tailAsync, type Hire } from "./status.ts";

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

const a = (extra: Partial<Member> = {}): Member => ({ name: "lead-a", ago: 3, ...extra });

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

test("f1rm status shows a NEEDS report as NEEDS YOU, as the watcher does", async () => {
  const h = home();
  const listed = fleet(h, [dev]);
  report(h, "x", 1, { kind: "NEEDS", commit: null });
  const table = (await status({ json: false }, { repo: REPO, home: h, now: NOW, commitTime: () => null, loadAgents: async () => listed })).out;
  expect(table).toContain("NEEDS YOU #1");
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

test("a transcript ends on a finished turn when its last entries are the bookkeeping after a reply, written before the cut-off", () => {
  const at = (t: string) => `"timestamp":"2026-11-09T${t}:00.000Z"`;
  const done = [`{"type":"assistant","message":{"content":[{"type":"text","text":"Published."}]},${at("09:29")}}`, `{"type":"system","subtype":"stop_hook_summary",${at("09:29")}}`, `{"type":"system","subtype":"turn_duration",${at("09:30")}}`].join("\n");
  expect(endedBefore(done, Date.parse("2026-11-09T10:00:00Z"))).toBe(true);
  expect(endedBefore(done, Date.parse("2026-11-09T09:20:00Z"))).toBe(false); // ended too recently to judge
  expect(endedBefore(`${done}\n{"type":"user","message":{"content":"go on"},${at("09:40")}}`, Date.parse("2026-11-09T10:00:00Z"))).toBe(false); // a new turn began
  expect(endedBefore(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]},${at("09:29")}}`, Date.parse("2026-11-09T10:00:00Z"))).toBe(false); // mid-tool
  expect(endedBefore("", Date.parse("2026-11-09T10:00:00Z"))).toBe(false);
});

test("a turn that ended while a background command or intern it started is still out has not ended", () => {
  const at = (t: string) => `"timestamp":"2026-11-09T${t}:00.000Z"`;
  const started = `{"type":"user","message":{"content":[{"type":"tool_result","content":"Command running in background with ID: byhzzfu6p. Output is being written to /tmp/x"}]},${at("16:31")}}`;
  const ended = `{"type":"assistant","message":{"content":[{"type":"text","text":"Waiting for the smoke run."}]},${at("16:32")}}\n{"type":"system","subtype":"turn_duration",${at("16:32")}}`;
  const later = Date.parse("2026-11-09T18:00:00Z");
  expect(endedBefore(`${started}\n${ended}`, later)).toBe(false);
  const back = `{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\\n<task-id>byhzzfu6p</task-id>\\n<status>completed</status>",${at("16:40")}}`;
  expect(endedBefore(`${started}\n${back}\n${ended.replaceAll("16:32", "16:41")}`, later)).toBe(true);
});
