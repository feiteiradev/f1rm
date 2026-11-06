// The usage hold in checkSlots (hire and wake both pass it), the weekly pace that holds no start, and the wait that says when a hold ends.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSlots, HireRefused, NO_SLOT, planHire, untilSlot, UsageHold, type LiveHires } from "./hire.ts";
import { readUsage, usageFile } from "../usage.ts";

const REPO = "/code/shop";
const NOW = 1_800_000_000, H = 3600, D = 86400;
const wt = (task: string) => join(REPO, ".claude", "worktrees", task);
const session = (name: string, cwd: string, state = "working"): LiveHires[number] => ({ name, state, cwd });
const WORKER = session("scratch", "/code/elsewhere"); // a working session that is no team of this project
const home0 = process.env.HOME;
let home: string;
beforeEach(() => (process.env.HOME = home = mkdtempSync(join(tmpdir(), "pacing-"))));
afterEach(() => (process.env.HOME = home0));

const put = (u: unknown) => (mkdirSync(join(home, ".f1rm"), { recursive: true }), writeFileSync(usageFile(home), typeof u === "string" ? u : JSON.stringify(u)));
// 5-hour window resetting in 2h; 7-day window with 1 day left (86% of the week gone), so 94% is ahead of pace but 50% is not
const five = (usedPct: number, resetsAt = NOW + 2 * H) => ({ fiveHour: { usedPct, resetsAt }, readAt: NOW });
const week = (usedPct: number, left = D) => ({ sevenDay: { usedPct, resetsAt: NOW + left }, readAt: NOW });
// The real callers read the file and hand the reading in; so does this.
const ask = (live: LiveHires = [WORKER], over: Partial<Parameters<typeof checkSlots>[1]> = {}, now = NOW) =>
  checkSlots(live, { role: "backend-dev", name: "backend-dev-x", task: "x", cwd: REPO, now, usage: readUsage(usageFile(home), now), ...over });
const refusal = (f: () => void) => {
  try {
    f();
  } catch (e) {
    return e as HireRefused;
  }
  throw new Error("not refused");
};

test("a new start is refused at 90% of the 5-hour window and at 95% of the weekly one, as a counted cap with the time it ends", () => {
  put(five(90));
  const e = refusal(() => ask());
  expect(e).toBeInstanceOf(UsageHold);
  expect(e).toBeInstanceOf(HireRefused);
  expect(e.working).toBe(1);
  expect(e.message).toContain("usage hold: 5-hour usage is 90%");
  expect(e.message).toMatch(/new sessions wait until \d\d:\d\d$/);
  put(week(95));
  expect(refusal(() => ask()).message).toContain("7-day usage is 95%");
  expect(refusal(() => ask()).working).toBe(1);
});

test("a hold more than a day away names the weekday it ends", () => {
  put(week(97, 3 * D));
  expect(refusal(() => ask()).message).toMatch(/resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d\).*wait until (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d$/);
});

test("89% and 94% start; the hold is gone once resets_at has passed; override, a missing and a corrupt file never hold", () => {
  put(five(89));
  expect(() => ask()).not.toThrow();
  put(week(94, 6 * D));
  expect(() => ask()).not.toThrow();
  put(five(99));
  expect(() => ask([WORKER], {}, NOW + 3 * H)).not.toThrow(); // the window dropped
  expect(() => ask([WORKER], { override: true })).not.toThrow();
  put("{not json");
  expect(() => ask()).not.toThrow();
  expect(() => ask([WORKER], { usage: null })).not.toThrow();
});

test("callers that hand in no usage are never held, whatever the machine's usage file says (planHire, checkSlots)", async () => {
  put(five(99));
  expect(() => checkSlots([WORKER], { role: "backend-dev", name: "backend-dev-x", task: "x", cwd: REPO })).not.toThrow();
  const argv = await planHire({ role: "designer", task: "x", cwd: REPO, brief: "Task: x", reportTo: "pm-shop" }, { backgroundSessions: async () => [WORKER], gitCommonDir: () => null });
  expect(argv[0]).toBe("claude");
  // one handed the reading is held
  const usage = { fiveHour: { usedPct: 99, resetsAt: Date.now() / 1000 + H }, readAt: 0 };
  await expect(planHire({ role: "designer", task: "x", cwd: REPO, brief: "Task: x", reportTo: "pm-shop", usage }, { backgroundSessions: async () => [WORKER], gitCommonDir: () => null })).rejects.toBeInstanceOf(UsageHold);
});

test("a hold refuses a start with sessions live and leaves them as they were; the same start passes under the line", () => {
  const live = [WORKER, session("lead-cart", REPO)];
  const before = structuredClone(live);
  put(five(95));
  expect(refusal(() => ask(live, { role: "designer", name: "cart.designer-a", task: "a", team: "cart" })).working).toBe(2);
  expect(live).toEqual(before);
  put(five(50));
  expect(() => ask(live, { role: "designer", name: "cart.designer-a", task: "a", team: "cart" })).not.toThrow();
  // the other gates still answer under a hold, with override
  put(five(95));
  expect(() => ask([session("backend-dev-x", wt("x"), "done")], { override: true })).toThrow("one specialist per task");
});

test("ahead of the weekly pace no team count holds a start: a second and a third lead, a simple task and a designer all start", () => {
  put(week(50, 6 * D)); // 14% of the week gone, 50% used: ahead of pace
  const cart = session("lead-cart", REPO), solo = session("backend-dev-y", wt("y"));
  expect(() => ask([cart], { role: "lead", name: "lead-pay", task: "pay" })).not.toThrow();
  expect(() => ask([cart, session("lead-pay", REPO)], { role: "lead", name: "lead-ship", task: "ship" })).not.toThrow();
  expect(() => ask([session("lead-cart", REPO, "done"), solo], { role: "lead", name: "lead-pay", task: "pay" })).not.toThrow();
  expect(() => ask([cart, solo])).not.toThrow(); // a simple task beside a lead and another simple task
  expect(() => ask([cart, session("designer-z", wt("z"), "done")], { role: "designer", name: "designer-x", task: "x" })).not.toThrow();
});

test("with no caps left the usage holds are what refuses: on pace or ahead of it a third and a fourth lead start beside 9 working, and the hold still holds", () => {
  const crowd = [...Array(9).fill(WORKER), session("lead-cart", REPO), session("lead-pay", REPO)];
  const third = { role: "lead", name: "lead-ship", task: "ship" };
  for (const left of [D, 6 * D]) {
    put(week(50, left)); // on pace, then ahead of it
    expect(() => ask(crowd, third)).not.toThrow();
    expect(() => ask([...crowd, session("lead-ship", REPO)], { role: "lead", name: "lead-tax", task: "tax" })).not.toThrow();
  }
  put(five(95));
  const e = refusal(() => ask(crowd, third));
  expect(e).toBeInstanceOf(UsageHold);
  expect(e.working).toBe(11);
});

test("a wait that ends at a usage hold says again when it ends, with the NO_SLOT text", async () => {
  put(five(95));
  const said: string[] = [];
  let t = 0;
  const w = { sleep: async (ms: number) => void (t += ms), now: () => t, total: 60_000, say: (l: string) => void said.push(l) };
  expect(await untilSlot(async () => ask(), w)).toBeNull();
  expect(said.at(-1)).toBe(NO_SLOT);
  expect(said.at(-2)).toContain("new sessions wait until");
  expect(said.at(-2)).toContain("usage hold");
});
