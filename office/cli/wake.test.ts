// Seam: `f1rm wake`. planWake against an injected `claude agents --json` (live and --all), a temp HOME's transcripts and an injected clock; the real command against a stub `claude`.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HireRefused, LOAD_FIRST, projectFolder as folder } from "./hire.ts";
import { hireName } from "./letgo.ts";
import { DEFAULT_NOTE, firstPrompt, lastModel, mayWake, parseWakeArgs, planWake } from "./wake.ts";

setDefaultTimeout(30_000);
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

const lead = running("lead-shop", "lead-sid", REPO);

test("a stopped member is resumed in the background with its agent, its name and its own worktree, and told where to report", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const p = await plan("shop.backend-dev-checkout", [lead, dev], { message: "fix round 2: see the review" });
  expect(p.argv).toEqual([
    "claude", "--bg", "--resume", "dev-sid-1", "--agent", "f1rm:backend-dev", "--name", "shop.backend-dev-checkout",
    "fix round 2: see the review\nReport to: lead-shop",
  ]);
  expect(p.cwd).toBe(wt("checkout"));
  expect([p.name, p.sessionId]).toEqual(["shop.backend-dev-checkout", "dev-sid-1"]);
});

test("without a message the note says the hire was resumed; the sentence that names the skills to load is never in it", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"));
  const p = await plan("shop.backend-dev-checkout", [lead, dev]);
  expect(p.argv.at(-1)).toBe(`${DEFAULT_NOTE}\nReport to: lead-shop`);
  expect(DEFAULT_NOTE).toBe("resumed; continue your task");
  expect(p.argv.join(" ")).not.toContain(LOAD_FIRST.trim());
});

