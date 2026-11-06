import { expect, test } from "bun:test";
import { createScheduler, parentOf, stepArgv, type DecisionIssue, type Issue, type SchedulerDeps, type Started } from "./scheduler.ts";

const REPO = "/r/app";
const ME = "owner";
const spec = (number: number, over: Partial<Issue> = {}): Issue => ({ number, title: `Issue ${number}`, author: ME, parent: null, subIssues: 0, subDone: 0, blockedBy: 0, pr: false, ...over });
const ticket = (number: number, of: number, over: Partial<Issue> = {}): Issue => spec(number, { parent: of, ...over });

function harness(issues: Issue[], over: Partial<SchedulerDeps> = {}, stored: Started = {}) {
  const started: string[] = [];
  const told: string[] = [];
  const resolved: string[] = [];
  const opened: string[] = [];
  const saved: Record<string, Started> = { [REPO]: stored };
  const labels = new Map<number, string | null>();
  const d: SchedulerDeps = {
    now: () => 1_000,
    owner: async () => ME,
    ready: async () => issues,
    labeledBy: async (_repo, n) => (labels.has(n) ? labels.get(n)! : ME),
    start: async (repo, step, n, round) => void started.push(`${repo} ${step} #${n}${round > 1 ? ` round ${round}` : ""}`),
    held: () => false,
    paused: () => false,
    live: async () => [],
    store: { load: (repo) => structuredClone(saved[repo] ?? {}), save: (repo, s) => void (saved[repo] = s) },
    resting: () => false,
    decisions: async () => [],
    notify: (title, text) => void told.push(`${title}: ${text}`),
    resolve: async (repo, n, spec, answer) => void resolved.push(`${repo} #${n} (spec ${spec}): ${answer}`),
    open: async (repo, title, body) => void opened.push(`${repo} ${title}\n${body}`),
    tickets: async () => [],
    costs: () => ({}),
    drop: async () => {},
    approve: async () => {},
    ...over,
  };
  return { s: createScheduler(d), started, labels, told, resolved, opened, saved };
}

test("a spec labelled ready by its owner starts one tickets step, and no second one while it runs", async () => {
  const { s, started } = harness([spec(7)], { live: async () => ["tickets-7"] });
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} tickets #7`]);
});

test("a ticket (a sub-issue), a spec that already has tickets and a pull request start nothing", async () => {
  const { s, started } = harness([ticket(1, 9), spec(2, { subIssues: 3 }), spec(3, { pr: true })]);
  await s.tick([REPO]);
  expect(started).toEqual([]);
});

test("only the user's own account steers: another author or another labeller starts nothing", async () => {
  const { s, started, labels } = harness([spec(4, { author: "stranger" }), spec(5)]);
  labels.set(5, "stranger");
  await s.tick([REPO]);
  expect(started).toEqual([]);
});

test("a label the owner adds later is seen on the next tick", async () => {
  const { s, started, labels } = harness([spec(5)]);
  labels.set(5, null);
  await s.tick([REPO]);
  labels.set(5, ME);
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} tickets #5`]);
});

test("nothing starts for a paused project, under a usage hold, just after a sleep, or when gh can't say who the owner is", async () => {
  for (const over of [{ paused: () => true }, { held: () => true }, { resting: () => true }, { owner: async () => null }] satisfies Partial<SchedulerDeps>[]) {
    const { s, started } = harness([spec(7)], over);
    await s.tick([REPO]);
    expect(started).toEqual([]);
  }
});

test("a start that fails is not recorded, so the next tick tries again", async () => {
  let fail = true;
  const tries: number[] = [];
  const { s } = harness([spec(9)], { live: async () => ["tickets-9"], start: async (_r, _s, n) => (tries.push(n), fail ? Promise.reject(new Error("refused")) : undefined) });
  await s.tick([REPO]);
  fail = false;
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(tries).toEqual([9, 9]);
});

