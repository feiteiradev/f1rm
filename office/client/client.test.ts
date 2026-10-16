// The client's pure parts: what each state looks like (pose, counts) and where it goes (layout).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reduce, type Employee, type F1rmEvent, type OfficeState } from "../server/office.ts";
import { CELL, CORNER, layoutOffice, ROOM, rosterOf } from "./layout.ts";
import { decodeLook, nameFor, ROLES, ROLE_IDS, roleOfAgentType, seedFor, type RoleId } from "../people.ts";
import { DOOR, doorsOf, hashFor, layoutLobby, projectState, roomFromHash } from "./lobby.ts";
import { argsText } from "./approvals.ts";
import { poseOf, statusCounts, type Pose } from "./pose.ts";
import { TASK_NAME, taskFrom } from "./hire.ts";

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

test("each role wears its own shirt, while skin and hair vary by session; the lead's shirt is no one else's", () => {
  expect(new Set(ROLE_IDS.map((r) => ROLES[r].shirt)).size).toBe(ROLE_IDS.length);
  const designers = Array.from({ length: 30 }, (_, i) => decodeLook(seedFor({ sessionId: `d-${i}`, role: "designer" })));
  expect(new Set(designers.map((l) => l.shirt))).toEqual(new Set([ROLES.designer.shirt]));
  expect(new Set(designers.map((l) => `${l.skin}/${l.hair}`)).size).toBeGreaterThan(5);
  const freelancers = Array.from({ length: 200 }, (_, i) => decodeLook(seedFor({ sessionId: `f-${i}`, role: null })).shirt);
  expect(freelancers.includes(ROLES.lead.shirt)).toBe(false);
});

test("only f1rm's own agent types are roles", () => {
  const cases: [unknown, RoleId | undefined][] = [
    ["f1rm:designer", "designer"], ["f1rm:frontend-dev", "frontend"], ["f1rm:backend-dev", "backend"], ["f1rm:pm", "pm"], ["f1rm:lead", "lead"],
    ["f1rm:reviewer", "reviewer"], ["f1rm:researcher", "researcher"],
    ["f1rm:pm-dev", undefined], ["f1rm:designer-dev", undefined], ["f1rm:frontend", undefined], ["f1rm:backend", undefined],
    ["designer", undefined], ["other:designer", undefined], ["f1rm:janitor", undefined], ["f1rm:toString", undefined],
    ["Explore", undefined], ["", undefined], [undefined, undefined], [7, undefined],
  ];
  for (const [agentType, role] of cases) expect(roleOfAgentType(agentType)).toBe(role);
});

test("everyone keeps one name for the same session id, and 4,000 people in one office never share one or get a counter", () => {
  expect(nameFor("abc", new Set())).toBe(nameFor("abc", new Set()));
  const taken = new Set<string>();
  for (let i = 0; i < 4000; i++) taken.add(nameFor(`session-${i}`, taken));
  expect(taken.size).toBe(4000);
  expect([...taken].some((n) => /\(\d+\)/.test(n))).toBe(false);
  expect([...taken].filter((n) => !n.includes(" ")).length).toBeGreaterThan(150);
  expect([...taken].some((n) => /^\w+ [A-Z]\.$/.test(n))).toBe(true);
  expect(new Set(Array.from({ length: 60 }, (_, i) => seedFor({ sessionId: `session-${i}`, role: null }))).size).toBeGreaterThan(30);
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
    ["p", false],
    ["d", false], ["d2", false], ["d10", false],
    ["f1", true], ["f2", true], [undefined, true],
  ]);
  const quiet = layoutOffice(office(["r"], [employee("p", "r", { role: "pm" })]), 400).rooms[0];
  expect(quiet.desks.some((d) => d.hot)).toBe(false);
});

test("the PM sits at the table in the corner, alone; a second PM takes a desk, and with no PM the table waits empty", () => {
  const staff = [employee("p", "r", { role: "pm", name: "Priya" }), employee("p2", "r", { role: "pm", name: "Priya (2)" }), employee("d", "r", { role: "designer" }), employee("f", "r")];
  const [room] = layoutOffice(office(["r"], staff), 480, 300).rooms;
  const [table, ...desks] = room.desks;
  expect([table.table, table.employee?.sessionId]).toEqual([true, "p"]);
  expect(desks.map((d) => d.employee?.sessionId).filter(Boolean)).toEqual(["p2", "d", "f"]);
  expect(desks.some((d) => d.table)).toBe(false);
  // The table sits inside the corner, and every desk sits right of it.
  expect(table.x).toBeGreaterThanOrEqual(room.corner.x);
  expect(table.y + CELL.h).toBeLessThanOrEqual(room.corner.y + room.corner.h);
  expect(Math.min(...desks.map((d) => d.x))).toBeGreaterThanOrEqual(room.corner.x + CORNER.w);
  expect(rosterOf(office(["r"], staff))[0].sessionId).toBe("p");
  const nobody = layoutOffice(office(["r"], [employee("f", "r")]), 480, 300).rooms[0];
  expect([nobody.desks[0].table, nobody.desks[0].employee]).toEqual([true, undefined]);
});

