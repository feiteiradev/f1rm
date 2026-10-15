// The client's pure parts: what each state looks like (pose, counts) and where it goes (layout).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reduce, type Employee, type F1rmEvent, type OfficeState } from "../server/office.ts";
import { CELL, layoutOffice, ROOM, rosterOf } from "./layout.ts";
import { decodeLook, nameFor, ROLES, ROLE_IDS, roleOfAgentType, seedFor, type RoleId } from "../people.ts";
import { poseOf, statusCounts, type Pose } from "./pose.ts";

const employee = (sessionId: string, room: string, over: Partial<Employee> = {}): Employee => ({
  sessionId, name: sessionId, role: null, status: "idle", activity: "", tool: "", cwd: "/x", room, terminal: {}, lastEventAt: 0, ...over,
});
const office = (rooms: string[], staff: Employee[]): OfficeState => ({
  rooms: Object.fromEntries(rooms.map((r) => [r, { id: r, name: r }])),
  employees: Object.fromEntries(staff.map((e) => [e.sessionId, e])),
  interns: {},
});

test("each status and tool maps to its pose", () => {
  const cases: [Partial<Employee>, Pose][] = [
    [{ status: "working", tool: "Edit" }, "typing"],
    [{ status: "working", tool: "Write" }, "typing"],
    [{ status: "working", tool: "Read" }, "reading"],
    [{ status: "working", tool: "Grep" }, "reading"],
    [{ status: "working", tool: "WebSearch" }, "reading"],
    [{ status: "working", tool: "Bash" }, "running"],
    [{ status: "working", tool: "" }, "typing"],
    [{ status: "waiting", tool: "Bash" }, "hand"],
    [{ status: "idle", tool: "Edit" }, "coffee"],
    [{ status: "offline", tool: "Edit" }, "off"],
  ];
  for (const [e, pose] of cases) expect(poseOf(employee("s", "r", e))).toBe(pose);
});

test("the counter tallies working, waiting and idle employees", () => {
  const state = office(["r"], [
    employee("a", "r", { status: "working" }),
    employee("b", "r", { status: "working" }),
    employee("c", "r", { status: "waiting" }),
    employee("d", "r"),
    employee("e", "r", { status: "offline" }),
  ]);
  expect(statusCounts(state)).toEqual({ working: 2, waiting: 1, idle: 1, offline: 1 });
  expect(statusCounts(office([], []))).toEqual({ working: 0, waiting: 0, idle: 0, offline: 0 });
});

test("a role keeps its fixed name and look; its counter takes the lowest free number", () => {
  expect(ROLE_IDS.map((r) => ROLES[r].name)).toEqual(["Priya", "Maya", "Felix", "Bruno", "Ines", "Kofi"]);
  expect(new Set(ROLE_IDS.map((r) => ROLES[r].seed)).size).toBe(6);
  expect(new Set(ROLE_IDS.map((r) => decodeLook(ROLES[r].seed).shirt)).size).toBe(6);
  expect(seedFor({ sessionId: "a", role: "designer" })).toBe(seedFor({ sessionId: "b", role: "designer" }));
  expect(nameFor("a", "designer", new Set())).toBe("Maya");
  expect(nameFor("a", "designer", new Set(["Maya"]))).toBe("Maya (2)");
  expect(nameFor("a", "designer", new Set(["Maya", "Maya (3)"]))).toBe("Maya (2)");
});

test("only f1rm's own agent types are roles", () => {
  const cases: [unknown, RoleId | undefined][] = [
    ["f1rm:designer", "designer"], ["f1rm:frontend-dev", "frontend"], ["f1rm:backend-dev", "backend"], ["f1rm:pm", "pm"],
    ["f1rm:reviewer", "reviewer"], ["f1rm:researcher", "researcher"],
    ["f1rm:pm-dev", undefined], ["f1rm:designer-dev", undefined], ["f1rm:frontend", undefined], ["f1rm:backend", undefined],
    ["designer", undefined], ["other:designer", undefined], ["f1rm:janitor", undefined], ["f1rm:toString", undefined],
    ["Explore", undefined], ["", undefined], [undefined, undefined], [7, undefined],
  ];
  for (const [agentType, role] of cases) expect(roleOfAgentType(agentType)).toBe(role);
});

