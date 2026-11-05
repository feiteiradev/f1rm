// Seam: `f1rm wake`. planWake against an injected `claude agents --json` (live and --all), a temp HOME's transcripts and an injected clock; the real command against a stub `claude`.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HireRefused, LOAD_FIRST, NO_SLOT, projectFolder as folder, SECURITY, UsageHold, type Wait } from "./hire.ts";
import { hireName } from "./letgo.ts";
import { clearPaused, pausedDirOf, pausedFile, writePaused } from "../server/pause.ts";
import { DEFAULT_NOTE, firstPrompt, lastModel, mayWake, parseWakeArgs, planWake, planWakeWaiting } from "./wake.ts";

setDefaultTimeout(30_000);
// The real `f1rm wake` waits for a slot up to 8 minutes; the processes these tests spawn give up at once (the wait itself is tested in process, below).
process.env.F1RM_SLOT_WAIT_MS = "0";
const made: string[] = [];
const tmp = (prefix: string) => (made.push(mkdtempSync(join(tmpdir(), prefix))), made[made.length - 1]);
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const REPO = "/code/shop";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const wt = (task: string, repo = REPO) => `${repo}/.claude/worktrees/${task}`;

// What `claude agents --json` lists: a live session has a pid; one whose process ended (done, stopped, failed, blocked on a limit) has none.
type Entry = Record<string, unknown>;
const entry = (name: string, sessionId: string, cwd: string, more: Entry = {}): Entry => ({ id: sessionId.slice(0, 8), kind: "background", name, sessionId, cwd, startedAt: 1000, ...more });
const running = (name: string, sessionId: string, cwd: string, more: Entry = {}) => entry(name, sessionId, cwd, { pid: 100 + sessionId.length, state: "working", status: "busy", ...more });
const idle = (name: string, sessionId: string, cwd: string) => running(name, sessionId, cwd, { status: "idle" });
const stopped = (name: string, sessionId: string, cwd: string, state = "stopped", more: Entry = {}) => entry(name, sessionId, cwd, { state, ...more });

/** What the two `claude agents --json` calls say: --all lists everything, the plain call the sessions that run, and a blocked one (it has no process but holds its slot). */
const deps = (list: Entry[], more: { home?: string; exists?: (p: string) => boolean; modelOf?: (cwd: string, sessionId: string) => string | null; promptOf?: (cwd: string, sessionId: string) => string | null } = {}) => ({
  agents: async (all: boolean) => (all ? list : list.filter((a) => a.pid || a.state === "blocked")),
  gitCommonDir: () => `${REPO}/.git`,
  home: more.home ?? tmp("f1rm-wake-home-"),
  now: NOW,
  exists: more.exists ?? (() => true),
  modelOf: more.modelOf ?? (() => null),
  promptOf: more.promptOf ?? (() => null),
});
const plan = (target: string, list: Entry[], req: { message?: string; override?: boolean; extra?: string[] } = {}, more: Parameters<typeof deps>[1] = {}) =>
  planWake({ target, cwd: REPO, ...req }, deps(list, more));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
/** A HOME whose usage file holds the 5-hour window at `pct`, resetting an hour after `nowMs`: the wake reads it at its own clock. */
const usageHome = (pct: number, nowMs: number, home = tmp("f1rm-wake-home-")) => {
  mkdirSync(join(home, ".f1rm"), { recursive: true });
  writeFileSync(join(home, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: pct, resetsAt: nowMs / 1000 + 3600 }, readAt: 0 }));
  return home;
};

const TAP_OBJ = { type: "command", command: `'${process.execPath}' '${join(import.meta.dir, "f1rm.ts")}' usage-tap` };
const TAPPED = JSON.stringify({ statusLine: TAP_OBJ });
const FULL = JSON.stringify({ env: { PONYTAIL_DEFAULT_MODE: "full" }, statusLine: TAP_OBJ });
const lead = running("lead-shop", "lead-sid", REPO);

test("a stopped member is resumed in the background with its agent, its name and its own worktree, and told where to report", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const p = await plan("shop.backend-dev-checkout", [lead, dev], { message: "fix round 2: see the review" });
  expect(p.argv).toEqual([
    "claude", "--bg", "--resume", "dev-sid-1", "--agent", "f1rm:backend-dev", "--name", "shop.backend-dev-checkout",
    "fix round 2: see the review\nReport to: lead-shop",
    "--settings", FULL,
    "--effort", "high",
  ]);
  expect(p.cwd).toBe(wt("checkout"));
  expect([p.name, p.sessionId]).toEqual(["shop.backend-dev-checkout", "dev-sid-1"]);
});