test("a repo gh can't read is skipped and the others still run", async () => {
  const started: string[] = [];
  const { s } = harness([spec(7)], {
    ready: async (repo) => (repo === "/r/broken" ? null : [spec(7)]),
    start: async (repo, step, n) => void started.push(`${repo} ${step} #${n}`),
  });
  await s.tick(["/r/broken", REPO]);
  expect(started).toEqual([`${REPO} tickets #7`]);
});

test("the tickets step starts as a named office step whose first command is to-tickets on the spec", () => {
  const argv = stepArgv("tickets", 81);
  expect(argv.slice(0, 6)).toEqual(["claude", "--bg", "--agent", "f1rm:step", "--name", "tickets-81"]);
  expect(argv[6]).toStartWith("/mattpocock-skills:to-tickets #81");
  expect(argv[6]).toContain("without asking");
  expect(argv.join(" ")).toContain("--effort medium");
  expect(argv).not.toContain("--worktree");
});

const TICKETED = { "tickets-7": { at: 1 } };

test("a spec the office ticketed starts one implement step once a ticket is unblocked, and no second one", async () => {
  let ticks = 0;
  const { s, started } = harness([spec(7, { subIssues: 2 }), ticket(8, 7), ticket(9, 7, { blockedBy: 1 })], { live: async () => (ticks++ ? ["implement-7"] : []) }, TICKETED);
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} implement #7`]);
});

test("the implement step waits while every open ticket has an open blocker, while the tickets step still runs, or for a ticket by another account", async () => {
  for (const [issues, live] of [
    [[spec(7, { subIssues: 1 }), ticket(9, 7, { blockedBy: 1 })], []],
    [[spec(7, { subIssues: 1 }), ticket(8, 7)], ["tickets-7"]],
    [[spec(7, { subIssues: 1 }), ticket(8, 7, { author: "stranger" })], []],
  ] as [Issue[], string[]][]) {
    const { s, started } = harness(issues, { live: async () => live }, TICKETED);
    await s.tick([REPO]);
    expect(started).toEqual([]);
  }
});

test("a spec whose tickets the office did not publish is left to the user, and nothing starts when the live sessions can't be listed", async () => {
  const one = harness([spec(7, { subIssues: 1 }), ticket(8, 7)]);
  await one.s.tick([REPO]);
  expect(one.started).toEqual([]);
  const two = harness([spec(7, { subIssues: 1 }), ticket(8, 7), spec(5)], { live: async () => null }, TICKETED);
  await two.s.tick([REPO]);
  expect(two.started).toEqual([]);
});

test("the implement step builds the spec on spec-<n> with interns in their own worktrees, merging one at a time, and leaves main to the close step", () => {
  const argv = stepArgv("implement", 7);
  expect(argv.slice(0, 6)).toEqual(["claude", "--bg", "--agent", "f1rm:step", "--name", "implement-7"]);
  const prompt = argv[6];
  expect(prompt).toStartWith("/mattpocock-skills:implement-spec #7");
  for (const s of ["spec-7", "checkout -b ticket-<number> spec-7", "fix every finding", "ticket-<number>", 'isolation: "worktree"', "one at a time", "/usr/bin/git", "no pull request", "main"]) expect(prompt).toContain(s);
});

/** Ten minutes before the tests' clock: past the grace a just-started step gets. */
const OLD = -10 * 60_000;
const BUILT = { "tickets-7": { at: OLD }, "implement-7": { at: OLD } };

test("once every ticket of a spec the office built is closed and its implement step ended, one close step starts", async () => {
  let ticks = 0;
  const { s, started } = harness([spec(7, { subIssues: 2, subDone: 2 })], { live: async () => (ticks++ ? ["close-7"] : []) }, BUILT);
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} close #7`]);
});

test("the close step waits while the implement step runs, and never starts for a spec the office did not build", async () => {
  const running = harness([spec(7, { subIssues: 2, subDone: 2 })], { live: async () => ["implement-7"] }, BUILT);
  await running.s.tick([REPO]);
  const byHand = harness([spec(7, { subIssues: 2, subDone: 2 })], {}, { "tickets-7": { at: 1 } });
  await byHand.s.tick([REPO]);
  expect([...running.started, ...byHand.started]).toEqual([]);
});

