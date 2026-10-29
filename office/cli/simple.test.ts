// The flat hire: `--simple` (the PM's one dev for a simple task), the leads' and the Reviewer's limits, `--level` on the devs, the dev's Review paragraph, and the cap that counts a simple task as a team.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSlots, planHire, type HireRequest, type LiveHires } from "./hire.ts";
import { letgo } from "./letgo.ts";

const REPO = "/code/shop";
const wt = (task: string) => join(REPO, ".claude", "worktrees", task);
const session = (name: string, cwd: string, state = "working", status?: "busy" | "idle"): LiveHires[number] => ({ name, state, cwd, ...(status && { status }) });
const machine = (sessions: LiveHires | null = []) => ({ backgroundSessions: async () => sessions, gitCommonDir: () => null });
const req = (over: Partial<HireRequest> = {}): HireRequest => ({ role: "backend-dev", task: "x", cwd: REPO, brief: "Task: x", reportTo: "pm-shop", ...over });
const plan = (over: Partial<HireRequest> = {}, sessions: LiveHires | null = []) => planHire(req(over), machine(sessions));
const promptOf = (argv: string[]) => argv[argv.indexOf("--worktree") + 2];
const LEAD = session("lead-checkout", REPO, "done");

test("--simple hires a dev, a designer or a researcher with no team: <role>-<task> in its own worktree, reporting to the PM", async () => {
  for (const role of ["frontend-dev", "backend-dev", "designer", "researcher"]) {
    const argv = await plan({ role, simple: true, name: `${role}-x` });
    expect(argv.slice(0, 8)).toEqual(["claude", "--bg", "--agent", `f1rm:${role}`, "--name", `${role}-x`, "--worktree", "x"]);
    expect(promptOf(argv)).toContain("Report to: pm-shop");
  }
  // a Founder role in a Founder project
  expect((await plan({ role: "marketer", simple: true, edition: "founder" }))[5]).toBe("marketer-x");
  await expect(plan({ role: "marketer", simple: true })).rejects.toThrow("Founder role");
});

test("--simple is refused with --team, for a lead and for a reviewer", async () => {
  await expect(plan({ simple: true, team: "checkout" }, [LEAD])).rejects.toThrow("--simple is for one dev, designer or researcher the PM hires with no team");
  await expect(plan({ role: "lead", task: "checkout", simple: true })).rejects.toThrow("--simple is for one dev");
  await expect(plan({ role: "reviewer", task: "review-x", simple: true, content: true })).rejects.toThrow("--simple is for one dev");
});

test("a lead's team is refused a frontend-dev or backend-dev; a designer, a researcher and a --content reviewer are still hired into it", async () => {
  for (const role of ["frontend-dev", "backend-dev"]) {
    await expect(plan({ role, team: "checkout" }, [LEAD])).rejects.toThrow("an owner runs implementer subagents, not a session per task; hire a designer, a researcher, or a --content reviewer");
  }
  for (const role of ["designer", "researcher"]) expect((await plan({ role, team: "checkout" }, [LEAD]))[5]).toBe(`checkout.${role}-x`);
  expect((await plan({ role: "reviewer", task: "review-x", team: "checkout", content: true }, [LEAD]))[5]).toBe("checkout.reviewer-review-x");
});

test("claude flags after the brief cannot change the hire's agent, name or worktree", async () => {
  for (const extra of [["--agent", "f1rm:backend-dev"], ["--agent=f1rm:lead"], ["--name", "a.b"], ["--name=x"], ["-n", "x"], ["--worktree", "w"], ["--model", "haiku", "--worktree=w"]]) {
    await expect(plan({ role: "designer", extra })).rejects.toThrow("is the hire's own");
  }
  expect(await plan({ role: "designer", extra: ["--allowedTools", "Bash", "--model", "haiku"] })).toContain("--allowedTools");
});

test("a reviewer is hired only with --content", async () => {
  await expect(plan({ role: "reviewer", task: "review-x", team: "checkout" }, [LEAD])).rejects.toThrow("a Reviewer reviews a branch with no code: hire it with --content");
  await expect(plan({ role: "reviewer", task: "review-x", level: "high", team: "checkout" }, [LEAD])).rejects.toThrow("--level is for the two devs");
});

test("--level low, medium or high sets the dev's own review; any other role, and any other value, is refused", async () => {
  for (const role of ["frontend-dev", "backend-dev"]) {
    for (const level of ["low", "medium", "high"]) expect(promptOf(await plan({ role, level }))).toContain(`at level ${level}`);
  }
  expect(promptOf(await plan())).toContain("at level medium");
  for (const role of ["designer", "researcher"]) await expect(plan({ role, level: "high" })).rejects.toThrow("--level is for the two devs");
  await expect(plan({ level: "max" })).rejects.toThrow('level "max" must be one of low, medium, high');
  await expect(plan({ role: "designer", content: true })).rejects.toThrow("--content is for the reviewer only");
});

