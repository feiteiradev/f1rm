// ⌘K's search: what a query finds and in what order.
import { expect, test } from "bun:test";
import { search, type Entry } from "./search.ts";

const e = (id: string, name: string, role: string, room: string, task = ""): Entry => ({ id, name, role, room, task });
const staff = [
  e("1", "Maya", "Designer", "shop", "Edit hero.css"),
  e("2", "Tomas", "Backend", "shop", "Bash: bun test"),
  e("3", "Ines", "Reviewer", "blog"),
  e("4", "Kofi", "Backend", "blog", "Read schema.sql"),
];
const ids = (q: string) => search(staff, q).map((x) => x.id);

test("an empty query lists everyone in the order given", () => {
  expect(ids("")).toEqual(["1", "2", "3", "4"]);
  expect(ids("   ")).toEqual(["1", "2", "3", "4"]);
});

test("a query finds employees by name, role, room or task, ignoring case", () => {
  expect(ids("maya")).toEqual(["1"]);
  expect(ids("DESIGNER")).toEqual(["1"]);
  expect(ids("blog")).toEqual(["3", "4"]);
  expect(ids("schema")).toEqual(["4"]);
  expect(ids("zzz")).toEqual([]);
});

test("a query finds an employee by its session title", () => {
  const titled = [e("1", "Maya", "Designer", "shop"), { ...e("2", "Felix", "Frontend dev", "shop"), title: "checkout redesign" }];
  expect(search(titled, "checkout").map((x) => x.id)).toEqual(["2"]);
});

test("a fuzzy query matches letters in order, and several words must all match", () => {
  expect(ids("tms")).toEqual(["2"]);
  expect(ids("backend blog")).toEqual(["4"]);
  expect(ids("backend maya")).toEqual([]);
});

test("a whole-word match outranks a scattered one", () => {
  const people = [e("a", "Brenda", "Freelancer", "x"), e("b", "Ben", "Freelancer", "x"), e("c", "Bo", "Backend", "x")];
  expect(search(people, "ben").map((p) => p.id)).toEqual(["b", "a", "c"]);
});