test("a wake message never starts with a slash: a resumed session expands its first prompt as a slash command, so `/f1rm:stop-all` here would run as the user's", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  for (const message of ["/f1rm:stop-all", "  /f1rm:resume-all  ", "\n/f1rm:stop-all\nplease"]) {
    const refused = await failure(plan("shop.backend-dev-checkout", [lead, dev], { message }));
    expect(refused?.message).toContain("slash");
  }
  // A slash inside the message is a message like any other.
  const ok = await plan("shop.backend-dev-checkout", [lead, dev], { message: "fix round 2: see src/a.ts and /tmp/notes" });
  expect(ok.argv).toContain("fix round 2: see src/a.ts and /tmp/notes\nReport to: lead-shop");
  // f1rm's own notes (no message: the default note, the office's) are not slash commands and still plan.
  const noted = await plan("shop.backend-dev-checkout", [lead, dev]);
  expect(noted.argv).toContain(`${DEFAULT_NOTE}\nReport to: lead-shop`);
  const { SLASH_RULE } = await import("./wake.ts");
  expect(() => parseWakeArgs(["lead-shop", "please", "rerun"])).toThrow(SLASH_RULE); // the usage error carries the rule
  expect(SLASH_RULE).toContain("cannot start with a slash");
});

test("a hire of a paused project is not woken, and the refusal points at `f1rm resume`; once resumed it is woken as before", async () => {
  const home = tmp("f1rm-wake-home-");
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const file = pausedFile(pausedDirOf(home), REPO);
  writePaused(file, { by: "manual", at: NOW, why: "lunch" });
  const refused = await failure(plan("shop.backend-dev-checkout", [lead, dev], {}, { home }));
  expect(refused?.message).toContain("shop is paused");
  expect(refused?.message).toContain("f1rm resume");
  const other = await plan("shop.backend-dev-checkout", [lead, dev], {}, { home: tmp("f1rm-wake-home-") }); // another office home has no pause
  expect(other.name).toBe("shop.backend-dev-checkout");
  clearPaused(file);
  expect((await plan("shop.backend-dev-checkout", [lead, dev], {}, { home })).name).toBe("shop.backend-dev-checkout");
});

test("a woken member keeps ponytail full, a woken lead keeps the default, and a --settings the caller passes gets the level merged into it", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const full = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === "--settings");
  expect(full((await plan("shop.backend-dev-checkout", [lead, dev])).argv)).toEqual([FULL]);
  expect(full((await plan("lead-shop", [stopped("lead-shop", "old-lead", REPO, "blocked", { startedAt: 5 })])).argv)).toEqual([TAPPED]); // a lead has no ponytail env, but reports usage
  const own = (await plan("shop.backend-dev-checkout", [lead, dev], { extra: ["--settings", '{"disableAllHooks":true}'] })).argv;
  expect(full(own).map((s) => JSON.parse(s))).toEqual([{ disableAllHooks: true, env: { PONYTAIL_DEFAULT_MODE: "full" }, statusLine: TAP_OBJ }]);
});

test("a woken lead carries --effort medium, a woken member --effort high, and the caller's own --effort is the only one", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const eff = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === "--effort");
  expect(eff((await plan("shop.backend-dev-checkout", [lead, dev])).argv)).toEqual(["high"]);
  expect(eff((await plan("lead-shop", [stopped("lead-shop", "old-lead", REPO, "blocked", { startedAt: 5 })])).argv)).toEqual(["medium"]);
  expect(eff((await plan("shop.backend-dev-checkout", [lead, dev], { extra: ["--effort", "low"] })).argv)).toEqual(["low"]);
});

test("the checks wait for a git lookup and transcript readers that answer later, so the office's event loop is never blocked", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const later = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), 5));
  const base = deps([lead, dev]);
  const p = await planWake({ target: "shop.backend-dev-checkout", cwd: REPO }, {
    ...base, gitCommonDir: () => later(`${REPO}/.git`), modelOf: () => later("claude-haiku-5-5"), promptOf: () => later("brief\nReport to: lead-elsewhere"),
  });
  expect(p.argv.slice(-2)).toEqual(["--model", "claude-haiku-5-5"]);
  expect(p.argv).toContain("resumed; continue your task\nReport to: lead-elsewhere");
});

