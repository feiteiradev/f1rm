// The flat hire: `--simple` (the PM's one dev for a simple task), the leads' and the Reviewer's limits, `--level` on the devs, the dev's Review paragraph, and no team cap on a simple task.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSlots, parseHireFlags, planHire, type HireRequest, type LiveHires } from "./hire.ts";
import { letgo } from "./letgo.ts";

const REPO = "/code/shop";
const wt = (task: string) => join(REPO, ".claude", "worktrees", task);
const session = (name: string, cwd: string, state = "working"): LiveHires[number] => ({ name, state, cwd });
const machine = (sessions: LiveHires | null = []) => ({ backgroundSessions: async () => sessions, gitCommonDir: () => null });
const req = (over: Partial<HireRequest> = {}): HireRequest => ({ role: "backend-dev", task: "x", cwd: REPO, brief: "Task: x", reportTo: "pm-shop", ...over });
const plan = (over: Partial<HireRequest> = {}, sessions: LiveHires | null = []) => planHire(req(over), machine(sessions));
const promptOf = (argv: string[]) => argv[argv.indexOf("--worktree") + 2];
const LEAD = session("lead-checkout", REPO, "done");

test("claude flags after the brief cannot change the hire's agent, name or worktree", async () => {
  for (const extra of [["--agent", "f1rm:backend-dev"], ["--agent=f1rm:lead"], ["--name", "a.b"], ["--name=x"], ["-n", "x"], ["--worktree", "w"], ["--model", "haiku", "--worktree=w"]]) {
    await expect(plan({ role: "designer", extra })).rejects.toThrow("is the hire's own");
  }
  expect(await plan({ role: "designer", extra: ["--allowedTools", "Bash", "--model", "haiku"] })).toContain("--allowedTools");
});

test("no cap counts teams or sessions: a third and a fourth team start beside a lead and a simple task, and so does a hire with 9 working on the machine", async () => {
  const solo = session("backend-dev-y", wt("y"));
  const ask = (live: LiveHires, over: Partial<Parameters<typeof checkSlots>[1]> = {}) =>
    checkSlots(live, { role: "backend-dev", name: "backend-dev-x", task: "x", cwd: REPO, ...over });
  const lead = (name: string) => ({ role: "lead", name, task: name.slice(5), cwd: REPO });
  // a lead and a simple task are two teams; a third simple task, a third lead and a fourth one all start
  expect(() => ask([LEAD, solo])).not.toThrow();
  expect(() => checkSlots([LEAD, solo], lead("lead-cart"))).not.toThrow();
  expect(() => checkSlots([LEAD, solo, session("lead-cart", REPO)], lead("lead-pay"))).not.toThrow();
  expect(() => checkSlots([LEAD, solo], { role: "designer", name: "designer-x", task: "x", cwd: REPO })).not.toThrow();
  // 9 working on the machine
  expect(() => ask(Array(9).fill(session("elsewhere-x", "/elsewhere")))).not.toThrow();
  // one specialist per task still refuses
  expect(() => ask([LEAD, session("backend-dev-x", wt("x"))])).toThrow("one specialist per task");
});

test("f1rm letgo lets a simple dev go like a team member: its session, then its worktree and branch", async () => {
  const calls: string[] = [];
  const m = {
    gitCommonDir: () => `${REPO}/.git`,
    sessions: async () => [{ kind: "background", name: "backend-dev-x", cwd: wt("x"), id: "i1", sessionId: "s1" }],
    letGo: async (id: string, o?: { afterStop?: () => void }) => {
      o?.afterStop?.();
      calls.push(`letgo ${id}`);
    },
    removeWorktree: (_repo: string, task: string) => void calls.push(`rm ${task}`),
  } as unknown as Parameters<typeof letgo>[1];
  expect(await letgo(["backend-dev-x"], m, REPO)).toEqual({ lines: ["backend-dev-x: let go, removed its worktree and branch worktree-x"], ok: true });
  expect(calls).toEqual(["rm x", "letgo i1"]); // the worktree goes after the stop and before claude rm
});

const firstPrompt = (argv: string[]) => argv.find((a) => a.startsWith("/"))!;