test("a freelancer keeps one name and look for the same session id, and 100 of them never share a name", () => {
  const name = (id: string, taken = new Set<string>()) => nameFor(id, null, taken);
  expect(name("abc")).toBe(name("abc"));
  const taken = new Set<string>();
  for (let i = 0; i < 100; i++) taken.add(name(`session-${i}`, taken));
  expect(taken.size).toBe(100);
  for (const role of ROLE_IDS) expect(taken.has(ROLES[role].name)).toBe(false);
  expect(new Set(Array.from({ length: 60 }, (_, i) => seedFor({ sessionId: `session-${i}`, role: null }))).size).toBe(60);
});

test("rooms sort by name, and a room with nobody in it is empty", () => {
  const { rooms } = layoutOffice(office(["b", "a"], [employee("s1", "b")]), 400);
  expect(rooms.map((r) => [r.room.name, r.empty])).toEqual([["a", true], ["b", false]]);
});

test("staff take the front desks in role order, freelancers the hot desks behind them", () => {
  const staff = [
    employee("f2", "r"), employee("f1", "r"),
    employee("d", "r", { role: "designer", name: "Maya" }),
    employee("p", "r", { role: "pm", name: "Priya" }),
    employee("d2", "r", { role: "designer", name: "Maya (2)" }),
    employee("d10", "r", { role: "designer", name: "Maya (10)" }),
  ];
  const [room] = layoutOffice(office(["r"], staff), 400).rooms;
  expect(room.desks.map((d) => [d.employee?.sessionId, d.hot])).toEqual([
    ["p", false], ["d", false], ["d2", false],
    ["d10", false], [undefined, false], [undefined, false],
    ["f1", true], ["f2", true], [undefined, true],
  ]);
  const quiet = layoutOffice(office(["r"], [employee("p", "r", { role: "pm" })]), 400).rooms[0];
  expect(quiet.desks.some((d) => d.hot)).toBe(false);
});

test("employees take desks in session id order, filling rows of three", () => {
  const staff = ["s4", "s2", "s1", "s3"].map((id) => employee(id, "r"));
  const [room] = layoutOffice(office(["r"], staff), 400).rooms;
  expect(room.desks.map((d) => d.employee?.sessionId)).toEqual(["s1", "s2", "s3", "s4", undefined, undefined]);
  expect(room.desks[3].y - room.desks[0].y).toBe(CELL.h);
});

test("the roster keeps its order when a session's event moves it to the end of the state", () => {
  const room = { id: "r", name: "r" };
  const event = (sessionId: string, at: number): F1rmEvent => ({ sessionId, kind: "PreToolUse", cwd: "/x", room, terminal: {}, at });
  let state = office([], []);
  for (const [i, id] of ["s2", "s3", "s1"].entries()) state = reduce(state, event(id, i));
  const before = rosterOf(state).map((e) => e.sessionId);
  state = reduce(state, event("s1", 9));
  expect(Object.keys(state.employees)).toEqual(["s2", "s3", "s1"]);
  expect(rosterOf(state).map((e) => e.sessionId)).toEqual(before);
  expect(before).toEqual(["s1", "s2", "s3"]);
});

test("the roster follows the office: rooms by name, then employees by session id", () => {
  const staff = [employee("s2", "b"), employee("s9", "a"), employee("s1", "b")];
  expect(rosterOf(office(["b", "a"], staff)).map((e) => e.sessionId)).toEqual(["s9", "s1", "s2"]);
});

test("rooms wrap to a new row when the width runs out", () => {
  const roomWidth = ROOM.pad * 2 + ROOM.cols * CELL.w;
  const state = office(["a", "b", "c"], []);
  const wide = layoutOffice(state, 3 * roomWidth + 40).rooms;
  expect(new Set(wide.map((r) => r.y)).size).toBe(1);
  const narrow = layoutOffice(state, roomWidth * 2 + 40).rooms;
  expect(narrow.map((r) => r.y > narrow[0].y)).toEqual([false, false, true]);
});

test("every bundled asset is credited with its source and CC0 license", () => {
  const credits = readFileSync(join(import.meta.dir, "../../CREDITS.md"), "utf8").split("\n");
  const assets = readdirSync(join(import.meta.dir, "assets"));
  expect(assets.length).toBeGreaterThan(0);
  for (const file of assets) {
    const row = credits.find((l) => l.includes(`\`office/client/assets/${file}\``));
    expect(row).toMatch(/https:\/\/kenney\.nl\/\S+/);
    expect(row).toContain("CC0 1.0");
  }
});