test("a hire is found by its name, its session id or its short id, and flags after the message go to claude as given", async () => {
  const dev = stopped("shop.designer-landing", "abcd1234-0000", wt("landing"), "done");
  for (const target of ["shop.designer-landing", "abcd1234-0000", "abcd1234"]) {
    const p = await plan(target, [lead, dev], { extra: ["--model", "haiku"] });
    expect([target, p.argv.slice(0, 8), p.argv.slice(-2)]).toEqual([target, ["claude", "--bg", "--resume", "abcd1234-0000", "--agent", "f1rm:designer", "--name", "shop.designer-landing"], ["--model", "haiku"]]);
  }
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
  expect(given.argv.slice(-2)).toEqual(["--model", "opus"]);
  expect((await plan("shop.backend-dev-checkout", [lead, dev])).argv).not.toContain("--model"); // no transcript to read
  // The `--model=<x>` spelling is a model too: the old one is not appended after it.
  const equals = await plan("shop.backend-dev-checkout", [lead, dev], { extra: ["--model=opus"] }, { modelOf });
  expect(equals.argv.slice(-1)).toEqual(["--model=opus"]);
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

test("--override is read wherever it stands before the claude flags, and what follows the first flag goes to claude as given", () => {
  expect(parseWakeArgs(["lead-shop"])).toEqual({ target: "lead-shop", message: undefined, override: false, extra: [] });
  expect(parseWakeArgs(["--override", "lead-shop", "go"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: [] });
  expect(parseWakeArgs(["lead-shop", "--override", "go", "--model", "opus"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: ["--model", "opus"] });
  expect(parseWakeArgs(["lead-shop", "go", "--override"])).toEqual({ target: "lead-shop", message: "go", override: true, extra: [] });
  expect(parseWakeArgs(["lead-shop", "--model", "opus", "--override"])).toEqual({ target: "lead-shop", message: undefined, override: false, extra: ["--model", "opus", "--override"] });
});

test("firstPrompt reads the text of the first user line, whether the content is a string or blocks", () => {
  const user = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } });
  const meta = JSON.stringify({ type: "agent-name", agentName: "x" });
  expect(firstPrompt([meta, user("/cmd Report to: pm-x\n\nbrief"), user("second")].join("\n"))).toBe("/cmd Report to: pm-x\n\nbrief");
  expect(firstPrompt([meta, user([{ type: "text", text: "one " }, { type: "text", text: "two" }])].join("\n"))).toBe("one two");
  expect(firstPrompt(`${meta}\n{cut`)).toBeNull();
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

test("the wake counts against the caps like a hire: the team's two working, the machine's thirty, the lead's team, one specialist per task", async () => {
  const dev = stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout"), "blocked");
  const two = [running("shop.frontend-dev-a", "a", wt("a")), running("shop.designer-b", "b", wt("b"))];
  const teamFull = await failure(plan("shop.backend-dev-checkout", [lead, dev, ...two]));
  expect(teamFull).toBeInstanceOf(HireRefused);
  expect(teamFull?.message).toBe("team shop already has 2 working (the cap is 2 per team).");
  // The blocked session being woken is not counted against its own team.
  expect((await plan("shop.backend-dev-checkout", [lead, dev, two[0]])).sessionId).toBe("dev-sid-1");
  // Members that ended their turn (state working, status idle) leave their slots free.
  expect((await plan("shop.backend-dev-checkout", [lead, dev, idle("shop.frontend-dev-a", "a", wt("a")), idle("shop.designer-b", "b", wt("b"))])).sessionId).toBe("dev-sid-1");
  const crowd = Array.from({ length: 29 }, (_, i) => running(`other-${i}`, `o${i}`, `/elsewhere/${i}`));
  const machineFull = await failure(plan("shop.backend-dev-checkout", [lead, dev, ...crowd]));
  expect(machineFull).toBeInstanceOf(HireRefused);
  expect(machineFull?.message).toBe("30 hires are already working (the cap is 30).");
  // A woken lead fills a team slot of the project: two leads already run.
  const leads = [running("lead-a", "la", REPO), running("lead-b", "lb", REPO)];
  expect((await failure(plan("lead-shop", [stopped("lead-shop", "ls", REPO, "done"), ...leads])))?.message).toBe("this project already has 2 teams (the cap is 2).");
  // A member needs its lead running, and no second session may work its task.
  expect((await failure(plan("shop.backend-dev-checkout", [dev])))?.message).toContain("has no lead running");
  expect((await failure(plan("shop.backend-dev-checkout", [lead, dev, running("shop.backend-dev-other", "x", wt("checkout"))])))?.message).toContain("one specialist per task");
  // --override skips the caps and nothing else.
  expect((await plan("shop.backend-dev-checkout", [lead, dev, ...two], { override: true })).sessionId).toBe("dev-sid-1");
  expect((await failure(plan("shop.backend-dev-checkout", [dev], { override: true })))?.message).toContain("has no lead running");
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
const run = (bin: string, repo: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, "wake", ...args], { cwd: repo, env: { ...process.env, HOME: tmp("f1rm-wake-home-"), PATH: `${bin}:${process.env.PATH}` } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

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
    expect(text.split("\0").slice(0, -1)).toEqual(["--bg", "--resume", "dev-sid-1", "--agent", "f1rm:backend-dev", "--name", "shop.backend-dev-checkout", "one more fix round\nReport to: lead-shop", "--model", "haiku"]);
    expect((await Bun.file(join(bin, "cwd.log")).text()).trim()).toBe(wt("checkout", repo));
  });
});

test("f1rm wake that a cap refuses says so, tells the hire not to wake, and starts nothing", async () => {
  const repo = repoWith("checkout");
  const bin = stub([
    running("lead-shop", "lead-sid", repo),
    stopped("shop.backend-dev-checkout", "dev-sid-1", wt("checkout", repo)),
    running("shop.frontend-dev-a", "a", wt("a", repo)),
    running("shop.designer-b", "b", wt("b", repo)),
  ]);
  const r = run(bin, repo, "shop.backend-dev-checkout");
  expect(r.code).toBe(1);
  expect(r.err).toContain("team shop already has 2 working (the cap is 2 per team)");
  expect(r.err).toContain("Do not wake");
  expect(await Bun.file(join(bin, "argv.log")).exists()).toBe(false);
  expect(run(bin, repo).err).toContain("usage: f1rm wake");
});
