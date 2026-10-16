// The replay: the recorded fixture, played through the server's reducer, shows what the demo promises.
import { expect, test } from "bun:test";
import fixture from "./fixture.json";
import { MARKERS } from "./scenario.ts";
import { emptyOffice, reduce, type F1rmEvent, type OfficeState } from "../server/office.ts";
import { frames, play } from "./replay.ts";
import { looksPrivate } from "./scrub.ts";

const events = fixture as F1rmEvent[];
const ev = (at: number, kind: string, over: Partial<F1rmEvent> = {}): F1rmEvent => ({
  sessionId: "s", kind, cwd: "/home/demo/r", room: { id: "/home/demo/r/.git", name: "r" }, terminal: {}, at, ...over,
});

test("frames fold the events with the server's reducer and take quiet employees offline", () => {
  const fs = frames([ev(1000, "PreToolUse", { tool: "Edit", activity: "Edit a.ts" }), ev(2000, "Stop", { activity: "" }), ev(400_000, "Stop", { sessionId: "other" })]);
  const at = (ms: number) => fs.filter((f) => f.at <= ms).at(-1)!.state;
  expect(Object.keys(at(0).employees)).toEqual([]);
  expect(at(1000).employees.s).toMatchObject({ status: "working", activity: "Edit a.ts" });
  expect(at(2000).employees.s.status).toBe("idle");
  expect(at(2000 + 5 * 60_000 - 1).employees.s.status).toBe("idle");
  expect(at(2000 + 5 * 60_000).employees.s.status).toBe("offline");
});

test("the fixture's final frame is the reducer's fold of the same events", () => {
  const folded = events.reduce(reduce, emptyOffice());
  const last = frames(events).at(-1)!.state;
  for (const [id, e] of Object.entries(folded.employees)) expect(last.employees[id]).toMatchObject({ ...e, status: expect.any(String), lastEventAt: e.lastEventAt });
  expect(Object.keys(last.employees).sort()).toEqual(Object.keys(folded.employees).sort());
});

test("the demo shows rooms, every Work role, a Founder team, freelancers, interns, and working, waiting, idle and offline employees", () => {
  const states = frames(events).map((f) => f.state);
  const seen = (pick: (s: OfficeState) => Iterable<string | null>) => new Set(states.flatMap((s) => [...pick(s)]));
  expect(Math.max(...states.map((s) => Object.keys(s.rooms).length))).toBeGreaterThanOrEqual(3);
  expect(seen((s) => Object.values(s.employees).map((e) => e.role))).toEqual(new Set([null, "pm", "lead", "designer", "frontend", "backend", "reviewer", "researcher", "marketer", "seo"]));
  expect(seen((s) => Object.values(s.employees).map((e) => e.status))).toEqual(new Set(["working", "waiting", "idle", "offline"]));
  expect(Math.max(...states.map((s) => Object.keys(s.interns).length))).toBeGreaterThanOrEqual(1);
  // Two designers at once, each with a name of its own and no counter.
  const designers = states.map((s) => Object.values(s.employees).filter((e) => e.role === "designer").map((e) => e.name)).find((n) => n.length >= 2)!;
  expect(new Set(designers).size).toBe(designers.length);
  expect(designers.some((n) => n.includes("("))).toBe(false);
});

test("the fixture has no prompt, path, secret or private title in it", () => {
  const json = JSON.stringify(events);
  for (const marker of MARKERS) expect(json.toLowerCase()).not.toContain(marker.toLowerCase());
  expect(looksPrivate(json)).toBe(false);
});

test("play emits each frame in turn at the sped-up pace, then starts over", () => {
  const fs = frames([ev(1000, "PreToolUse"), ev(4000, "Stop")]);
  const timers: { f: () => void; ms: number }[] = [];
  const seen: OfficeState[] = [];
  const stop = play(fs, (s) => seen.push(s), { speed: 2, schedule: (f, ms) => (timers.push({ f, ms }), timers.length as any), cancel: () => {} });
  expect(seen).toEqual([fs[0].state]);
  expect(timers[0].ms).toBe((fs[1].at - fs[0].at) / 2);
  for (let i = 1; i < fs.length; i++) timers.at(-1)!.f();
  expect(seen.map((s) => s)).toEqual(fs.map((f) => f.state));
  expect(timers.at(-1)!.ms).toBe(0);
  timers.at(-1)!.f();
  expect(seen.at(-1)).toBe(fs[0].state);
  stop();
});