test("employees take desks in session id order, filling rows of three", () => {
  const staff = ["s4", "s2", "s1", "s3"].map((id) => employee(id, "r"));
  const [room] = layoutOffice(office(["r"], staff), 400).rooms;
  expect(room.desks.map((d) => d.employee?.sessionId)).toEqual([undefined, "s1", "s2", "s3", "s4", undefined, undefined]);
  expect(room.desks[4].y - room.desks[1].y).toBe(CELL.h);
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

test("a door counts the employees inside, flags a raised hand, and a project nobody is in is empty", () => {
  const state = office(["shop", "blog", "docs"], [
    employee("a", "shop"), employee("b", "shop", { status: "waiting" }), employee("c", "blog", { status: "offline" }),
  ]);
  expect(doorsOf(state).map((d) => [d.room.id, d.count, d.waiting])).toEqual([["blog", 1, false], ["docs", 0, false], ["shop", 2, true]]);
});

test("doors wrap into centered rows that fit the width", () => {
  const state = office(["a", "b", "c", "d", "e"], []);
  const { doors, height } = layoutLobby(state, 3 * DOOR.w + 20);
  expect(doors.map((d) => d.y === doors[0].y)).toEqual([true, true, true, false, false]);
  expect(doors.every((d) => d.x >= 0 && d.x + DOOR.w <= 3 * DOOR.w + 20)).toBe(true);
  expect(doors[3].x).toBe(Math.floor((3 * DOOR.w + 20 - 2 * DOOR.w) / 2));
  expect(height).toBeGreaterThanOrEqual(doors[4].y + DOOR.h);
  expect(layoutLobby(office([], []), 100).doors).toEqual([]);
});

test("a project's slice holds only its employees, their interns and its board", () => {
  const state: OfficeState = {
    ...office(["shop", "blog"], [employee("a", "shop"), employee("b", "blog")]),
    interns: { i1: { agentId: "i1", parent: "a", type: "Explore" }, i2: { agentId: "i2", parent: "b", type: "Explore" } },
    boards: { shop: [], blog: [] },
  };
  const slice = projectState(state, "shop");
  expect(Object.keys(slice.rooms)).toEqual(["shop"]);
  expect(Object.keys(slice.employees)).toEqual(["a"]);
  expect(Object.keys(slice.interns)).toEqual(["i1"]);
  expect(Object.keys(slice.boards!)).toEqual(["shop"]);
  expect(projectState(state, "gone").rooms).toEqual({});
});

test("the URL fragment names the open project, paths and all", () => {
  expect(hashFor(null)).toBe("");
  expect(roomFromHash(hashFor("/Users/me/my shop/.git"))).toBe("/Users/me/my shop/.git");
  expect(roomFromHash("")).toBeNull();
  expect(roomFromHash("#/project/")).toBeNull();
  expect(roomFromHash("#/project/%E0%A4%A")).toBeNull();
  expect(roomFromHash("#other")).toBeNull();
});

test("one open project fills the view: its room spans the width and height, with the company in a row in the middle", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((id, i) => employee(id, "r", { role: ROLE_IDS[i] }));
  const { rooms, height } = layoutOffice(office(["r"], six), 480, 225);
  const solo = rooms[0];
  expect(new Set(solo.desks.slice(1, 7).map((d) => d.y)).size).toBe(1);
  expect(solo.w).toBeGreaterThanOrEqual(480 - 16);
  expect(solo.h).toBeGreaterThanOrEqual(225 - 16);
  expect(height).toBeLessThanOrEqual(225);
  const above = solo.desks[1].y - (solo.y + ROOM.wall), below = solo.y + solo.h - (solo.desks[1].y + CELL.h);
  expect(Math.abs(above - below)).toBeLessThanOrEqual(16);
  const left = solo.desks[1].x - (solo.corner.x + solo.corner.w), right = solo.x + solo.w - (solo.desks[6].x + CELL.w);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  const narrow = layoutOffice(office(["r"], six), 120, 400).rooms[0];
  expect(narrow.desks.length).toBe(1 + ROOM.cols * 2);
  const crowd = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => employee(id, "r"));
  expect(layoutOffice(office(["r"], crowd), 480, 100).height).toBeGreaterThan(100);
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

test("the tray shows a Bash command whole and any other tool's arguments as indented JSON", () => {
  const command = "cd /tmp && " + "echo long-argument ".repeat(100) + "&& rm -rf ./build";
  expect(argsText("Bash", { command, description: "x" })).toBe(command);
  expect(argsText("Write", { file_path: "/a.ts", content: "<img src=x onerror=alert(1)>" })).toBe(
    '{\n  "file_path": "/a.ts",\n  "content": "<img src=x onerror=alert(1)>"\n}',
  );
  expect(argsText("Bash", { command: 7 })).toBe('{\n  "command": 7\n}');
  expect(argsText("Bash", undefined)).toBe("");
});

test("the Hire dialog's task name comes from the brief's first words and always passes the server's check", () => {
  expect(taskFrom("Design the login page. Reply OK and stop.")).toBe("design-the-login-page");
  expect(taskFrom("  Fix: `f1rm hire` (v2)!! ")).toBe("fix-f1rm-hire-v2");
  expect(taskFrom("Add a very-long-hyphenated-compound-wordthatgoesonandonandon here")).toBe("add-a-very-long");
  expect(taskFrom("x".repeat(60))).toBe("x".repeat(40));
  expect(taskFrom("日本語 ...")).toBe("");
  for (const brief of ["Design the login page", "a b c d e f", "A".repeat(50) + "-b"]) expect(taskFrom(brief)).toMatch(TASK_NAME);
});
