// The client's pure parts: what each state looks like (pose, counts) and where it goes (layout).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Employee, OfficeState } from "../server/office.ts";
import { CELL, layoutOffice, ROOM } from "./layout.ts";
import { identityOf } from "./people.ts";
import { poseOf, statusCounts, type Pose } from "./pose.ts";

const employee = (sessionId: string, room: string, over: Partial<Employee> = {}): Employee => ({
  sessionId, status: "idle", activity: "", tool: "", cwd: "/x", room, terminal: {}, ...over,
});
const office = (rooms: string[], staff: Employee[]): OfficeState => ({
  rooms: Object.fromEntries(rooms.map((r) => [r, { id: r, name: r }])),
  employees: Object.fromEntries(staff.map((e) => [e.sessionId, e])),
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
  ];
  for (const [e, pose] of cases) expect(poseOf(employee("s", "r", e))).toBe(pose);
});

test("the counter tallies working, waiting and idle employees", () => {
  const state = office(["r"], [
    employee("a", "r", { status: "working" }),
    employee("b", "r", { status: "working" }),
    employee("c", "r", { status: "waiting" }),
    employee("d", "r"),
  ]);
  expect(statusCounts(state)).toEqual({ working: 2, waiting: 1, idle: 1 });
  expect(statusCounts(office([], []))).toEqual({ working: 0, waiting: 0, idle: 0 });
});

test("an employee keeps one name and look for the same session id", () => {
  expect(identityOf("abc")).toEqual(identityOf("abc"));
  expect(identityOf("abc").role).toBe("Freelancer");
});

test("rooms sort by name, and a room with nobody in it is empty", () => {
  const { rooms } = layoutOffice(office(["b", "a"], [employee("s1", "b")]), 400);
  expect(rooms.map((r) => [r.room.name, r.empty])).toEqual([["a", true], ["b", false]]);
});

test("employees take desks in session id order, filling rows of three", () => {
  const staff = ["s4", "s2", "s1", "s3"].map((id) => employee(id, "r"));
  const [room] = layoutOffice(office(["r"], staff), 400).rooms;
  expect(room.desks.map((d) => d.employee?.sessionId)).toEqual(["s1", "s2", "s3", "s4", undefined, undefined]);
  expect(room.desks[3].y - room.desks[0].y).toBe(CELL.h);
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
