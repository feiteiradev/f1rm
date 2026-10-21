// Seam: `f1rm status`, from a temp HOME's transcripts, an injected `claude agents --json` list, an injected clock and an injected commit lookup.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { head, hires, ls, status, tail, type Hire } from "./status.ts";

const REPO = "/code/shop";
const NOW = Date.parse("2026-10-21T12:00:00Z");
const MIN = 60_000;

const home = () => mkdtempSync(join(tmpdir(), "f1rm-status-"));
/** Claude Code's folder for a working directory: every character that is not a letter or digit becomes `-`. */
const folder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Writes `lines` as the session's transcript under the encoded `cwd` folder, last written `agoMin` minutes before NOW. */
function transcript(h: string, cwd: string, sessionId: string, lines: object[], agoMin: number) {
  const file = join(h, ".claude", "projects", folder(cwd), `${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
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

test("a hire whose last assistant line is the limit stop shows when the limit lifts, whatever agents says", () => {
  const h = home();
  const cwd = `${REPO}/.claude/worktrees/checkout`;
  transcript(h, cwd, "cccc3333", [talk("step one"), limitStop(), { type: "cost-state", sessionId: "cccc3333" }], 3);
  const [one] = hires(base(h, [live("shop.backend-dev-checkout", "cccc3333", cwd)]));
  expect(one.limitUntil).toBe("8:40pm (Europe/Lisbon)");
  expect(one.status).toBe("busy"); // as agents says, not as it is
  expect(one.idleMinutes).toBe(3);
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
  expect(() => ls("/etc/hosts/x")).toThrow(); // ENOTDIR, not ENOENT
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