test("a criterion the close step turned into a ticket gets one more round: implement, then a last close, and nothing after", async () => {
  const closed = { ...BUILT, "close-7": { at: 3 } };
  const more = harness([spec(7, { subIssues: 3, subDone: 2 }), ticket(10, 7)], {}, closed);
  await more.s.tick([REPO]);
  expect(more.started).toEqual([`${REPO} implement #7 round 2`]);
  const last = harness([spec(7, { subIssues: 3, subDone: 3 })], {}, { ...closed, "implement-7-2": { at: 4 } });
  await last.s.tick([REPO]);
  expect(last.started).toEqual([`${REPO} close #7 round 2`]);
  const after = harness([spec(7, { subIssues: 4, subDone: 3 }), ticket(11, 7)], {}, { ...closed, "implement-7-2": { at: 4 }, "close-7-2": { at: 5 } });
  await after.s.tick([REPO]);
  expect(after.started).toEqual([]);
});

test("the close step checks the criteria on spec-<n>, lands it with f1rm merge, pushes, cleans the branches and closes the spec; its last round opens no ticket", () => {
  const first = stepArgv("close", 7, 1);
  expect(first.slice(0, 6)).toEqual(["claude", "--bg", "--agent", "f1rm:step", "--name", "close-7"]);
  for (const s of ["acceptance criteria", "spec-7", "--parent 7", "f1rm merge spec-7", "f1rm push", "git branch -d spec-7", "worktree-agent-", "gh issue close 7"]) expect(first[6]).toContain(s);
  const last = stepArgv("close", 7, 2);
  expect(last[5]).toBe("close-7-2");
  expect(last[6]).toContain("last round");
  expect(last[6]).toEndWith("This step is close-7-2.");
  expect(last[6]).not.toContain("--parent 7");
  expect(stepArgv("implement", 7, 2)[5]).toBe("implement-7-2");
});

const HOUR = 3_600_000;
const decision = (number: number, over: Partial<DecisionIssue> = {}): DecisionIssue => ({
  number,
  author: ME,
  at: 1_000,
  url: `https://github.com/o/app/issues/${number}`,
  body: "<!-- f1rm:decision risk=low step=implement-7 spec=7 recommended=2 -->\nKeep the old API?\n\n1. Keep it\n2. Drop it, nothing uses it\n",
  ...over,
});

test("a decision ticket by the owner shows with its question, options, recommendation and risk, and raises one notification", async () => {
  const { s, told } = harness([], { decisions: async () => [decision(12), decision(13, { author: "stranger" })] });
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(s.decisions()).toEqual([
    { id: `${REPO}#12`, repo: REPO, number: 12, url: "https://github.com/o/app/issues/12", question: "Keep the old API?", options: ["Keep it", "Drop it, nothing uses it"], recommended: 1, restart: null, drop: null, ready: null, risk: "low", step: "implement-7", spec: 7, at: 1_000 },
  ]);
  expect(told).toEqual(["f1rm: app needs a decision: Keep the old API?"]);
});

test("after 4 hours a low-risk decision takes its recommendation and its asking step starts again; a high-risk one waits, and nothing is answered while paused", async () => {
  let now = 1_000 + 4 * HOUR - 1;
  const high = decision(14, { body: "<!-- f1rm:decision risk=high step=close-9 spec=9 recommended=1 -->\nPublish the launch post?\n\n1. Yes\n2. No\n" });
  const issues = [spec(7, { subIssues: 1 }), ticket(8, 7)];
  const built = { "tickets-7": { at: 1 }, "implement-7": { at: 2 } };
  const { s, resolved, started } = harness(issues, { now: () => now, decisions: async () => [decision(12), high] }, built);
  await s.tick([REPO]);
  expect(resolved).toEqual([]);
  now += 2;
  await s.tick([REPO]);
  expect(resolved).toEqual([`${REPO} #12 (spec 7): Drop it, nothing uses it (no answer in 4 hours: the recommendation)`]);
  expect(started).toEqual([`${REPO} implement #7`]);
  const paused = harness([], { now: () => 1_000 + 5 * HOUR, paused: () => true, decisions: async () => [decision(12)] });
  await paused.s.tick([REPO]);
  expect(paused.resolved).toEqual([]);
});