test("without a message the note says the hire was resumed; the sentence that names the skills to load is never in it", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const p = await plan("shop.backend-dev-checkout", [lead, dev]);
  expect(p.argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop`);
  expect(DEFAULT_NOTE).toBe("resumed; continue your task");
  expect(p.argv.join(" ")).not.toContain(LOAD_FIRST.trim());
});

test("a hire is found by its name, its session id or its short id, and flags after the message go to claude as given", async () => {
  const dev = stopped("shop.designer-landing", "abcd1234-0000", wt("landing"), "done");
  for (const target of ["shop.designer-landing", "abcd1234-0000", "abcd1234"]) {
    const p = await plan(target, [lead, dev], { extra: ["--model", "haiku"] });
    expect([target, p.argv.slice(0, 8), p.argv.slice(-4)]).toEqual([target, ["claude", "--bg", "--resume", "abcd1234-0000", "--agent", "f1rm:designer", "--name", "shop.designer-landing"], ["--model", "haiku", "--effort", "high"]]);
  }
});

test("a stopped worktree hire is listed with the main repo as its folder: the resume runs in its worktree, with the model and the Report to its transcript there holds", async () => {
  // `claude agents --json --all` lists a stopped session of a worktree hire with cwd = the repo; the transcript of the old session is under the worktree's folder.
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", REPO);
  const seen: string[][] = [];
  const onlyThere = <T>(answer: T) => (cwd: string, sessionId: string) => (seen.push([cwd, sessionId]), cwd === wt("checkout") ? answer : null);
  const p = await plan("shop.backend-dev-checkout", [lead, dev], {}, {
    exists: (path) => path === wt("checkout") || path === REPO,
    modelOf: onlyThere("claude-haiku-5-5"),
    promptOf: onlyThere("brief\nReport to: lead-elsewhere"),
  });
  expect(p.cwd).toBe(wt("checkout"));
  expect(p.argv.slice(-2)).toEqual(["--model", "claude-haiku-5-5"]);
  expect(p.argv).toContain("resumed; continue your task\nReport to: lead-elsewhere");
  expect(seen).toEqual([[wt("checkout"), "dev-sid-1"], [wt("checkout"), "dev-sid-1"]]);
});

test("a lead and a Reviewer have no worktree and resume at the repo; a specialist whose worktree folder is gone is refused, never resumed in the main checkout the listing gives", async () => {
  const exists = (path: string) => path === REPO || path === wt("checkout");
  const reviewer = stopped("shop.reviewer-review-checkout", "rev-sid-1", REPO);
  expect((await plan("shop.reviewer-review-checkout", [lead, reviewer], {}, { exists })).cwd).toBe(REPO); // wt("checkout") exists, and is still not the Reviewer's folder
  const oldLead = stopped("lead-shop", "lead-sid-0", REPO);
  expect((await plan("lead-shop", [oldLead], {}, { exists })).cwd).toBe(REPO);
  // A lead is never put in a worktree, even when a task slug equals its team's slug and that worktree is on disk.
  const sameSlug = (path: string) => path === REPO || path === wt("shop");
  expect((await plan("lead-shop", [oldLead], {}, { exists: sameSlug })).cwd).toBe(REPO);
  // The listing gives the repo for a stopped worktree hire: with its worktree gone it is refused (the office tells its Report to), not resumed where it could edit the main checkout.
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", REPO);
  const gone = await failure(plan("shop.backend-dev-checkout", [lead, dev], {}, { exists: (path) => path === REPO }));
  expect(gone?.message).toBe("shop.backend-dev-checkout was let go; hire a new one");
  // And a listing that still gives the worktree itself is resumed there.
  const listed = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  expect((await plan("shop.backend-dev-checkout", [lead, listed], {}, { exists })).cwd).toBe(wt("checkout"));
});

test("the woken hire keeps the model it last answered with, unless the caller gives one: a resume alone falls back to the role's own", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const seen: string[][] = [];
  const modelOf = (cwd: string, sessionId: string) => (seen.push([cwd, sessionId]), "claude-haiku-5-5");
  const kept = await plan("shop.backend-dev-checkout", [lead, dev], {}, { modelOf });
  expect(seen).toEqual([[wt("checkout"), "dev-sid-1"]]);
  expect(kept.argv.slice(-2)).toEqual(["--model", "claude-haiku-5-5"]);
  const given = await plan("shop.backend-dev-checkout", [lead, dev], { extra: ["--model", "opus"] }, { modelOf });
  expect(given.argv.filter((a) => a === "--model")).toHaveLength(1);
  expect(given.argv.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]);
  expect((await plan("shop.backend-dev-checkout", [lead, dev])).argv).not.toContain("--model"); // no transcript to read
  // The `--model=<x>` spelling is a model too: the old one is not appended after it.
  const equals = await plan("shop.backend-dev-checkout", [lead, dev], { extra: ["--model=opus"] }, { modelOf });
  expect(equals.argv.slice(-3)).toEqual(["--model=opus", "--effort", "high"]);
  expect(equals.argv).not.toContain("claude-haiku-5-5");
});

test("lastModel reads the model of the conversation's last answer, not a sub-agent's, an error line's or a session with none", () => {
  const line = (o: object) => JSON.stringify(o);
  const answer = (model: string, more: object = {}) => line({ type: "assistant", message: { model, content: [{ type: "text", text: "x" }] }, ...more });
  expect(lastModel([answer("claude-sonnet-5-5"), answer("claude-haiku-5-5")].join("\n"))).toBe("claude-haiku-5-5");
  expect(lastModel([answer("claude-haiku-5-5"), answer("claude-opus-5-5", { isSidechain: true }), answer("<synthetic>"), line({ type: "system" }), "{cut"].join("\n"))).toBe("claude-haiku-5-5");
  expect(lastModel(line({ type: "user", message: { content: "hi" } }))).toBeNull();
  expect(lastModel("")).toBeNull();
});

test("a lead is woken from the repo itself and reports to the PM; a Reviewer reports to its lead", async () => {
  const gone = stopped("lead-shop", "old-lead", REPO, "blocked", { startedAt: 5 });
  const p = await plan("lead-shop", [gone]);
  expect(p.argv.slice(0, 8)).toEqual(["claude", "--bg", "--resume", "old-lead", "--agent", "f1rm:lead", "--name", "lead-shop"]);
  expect(p.argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: pm-shop`);
  expect(p.cwd).toBe(REPO);
  const rv = await plan("shop.reviewer-review-checkout", [lead, stopped("shop.reviewer-review-checkout", "rv-sid", REPO, "done")]);
  expect(rv.argv).toContain("f1rm:reviewer");
  expect(rv.argv[8]).toContain("Report to: lead-shop");
});