test("the dev's prompt carries the Review: one fresh-context subagent, fixed once, NEEDS YOU on a second blocking round, the findings file, and the test-only rule", async () => {
  const text = promptOf(await plan({ level: "high", task: "merge-cmd", cwd: "/Users/x/dev/shop" }));
  expect(text).toContain("After your checks pass, run ONE review in a fresh context: start a general-purpose subagent with the Agent tool and tell it to run the code-review skill at level high on `git diff <base>...HEAD`");
  expect(text).toContain("and the security-review skill on that same diff");
  expect(text).toContain("Fix the blocking findings ONCE and run your checks again.");
  expect(text).toContain("Send the non-blocking findings to ~/.f1rm/kept/shop/findings.md as lines in its table format");
  expect(text).toContain("If a second review would still have blocking findings, run `f1rm report NEEDS merge-cmd` and send `NEEDS YOU merge-cmd` to your Report to session instead of fixing again.");
  expect(text).toContain("Implement inline and never delegate the implementation: the one subagent you start is this reviewer");
  expect(text).toContain("Your DONE states the review round count and the review level.");
  expect(text).toContain("Put at least one failing test in every task");
  expect(text).toContain("send `NEEDS YOU merge-cmd` to ask");
  // medium and low run no security-review; the paragraph sits before the brief
  const medium = promptOf(await plan({ brief: "BRIEF-TEXT" }));
  expect(medium).not.toContain("security-review");
  expect(medium.indexOf("run ONE review")).toBeLessThan(medium.indexOf("BRIEF-TEXT"));
  // only the two devs have it
  for (const role of ["designer", "researcher"]) expect(promptOf(await plan({ role }))).not.toContain("run ONE review");
});

test("the cap counts a simple task as a team of one: live leads and live simple tasks together make 2 teams, a third is refused, and --override, another repo and a team's member do not count", async () => {
  const solo = session("backend-dev-y", wt("y"));
  const ask = (live: LiveHires, over: Partial<Parameters<typeof checkSlots>[1]> = {}) =>
    checkSlots(live, { role: "backend-dev", name: "backend-dev-x", task: "x", cwd: REPO, ...over });
  const lead = (name: string) => ({ role: "lead", name, task: name.slice(5), cwd: REPO });
  // a lead and a simple task are two teams
  expect(() => ask([LEAD, solo])).toThrow("this project already has 2 teams (the cap is 2)");
  expect(() => checkSlots([LEAD, solo], lead("lead-cart"))).toThrow("this project already has 2 teams (the cap is 2)");
  expect(() => ask([solo, session("designer-z", wt("z"), "done")])).toThrow("2 teams");
  // one team is room for a simple task, or a lead
  expect(() => ask([LEAD])).not.toThrow();
  expect(() => ask([solo])).not.toThrow();
  expect(() => checkSlots([solo], lead("lead-cart"))).not.toThrow();
  // override passes; a simple task of another repo, a team's member and the lead's own worktree session do not count
  expect(() => ask([LEAD, solo], { override: true })).not.toThrow();
  expect(() => ask([LEAD, session("backend-dev-q", "/code/blog/.claude/worktrees/q")])).not.toThrow();
  expect(() => ask([LEAD, session("checkout.backend-dev-w", wt("w"))])).not.toThrow();
  // the cap does not depend on a flag: a team-less hire the Hire dialog or a plain session starts is a team too, and what refuses a wake refuses it
  expect(() => checkSlots([LEAD, solo], { role: "designer", name: "designer-x", task: "x", cwd: REPO })).toThrow("this project already has 2 teams");
  // a team's member, a Reviewer and a lead's own hires are not hired as a team of one
  expect(() => checkSlots([LEAD, solo], { role: "designer", name: "checkout.designer-x", task: "x", team: "checkout", cwd: REPO })).not.toThrow();
  expect(() => checkSlots([LEAD, solo], { role: "reviewer", name: "reviewer-review-x", task: "review-x", cwd: REPO })).not.toThrow();
  // a session of the user's own (a name that is no hire's) working in a worktree of the repo is no team
  expect(() => ask([LEAD, session("my-own-session", wt("mine"))])).not.toThrow();
  // the machine cap of 8 counts everyone
  expect(() => ask(Array(8).fill(session("elsewhere-x", "/elsewhere")))).toThrow("8 hires are already working");
});

test("f1rm letgo lets a simple dev go like a team member: its session, then its worktree and branch", async () => {
  const calls: string[] = [];
  const m = {
    gitCommonDir: () => `${REPO}/.git`,
    sessions: async () => [{ kind: "background", name: "backend-dev-x", cwd: wt("x"), id: "i1", sessionId: "s1" }],
    letGo: async (id: string) => void calls.push(`letgo ${id}`),
    removeWorktree: (_repo: string, task: string) => void calls.push(`rm ${task}`),
  } as unknown as Parameters<typeof letgo>[1];
  expect(await letgo(["backend-dev-x"], m, REPO)).toEqual({ lines: ["backend-dev-x: let go, removed its worktree and branch worktree-x"], ok: true });
  expect(calls).toEqual(["letgo i1", "rm x"]);
});
