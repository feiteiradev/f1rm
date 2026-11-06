import { expect, test } from "bun:test";
import { createScheduler, stepArgv, type Issue, type SchedulerDeps, type Started } from "./scheduler.ts";

const REPO = "/r/app";
const ME = "owner";
const spec = (number: number, over: Partial<Issue> = {}): Issue => ({ number, author: ME, parent: null, subIssues: 0, blockedBy: 0, pr: false, ...over });
const ticket = (number: number, of: number, over: Partial<Issue> = {}): Issue => spec(number, { parent: of, ...over });

function harness(issues: Issue[], over: Partial<SchedulerDeps> = {}, stored: Started = {}) {
  const started: string[] = [];
  const saved: Record<string, Started> = { [REPO]: stored };
  const labels = new Map<number, string | null>();
  const d: SchedulerDeps = {
    now: () => 1_000,
    owner: async () => ME,
    ready: async () => issues,
    labeledBy: async (_repo, n) => (labels.has(n) ? labels.get(n)! : ME),
    start: async (repo, step, n) => void started.push(`${repo} ${step} #${n}`),
    held: () => false,
    paused: () => false,
    live: async () => [],
    store: { load: (repo) => structuredClone(saved[repo] ?? {}), save: (repo, s) => void (saved[repo] = s) },
    resting: () => false,
    ...over,
  };
  return { s: createScheduler(d), started, labels };
}

test("a spec labelled ready by its owner starts one tickets step, and no second one on the next tick", async () => {
  const { s, started } = harness([spec(7)]);
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
  const { s } = harness([spec(9)], { start: async (_r, _s, n) => (tries.push(n), fail ? Promise.reject(new Error("refused")) : undefined) });
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
  const { s, started } = harness([spec(7, { subIssues: 2 }), ticket(8, 7), ticket(9, 7, { blockedBy: 1 })], {}, TICKETED);
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
  for (const s of ["spec-7", "ticket-<number>", 'isolation: "worktree"', "one at a time", "/usr/bin/git", "no pull request", "main"]) expect(prompt).toContain(s);
});