test("the user's answer is written as the option they picked, and only for a decision the tray shows", async () => {
  const { s, resolved } = harness([], { decisions: async () => [decision(12)] }, { "implement-7": { at: 2 } });
  await s.tick([REPO]);
  expect(await s.answer(`${REPO}#12`, 0)).toEqual({ ok: true });
  expect(resolved).toEqual([`${REPO} #12 (spec 7): Keep it`]);
  expect(s.decisions()).toEqual([]);
  expect(await s.answer(`${REPO}#12`, 0)).toEqual({ ok: false, error: "That decision is no longer open." });
  expect(await s.answer(`${REPO}#99`, 0)).toEqual({ ok: false, error: "That decision is no longer open." });
});

test("an option the ticket does not have, or a write gh refuses, answers nothing", async () => {
  const { s } = harness([], { decisions: async () => [decision(12)], resolve: async () => Promise.reject(new Error("gh: HTTP 403")) });
  await s.tick([REPO]);
  expect(await s.answer(`${REPO}#12`, 5)).toEqual({ ok: false, error: "That decision has no such option." });
  expect(await s.answer(`${REPO}#12`, 1)).toEqual({ ok: false, error: "GitHub refused the answer: gh: HTTP 403" });
  expect(s.decisions().map((x) => x.number)).toEqual([12]);
});

test("an answer given while a tick is reading GitHub is kept: that tick's save does not bring the asking step's record back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slow = false;
  const issues = [spec(7, { subIssues: 1 }), ticket(8, 7)];
  const { s, started } = harness([], {
    decisions: async () => [decision(12)],
    ready: async () => (slow ? (await gate, [...issues, spec(5)]) : issues),
  }, { "tickets-7": { at: 1 }, "implement-7": { at: 2 } });
  await s.tick([REPO]);
  slow = true;
  const ticking = s.tick([REPO]); // starts tickets-5 and saves after the answer below
  const answering = s.answer(`${REPO}#12`, 1);
  release();
  await ticking;
  expect(await answering).toEqual({ ok: true });
  slow = false;
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} tickets #5`, `${REPO} implement #7`]);
});

test("a decision ticket someone else labelled is not shown or answered, and a repo gh can't read keeps its tickets in the tray", async () => {
  const { s, labels, told, resolved } = harness([], { now: () => 1_000 + 5 * HOUR, decisions: async () => [decision(12)] });
  labels.set(12, "stranger");
  await s.tick([REPO]);
  expect([s.decisions(), told, resolved]).toEqual([[], [], []]);
  let fails = false;
  const kept = harness([], { decisions: async () => (fails ? null : [decision(13, { body: decision(13).body.replace("risk=low", "risk=high") })]) });
  await kept.s.tick([REPO]);
  fails = true;
  await kept.s.tick([REPO]);
  expect(kept.s.decisions().map((x) => x.number)).toEqual([13]);
});

test("a tickets step that ended without publishing tickets starts once more; a second such end opens one decision ticket and starts nothing", async () => {
  let now = 0;
  const { s, started, opened } = harness([spec(7)], { now: () => now }, { "tickets-7": { at: OLD } });
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} tickets #7`]);
  await s.tick([REPO]); // inside the grace of the restart: not judged yet
  expect(opened).toEqual([]);
  now += 10 * 60_000;
  await s.tick([REPO]);
  await s.tick([REPO]);
  expect(started).toEqual([`${REPO} tickets #7`]);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toStartWith(`${REPO} tickets-7 ended twice without moving spec #7 on`);
  expect(opened[0]).toContain("<!-- f1rm:decision risk=high step=tickets-7 spec=7 recommended=1 restart=1 drop=2 -->");
});