test("a woken Reviewer is not counted against the task it reviews: its dev, idle after DONE, does not refuse it", async () => {
  const dev = idle("shop.backend-dev-checkout", "dev-sid", wt("checkout"));
  const rv = stopped("shop.reviewer-review-checkout", "rv-sid", REPO, "done");
  expect((await plan("shop.reviewer-review-checkout", [lead, dev, rv])).sessionId).toBe("rv-sid");
  // One Reviewer per task still holds: a live one of the same name makes the wake a message instead.
  const err = await failure(plan("shop.reviewer-review-checkout", [lead, dev, rv, running("shop.reviewer-review-checkout", "rv-live", REPO)]));
  expect(err?.message).toContain("is live");
});

test("a woken Reviewer keeps the push block `f1rm hire` gives it, last in the argv, and no other role gets it", async () => {
  const rv = await plan("shop.reviewer-review-checkout", [lead, stopped("shop.reviewer-review-checkout", "rv-sid", REPO, "done")], { extra: ["--settings", "{}"] }, { modelOf: () => "claude-sonnet-5-5" });
  expect(rv.argv.slice(-2)).toEqual(["--disallowedTools", "Bash(git push *)"]);
  expect(rv.argv.slice(-4, -2)).toEqual(["--model", "claude-sonnet-5-5"]);
  expect(rv.argv).toContain("--settings");
  expect((await plan("shop.backend-dev-checkout", [lead, stopped("shop.backend-dev-checkout", "d", wt("checkout"))])).argv).not.toContain("--disallowedTools");
});

test("a woken hire reports to the session its first prompt named, and to the default only when that prompt can't be read", async () => {
  const promptOf = (prompt: string | null) => () => prompt;
  const first = (to: string) => `/f1rm:f1rm-guidelines Before you start, load these with the Skill tool: f1rm:hire. Report to: ${to}\n\nbrief`;
  const gone = stopped("lead-shop", "old-lead", REPO, "done");
  expect((await plan("lead-shop", [gone], {}, { promptOf: promptOf(first("pm-custom")) })).argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: pm-custom`);
  expect((await plan("lead-shop", [gone], {}, { promptOf: promptOf(null) })).argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: pm-shop`);
  expect((await plan("lead-shop", [gone], {}, { promptOf: promptOf("no report line here") })).argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: pm-shop`);
  const dev = stopped("shop.backend-dev-checkout", "d", wt("checkout"));
  expect((await plan("shop.backend-dev-checkout", [lead, dev], {}, { promptOf: promptOf(first("lead-shop")) })).argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop`);
});

test("an unquoted message is a usage error, not a message cut to its first word", () => {
  expect(() => parseWakeArgs(["lead-shop", "please", "rerun", "the", "tests"])).toThrow(/usage: f1rm wake[^]*quote the message/);
  expect(() => parseWakeArgs(["lead-shop", "--override", "please", "rerun"])).toThrow(/quote the message/);
  expect(parseWakeArgs(["lead-shop", "please rerun the tests", "--model", "opus"]).message).toBe("please rerun the tests");
  expect(parseWakeArgs(["lead-shop", "--model", "opus", "a", "b"]).extra).toEqual(["--model", "opus", "a", "b"]); // past the first flag it is claude's
});