test("an implement step that ended with an unblocked ticket left, and a close step that ended with its spec still open, each start once more", async () => {
  const implement = harness([spec(7, { subIssues: 2, subDone: 1 }), ticket(8, 7)], {}, BUILT);
  await implement.s.tick([REPO]);
  const close = harness([spec(7, { subIssues: 2, subDone: 2 })], {}, { ...BUILT, "close-7": { at: OLD } });
  await close.s.tick([REPO]);
  expect([...implement.started, ...close.started]).toEqual([`${REPO} implement #7`, `${REPO} close #7`]);
});

test("a step waiting on a decision ticket it opened has not failed: nothing restarts it until the ticket is answered", async () => {
  const asking = decision(12, { body: "<!-- f1rm:decision risk=high step=implement-7 spec=7 -->\nWhich database?\n\n1. Postgres\n2. SQLite\n" });
  const { s, started, opened } = harness([spec(7, { subIssues: 2, subDone: 1 }), ticket(8, 7)], { decisions: async () => [asking] }, { ...BUILT, "implement-7": { at: 2, tries: 2 } });
  await s.tick([REPO]);
  expect([started, opened]).toEqual([[], []]);
});

test("answering the failure ticket with Retry it starts the step again; Leave it to me starts nothing", async () => {
  const failed = (n: number) => decision(n, { body: "<!-- f1rm:decision risk=high step=tickets-7 spec=7 recommended=1 restart=1 -->\ntickets-7 ended twice without moving spec #7 on.\n\n1. Retry it\n2. Leave it to me\n" });
  const stuck = { "tickets-7": { at: 1, tries: 2, asked: true } };
  const retry = harness([spec(7)], { decisions: async () => [failed(20)] }, stuck);
  await retry.s.tick([REPO]);
  await retry.s.answer(`${REPO}#20`, 0);
  await retry.s.tick([REPO]);
  const leave = harness([spec(7)], { decisions: async () => [failed(21)] }, stuck);
  await leave.s.tick([REPO]);
  await leave.s.answer(`${REPO}#21`, 1);
  await leave.s.tick([REPO]);
  expect([retry.started, leave.started, leave.opened]).toEqual([[`${REPO} tickets #7`], [], []]);
});

test("a step started less than 3 minutes ago is not judged: claude may not list it yet", async () => {
  const { s, started } = harness([spec(7)], { now: () => 1_000 + 3 * 60_000 - 1 }, { "tickets-7": { at: 1_000 } });
  await s.tick([REPO]);
  expect(started).toEqual([]);
});

test("an implement step that closed a ticket since it started is started again without counting a failure, and one that left only blocked tickets has failed", async () => {
  const progress = harness([spec(7, { subIssues: 3, subDone: 2 }), ticket(9, 7)], {}, { ...BUILT, "implement-7": { at: OLD, tries: 2, done: 1 } });
  await progress.s.tick([REPO]);
  expect([progress.started, progress.opened]).toEqual([[`${REPO} implement #7`], []]);
  const blocked = harness([spec(7, { subIssues: 2, subDone: 1 }), ticket(9, 7, { blockedBy: 1 })], {}, { ...BUILT, "implement-7": { at: OLD, tries: 2, done: 1 } });
  await blocked.s.tick([REPO]);
  expect(blocked.opened).toHaveLength(1);
});