test("--override is read wherever it stands before the claude flags, and what follows the first flag goes to claude as given", () => {
  expect(parseWakeArgs(["lead-shop"])).toEqual({ target: "lead-shop", message: undefined, override: false, extra: [] });
  expect(parseWakeArgs(["--override", "lead-shop", "go"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: [] });
  expect(parseWakeArgs(["lead-shop", "--override", "go", "--model", "opus"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: ["--model", "opus"] });
  expect(parseWakeArgs(["lead-shop", "go", "--override"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: [] });
  expect(parseWakeArgs(["lead-shop", "--model", "opus", "--override"])).toEqual({ target: "lead-shop", message: undefined, override: false, extra: ["--model", "opus", "--override"] });
});

test("a woken --level high Reviewer's note carries the security hold sentence its first prompt carried, and no note carries the load-first sentence", async () => {
  const rv = stopped("shop.reviewer-review-checkout", "rv-sid", REPO, "done");
  const high = `/code-review high worktree-checkout${LOAD_FIRST}ponytail:ponytail-review.${SECURITY} Report to: lead-shop\n\nbrief`;
  const medium = "/code-review medium worktree-checkout Report to: lead-shop\n\nbrief";
  const woken = await plan("shop.reviewer-review-checkout", [lead, rv], { message: "re-review" }, { promptOf: () => high });
  expect(woken.argv[8]).toBe(`re-review\nReport to: lead-shop${SECURITY}`);
  expect(woken.argv[8]).not.toContain(LOAD_FIRST.trim());
  expect((await plan("shop.reviewer-review-checkout", [lead, rv], {}, { promptOf: () => medium })).argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop`);
});

test("a woken Reviewer carries the security hold sentence unless its first prompt was read and lacks it: an unreadable prompt fails closed", async () => {
  const rv = stopped("shop.reviewer-review-checkout", "rv-sid", REPO, "done");
  const unreadable = await plan("shop.reviewer-review-checkout", [lead, rv], {}, { promptOf: () => null });
  expect(unreadable.argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop${SECURITY}`);
  expect(unreadable.argv[8]).not.toContain(LOAD_FIRST.trim());
  const noLine = await plan("shop.reviewer-review-checkout", [lead, rv], {}, { promptOf: () => "/code-review medium worktree-checkout" }); // read, and no hold in it
  expect(noLine.argv[8]).not.toContain(SECURITY);
  const textless = firstPrompt('{"type":"user","message":{"role":"user"}}');
  expect((await plan("shop.reviewer-review-checkout", [lead, rv], {}, { promptOf: () => textless })).argv[8]).toContain(SECURITY.trim());
  // Only a Reviewer is held at APPROVED: an unreadable prompt adds nothing for a dev or a lead.
  const dev = await plan("shop.backend-dev-checkout", [lead, stopped("shop.backend-dev-checkout", "d", wt("checkout"))], {}, { promptOf: () => null });
  expect(dev.argv[8]).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop`);
});

test("firstPrompt reads the text of the first user line, whether the content is a string or blocks", () => {
  const user = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } });
  const meta = JSON.stringify({ type: "agent-name", agentName: "x" });
  expect(firstPrompt([meta, user("/cmd Report to: pm-x\n\nbrief"), user("second")].join("\n"))).toBe("/cmd Report to: pm-x\n\nbrief");
  expect(firstPrompt([meta, user([{ type: "text", text: "one " }, { type: "text", text: "two" }])].join("\n"))).toBe("one two");
  expect(firstPrompt(`${meta}\n{cut`)).toBeNull();
  // A code Reviewer's transcript opens with the isMeta caveat line the forked /code-review writes; the hire prompt is the second user line.
  const caveat = JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>" } });
  expect(firstPrompt([meta, caveat, user("/code-review high worktree-x Report to: lead-shop\n\nbrief")].join("\n"))).toBe("/code-review high worktree-x Report to: lead-shop\n\nbrief");
  expect(firstPrompt(caveat)).toBeNull();
  expect(firstPrompt('{"type":"user","message":{"role":"user"}}')).toBeNull(); // a user line with no text is no prompt: the fail-closed rule must see null
});

test("of several ended sessions of one name the newest is resumed", async () => {
  const list = [lead, stopped("shop.backend-dev-checkout", "old", wt("checkout"), "done", { startedAt: 10 }), stopped("shop.backend-dev-checkout", "new", wt("checkout"), "failed", { startedAt: 90 }), stopped("shop.backend-dev-checkout", "mid", wt("checkout"), "done", { startedAt: 50 })];
  expect((await plan("shop.backend-dev-checkout", list)).sessionId).toBe("new");
});

test("a hire let go (gone from the listing, its transcript left) is refused with the way on; so is one whose worktree is gone", async () => {
  const home = tmp("f1rm-wake-home-");
  const cwd = wt("checkout");
  const file = join(home, ".claude", "projects", folder(cwd), "letgo-sid.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [{ type: "agent-name", agentName: "shop.backend-dev-checkout" }, { type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } }, { type: "system", cwd }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, new Date(NOW - 60_000), new Date(NOW - 60_000));
  const err = await failure(plan("shop.backend-dev-checkout", [lead], {}, { home }));
  expect(err?.message).toBe("shop.backend-dev-checkout was let go; hire a new one");
  const noTree = await failure(plan("shop.backend-dev-checkout", [lead, stopped("shop.backend-dev-checkout", "dev-sid-1", cwd)], {}, { exists: (p) => p !== cwd }));
  expect(noTree?.message).toBe("shop.backend-dev-checkout was let go; hire a new one");
});

test("a name no one has, a session of another project, and a name that is no hire's are refused", async () => {
  expect((await failure(plan("shop.backend-dev-nope", [lead])))?.message).toContain("no hire named shop.backend-dev-nope in this project");
  const other = stopped("blog.backend-dev-x", "blog-sid", wt("x", "/code/blog"));
  const err = await failure(plan("blog.backend-dev-x", [lead, other]));
  expect(err?.message).toContain("belongs to another project");
  expect((await failure(plan("blog-sid", [lead, other])))?.message).toContain("belongs to another project");
  const pm = entry("pm-shop", "pm-sid", REPO, { state: "done" });
  expect((await failure(plan("pm-shop", [lead, pm])))?.message).toContain("is not a hire");
});

test("a hire with a live session is refused whichever of its ids is given: message it instead", async () => {
  const live = running("shop.backend-dev-checkout", "live-sid", wt("checkout"));
  const old = stopped("shop.backend-dev-checkout", "old-sid", wt("checkout"), "done");
  for (const target of ["shop.backend-dev-checkout", "live-sid", "old-sid"]) {
    const err = await failure(plan(target, [lead, old, live]));
    expect([target, err?.message]).toEqual([target, "shop.backend-dev-checkout is live: message it instead"]);
  }
  // Done but its process still runs (idle): it is live too.
  const doneIdle = idle("shop.backend-dev-checkout", "idle-sid", wt("checkout"));
  expect((await failure(plan("shop.backend-dev-checkout", [lead, doneIdle])))?.message).toContain("is live");
});

test("a wake is held by no cap: a team with two working, 9 working on the machine and a third lead all wake; the lead's team, one specialist per task and the usage hold still refuse", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"), "blocked");
  const two = [running("shop.frontend-dev-a", "a", wt("a")), running("shop.designer-b", "b", wt("b"))];
  const crowd = Array.from({ length: 9 }, (_, i) => running(`other-${i}`, `o${i}`, `/elsewhere/${i}`));
  expect((await plan("shop.backend-dev-checkout", [lead, dev, ...two, ...crowd])).sessionId).toBe("dev-sid-1");
  const leads = [running("lead-a", "la", REPO), running("lead-b", "lb", REPO)];
  expect((await plan("lead-shop", [stopped("lead-shop", "ls", REPO, "done"), ...leads])).sessionId).toBe("ls");
  // A member needs its lead running, and no second session may work its task, --override or not.
  expect((await failure(plan("shop.backend-dev-checkout", [dev])))?.message).toContain("has no lead running");
  expect((await failure(plan("shop.backend-dev-checkout", [lead, dev, running("shop.backend-dev-other", "x", wt("checkout"))])))?.message).toContain("one specialist per task");
  expect((await failure(plan("shop.backend-dev-checkout", [dev], { override: true })))?.message).toContain("has no lead running");
  // The usage hold is a counted refusal; --override skips it.
  const home = usageHome(95, NOW);
  const held = await failure(plan("shop.backend-dev-checkout", [lead, dev], {}, { home }));
  expect(held).toBeInstanceOf(UsageHold);
  expect((held as HireRefused).working).toBe(1);
  expect((await plan("shop.backend-dev-checkout", [lead, dev], { override: true }, { home })).sessionId).toBe("dev-sid-1");
});

test("who may wake follows who may hire: the PM wakes leads, a lead its own team's members, a specialist nobody", () => {
  const t = (name: string) => hireName(name)!;
  expect(mayWake({ role: "pm", team: null }, t("lead-shop"))).toBe(true);
  expect(mayWake({ role: "pm", team: null }, t("shop.backend-dev-a"))).toBe(false);
  expect(mayWake({ role: "lead", team: "shop" }, t("shop.backend-dev-a"))).toBe(true);
  expect(mayWake({ role: "lead", team: "shop" }, t("shop.reviewer-review-a"))).toBe(true);
  expect(mayWake({ role: "lead", team: "shop" }, t("search.backend-dev-c"))).toBe(false);
  expect(mayWake({ role: "lead", team: "shop" }, t("lead-search"))).toBe(false);
  expect(mayWake({ role: "lead", team: "shop" }, t("lead-shop"))).toBe(false);
  for (const role of ["backend", "frontend", "designer", "reviewer", "researcher", null]) {
    expect([role, mayWake({ role, team: "shop" }, t("shop.backend-dev-a")), mayWake({ role, team: "shop" }, t("lead-shop"))]).toEqual([role, false, false]);
  }
});

test("a stopped simple dev (no team) is woken in its own worktree, reports to the PM, and two other live teams do not hold it, on pace or ahead of it", async () => {
  const solo = stopped("backend-dev-x", "solo-sid", wt("x"));
  const p = await plan("backend-dev-x", [solo]);
  expect(p.argv.slice(0, 9)).toEqual(["claude", "--bg", "--resume", "solo-sid", "--agent", "f1rm:backend-dev", "--name", "backend-dev-x", "resumed; continue your task\nReport to: pm-shop"]);
  expect(p.cwd).toBe(wt("x"));
  // Two other teams (a lead, another simple task) run: there is no team cap, so it wakes as a third.
  expect((await plan("backend-dev-x", [solo, lead, running("designer-y", "y", wt("y"))])).sessionId).toBe("solo-sid");
  // Ahead of the weekly pace nothing changes: it wakes beside a lead and another live simple task.
  const ahead = tmp("f1rm-wake-home-");
  mkdirSync(join(ahead, ".f1rm"), { recursive: true });
  writeFileSync(join(ahead, ".f1rm", "usage.json"), JSON.stringify({ sevenDay: { usedPct: 50, resetsAt: NOW / 1000 + 6 * 86400 }, readAt: 0 }));
  expect((await plan("backend-dev-x", [solo, lead, running("designer-y", "y", wt("y"))], {}, { home: ahead })).sessionId).toBe("solo-sid");
  // The Report to its first prompt named wins over the default.
  expect((await plan("backend-dev-x", [solo], {}, { promptOf: () => "/pstack:poteto-mode Report to: pm-other\n\nbrief" })).argv[8]).toBe("resumed; continue your task\nReport to: pm-other");
});

test("the PM wakes a simple dev as well as a lead; no lead wakes it, and a team's member is still its lead's", () => {
  const t = (name: string) => hireName(name)!;
  expect(mayWake({ role: "pm", team: null }, t("backend-dev-x"))).toBe(true);
  expect(mayWake({ role: "pm", team: null }, t("designer-x"))).toBe(true);
  expect(mayWake({ role: "pm", team: null }, t("shop.backend-dev-a"))).toBe(false);
  expect(mayWake({ role: "pm", team: null }, t("reviewer-review-x"))).toBe(false);
  expect(mayWake({ role: "lead", team: "shop" }, t("backend-dev-x"))).toBe(false);
  for (const role of ["backend", "designer", "reviewer", null]) expect([role, mayWake({ role, team: null }, t("backend-dev-x"))]).toEqual([role, false]);
});

// The real command, against a stub claude that lists a stopped hire and records how it is started.
function stub(list: Entry[], newId = "newnewne") {
  const bin = tmp("f1rm-wake-bin-");
  writeFileSync(join(bin, "agents.json"), JSON.stringify(list));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nif [ "$1" = agents ]; then cat "${bin}/agents.json"; exit 0; fi\nprintf '%s\\0' "$@" >> "${bin}/argv.log"\npwd -P >> "${bin}/cwd.log"\necho "backgrounded · ${newId}"\n`, { mode: 0o755 });
  return bin;
}
const CLI = join(import.meta.dir, "f1rm.ts");
function repoWith(task: string) {
  const repo = realpathSync(tmp("f1rm-wake-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  mkdirSync(wt(task, repo), { recursive: true });
  return repo;
}
const runIn = (home: string, bin: string, repo: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, "wake", ...args], { cwd: repo, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const run = (bin: string, repo: string, ...args: string[]) => runIn(tmp("f1rm-wake-home-"), bin, repo, ...args);

test("f1rm wake starts claude from the hire's worktree with the resume argv, and says which session it started", () => {
  const repo = repoWith("checkout");
  const bin = stub([
    running("lead-shop", "lead-sid", repo),
    stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout", repo)),
  ]);
  const r = run(bin, repo, "shop.backend-dev-checkout", "one more fix round", "--model", "haiku");
  expect([r.code, r.err]).toEqual([0, ""]);
  expect(r.out).toContain("shop.backend-dev-checkout");
  expect(r.out).toContain("dev-sid-1");
  const argv = Bun.file(join(bin, "argv.log")).text();
  return argv.then(async (text) => {
    expect(text.split("\0").slice(0, -1)).toEqual(["--bg", "--resume", "dev-sid-1", "--agent", "f1rm:backend-dev", "--name", "shop.backend-dev-checkout", "one more fix round\nReport to: lead-shop", "--settings", FULL, "--model", "haiku", "--effort", "high"]);
    expect((await Bun.file(join(bin, "cwd.log")).text()).trim()).toBe(wt("checkout", repo));
  });
});

test("f1rm wake under a usage hold waits, gives up with code 75 and the ask-nobody line, and starts nothing", async () => {
  const repo = repoWith("checkout");
  const bin = stub([
    running("lead-shop", "lead-sid", repo),
    stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout", repo)),
  ]);
  const r = runIn(usageHome(95, Date.now()), bin, repo, "shop.backend-dev-checkout");
  expect(r.code).toBe(75);
  expect(r.err).toContain("waiting for a slot: usage hold: 5-hour usage is 95%");
  expect(r.err).toContain("no slot yet: run the same command again. Ask nobody; it is not a decision for the user.");
  expect(r.err).not.toContain("--override");
  expect(await Bun.file(join(bin, "argv.log")).exists()).toBe(false);
  expect(run(bin, repo).err).toContain("usage: f1rm wake");
});

/** A fake clock for the wait: each sleep moves it on, and `onSleep` gets the count of sleeps so far (a test frees a slot there). */
function clock(onSleep: (n: number) => void = () => {}) {
  let t = 0, n = 0;
  const said: string[] = [];
  const wait: Wait = { sleep: async (ms) => { t += ms; onSleep(++n); }, now: () => t, total: 8 * 60_000, say: (line) => said.push(line) };
  return { wait, said, sleeps: () => n };
}

test("a wake refused by the usage hold polls, prints one waiting line, and plans the wake as soon as the hold lifts", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"), "blocked");
  const home = usageHome(95, NOW);
  const c = clock((n) => n === 2 && usageHome(50, NOW, home));
  const p = await planWakeWaiting({ target: "shop.backend-dev-checkout", cwd: REPO }, () => deps([lead, dev], { home }), c.wait);
  expect(p?.sessionId).toBe("dev-sid-1");
  expect(c.sleeps()).toBe(2);
  expect(c.said).toHaveLength(1);
  expect(c.said[0]).toStartWith("waiting for a slot: usage hold: 5-hour usage is 95%");
});

test("a wake that never gets a slot waits 8 minutes, says so at most once a minute, then gives up with the ask-nobody line", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"), "blocked");
  const home = usageHome(95, NOW);
  const c = clock();
  expect(await planWakeWaiting({ target: "shop.backend-dev-checkout", cwd: REPO }, () => deps([lead, dev], { home }), c.wait)).toBeNull();
  expect(c.sleeps()).toBe(24);
  expect(c.said.filter((l) => l.startsWith("waiting for a slot: usage hold")).length).toBe(9);
  expect(c.said.at(-1)).toBe(NO_SLOT);
});

test("a wake refused for anything but a counted wait is immediate: one specialist per task, a missing lead, a paused project", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"), "blocked");
  const crowd = Array.from({ length: 9 }, (_, i) => running(`other-${i}`, `o${i}`, `/elsewhere/${i}`));
  for (const [list, why] of [
    [[lead, dev, ...crowd, running("shop.backend-dev-other", "x", wt("checkout"))], "one specialist per task"],
    [[dev, ...crowd], "has no lead running"],
  ] as const) {
    const c = clock();
    const err = await failure(planWakeWaiting({ target: "shop.backend-dev-checkout", cwd: REPO }, () => deps([...list]), c.wait));
    expect([why, err?.message.includes(why), c.sleeps(), c.said]).toEqual([why, true, 0, []]);
  }
  const home = tmp("f1rm-wake-home-");
  writePaused(pausedFile(pausedDirOf(home), REPO), { by: "manual", at: NOW, why: "lunch" });
  const c = clock();
  expect((await failure(planWakeWaiting({ target: "shop.backend-dev-checkout", cwd: REPO }, () => deps([lead, dev], { home }), c.wait)))?.message).toContain("is paused");
  expect(c.sleeps()).toBe(0);
});