test("a close step that fails twice asks once, offering to retry it, drop the spec or leave it; Drop closes the spec and starts nothing", async () => {
  const twice = harness([spec(7, { subIssues: 2, subDone: 2 })], {}, { ...BUILT, "close-7": { at: OLD, tries: 2 } });
  await twice.s.tick([REPO]);
  await twice.s.tick([REPO]);
  expect(twice.started).toEqual([]);
  expect(twice.opened).toHaveLength(1);
  expect(twice.opened[0]).toContain("restart=1 drop=2");
  expect(twice.opened[0]).toContain("1. Retry it\n2. Drop the spec\n3. Leave it to me");
  const dropped: string[] = [];
  const failure = decision(30, { body: twice.opened[0].slice(twice.opened[0].indexOf("\n") + 1) });
  const drop = harness([spec(7, { subIssues: 2, subDone: 2 })], { decisions: async () => [failure], drop: async (repo, n) => void dropped.push(`${repo} #${n}`) }, { ...BUILT, "close-7": { at: 3, tries: 2, asked: true } });
  await drop.s.tick([REPO]);
  expect(await drop.s.answer(`${REPO}#30`, 1)).toEqual({ ok: true });
  await drop.s.tick([REPO]);
  expect([dropped, drop.started]).toEqual([[`${REPO} #7`], []]);
});

test("a restart re-checks that the spec is still the user's: a label someone else added starts nothing", async () => {
  const { s, started, labels } = harness([spec(7)], {}, { "tickets-7": { at: OLD } });
  labels.set(7, "stranger");
  await s.tick([REPO]);
  expect(started).toEqual([]);
});

test("the implement step gives each intern its ticket's role skills in place of tdd, test-first with no role label, and a comment for an unknown one; the Founder roles only in a Founder project", () => {
  const founder = stepArgv("implement", 7, 1, true)[6];
  for (const s of ["in place of tdd", "role:designer → design-pipeline", "role:researcher → mattpocock-skills:research", "role:marketer → cro, anthropic-skills:content-creator, brandkit", "no role label → mattpocock-skills:tdd", "comment on the ticket naming the label"]) expect(founder).toContain(s);
  for (const s of ["role:lead", "role:reviewer", "role:frontend-dev", "role:backend-dev"]) expect(founder).not.toContain(s);
  const work = stepArgv("implement", 7)[6];
  expect(work).toContain("role:designer → design-pipeline");
  expect(work).not.toContain("role:marketer");
});

test("the tickets step labels each ticket that is not code with its role, the Founder roles only in a Founder project", () => {
  expect(stepArgv("tickets", 7, 1, true)[6]).toContain("(role:designer, role:researcher, role:marketer, role:seo-specialist, role:social-media, role:sales, role:strategist)");
  expect(stepArgv("tickets", 7)[6]).toContain("(role:designer, role:researcher)");
  expect(stepArgv("tickets", 7)[6]).toContain("a Boundary: line (the files it owns, so parallel interns never collide) and a Depends: line");
});

test("the whiteboard shows each live spec and its tickets from GitHub: the step at work, each ticket's state, role and cost, the spec's total and coordination share, and a ticket over its warning", async () => {
  const zero = { input: 0, cacheWrite: 0, cacheRead: 0 };
  const { s } = harness([spec(7, { title: "Spec: slugify titles", subIssues: 3, subDone: 1 }), ticket(9, 7, { title: "The slug command", blockedBy: 1 }), ticket(10, 7, { title: "Docs page" })], {
    live: async () => ["implement-7"],
    tickets: async () => [
      { number: 8, title: "slugify", state: "closed", blockedBy: 0, labels: [] },
      { number: 9, title: "The slug command", state: "open", blockedBy: 1, labels: ["size:s"] },
      { number: 10, title: "Docs page", state: "open", blockedBy: 0, labels: ["role:designer"] },
    ],
    costs: (_repo, sizes) => ({ 7: { coordination: { ...zero, output: 1_000 }, tickets: { 8: { ...zero, output: 20_000 }, 10: { ...zero, output: 1_000 } }, other: { ...zero, output: 0 }, total: 110_000, share: 0.05, warnings: sizes[8] ? [] : [8] } }),
  }, BUILT);
  await s.tick([REPO]);
  expect(s.boards()[REPO]).toEqual([
    { id: "#7", owner: "implement-7", status: "doing", branch: "spec-7", task: "Spec: slugify titles · 110k cost units, 5% coordination" },
    { id: "#8", owner: "intern", status: "done", branch: "ticket-8", task: "slugify · 100k cost units · over its warning" },
    { id: "#9", owner: "intern", status: "blocked", branch: "ticket-9", task: "The slug command" },
    { id: "#10", owner: "role:designer", status: "doing", branch: "ticket-10", task: "Docs page · 5k cost units" },
  ]);
});

test("a paused or usage-held project's wall still follows its issues, though no step starts", async () => {
  for (const over of [{ paused: () => true }, { held: () => true }] satisfies Partial<SchedulerDeps>[]) {
    const { s, started } = harness([spec(7, { title: "Spec: x" })], over);
    await s.tick([REPO]);
    expect([started, s.boards()[REPO]]).toEqual([[], [{ id: "#7", owner: "spec", status: "todo", branch: "spec-7", task: "Spec: x" }]]);
  }
});

test("a retro's proposal is a draft spec: Build it labels it ready, so the office builds it; Drop it closes it", async () => {
  const proposal = (n: number) => decision(n, { body: "<!-- f1rm:decision risk=high spec=40 recommended=1 ready=1 drop=2 -->\nBuild this change? Interns lost 2 turns to refused git; tell them the allowed form.\n\n1. Build it\n2. Drop it\n" });
  const approved: string[] = [], dropped: string[] = [];
  const deps = { approve: async (repo: string, n: number) => void approved.push(`${repo} #${n}`), drop: async (repo: string, n: number) => void dropped.push(`${repo} #${n}`) };
  const build = harness([], { decisions: async () => [proposal(41)], ...deps });
  await build.s.tick([REPO]);
  await build.s.answer(`${REPO}#41`, 0);
  const no = harness([], { decisions: async () => [proposal(42)], ...deps });
  await no.s.tick([REPO]);
  await no.s.answer(`${REPO}#42`, 1);
  expect([approved, dropped]).toEqual([[`${REPO} #40`], [`${REPO} #40`]]);
});

test("the close step ends with a retro, nobody asked: measured evidence, unfixed findings as needs-triage issues, at most 3 proposals as decision tickets, no file changed", () => {
  for (const round of [1, 2]) {
    const prompt = stepArgv("close", 7, round)[6];
    for (const s of ["retro", "nobody to ask", "f1rm cost", "refused", "needs-triage", "at most 3", "ready=1 drop=2", "1. Build it", "2. Drop it", "Change no file yourself"]) expect(prompt, s).toContain(s);
  }
});

test("a Build it that GitHub refuses answers nothing: the proposal stays in the tray", async () => {
  const proposal = decision(43, { body: "<!-- f1rm:decision risk=high spec=40 recommended=1 ready=1 drop=2 -->\nBuild this change?\n\n1. Build it\n2. Drop it\n" });
  const { s, resolved } = harness([], { decisions: async () => [proposal], approve: async () => Promise.reject(new Error("label not found")) });
  await s.tick([REPO]);
  expect(await s.answer(`${REPO}#43`, 0)).toEqual({ ok: false, error: "GitHub refused the answer: label not found" });
  expect([resolved, s.decisions().map((x) => x.number)]).toEqual([[], [43]]);
});

test("a ticket whose parent is only named in its text (## Parent #5, or Part of #5) is that spec's ticket, never a spec of its own", () => {
  expect(parentOf({ parent_issue_url: null, body: "## Parent\n\n#5\n\n## What to build\n..." })).toBe(5);
  expect(parentOf({ parent_issue_url: null, body: "Part of #12\n\nBuild it." })).toBe(12);
  expect(parentOf({ parent_issue_url: "https://api.github.com/repos/o/r/issues/7", body: "## Parent\n\n#5" })).toBe(7);
  expect(parentOf({ parent_issue_url: null, body: "A spec that mentions #5 in passing" })).toBeNull();
});

test("the tickets step links every ticket as a sub-issue and checks it, and links the spec's unlinked tickets instead of publishing them again", () => {
  const prompt = stepArgv("tickets", 7)[6];
  for (const s of ["sub-issue of #7", "--parent 7", "check that #7 lists them", "already exist", "link them"]) expect(prompt, s).toContain(s);
});
