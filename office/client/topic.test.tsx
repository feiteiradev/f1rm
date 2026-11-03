// The New topic dialog: the name check, the POST and the dialog's markup.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OfficeState } from "../server/office.ts";
import { editTopic, liveLeads, startDisabled, startTopic, submitTopic, topicProblem, type TopicForm } from "./topic.ts";
import { TopicDialog } from "./topic.tsx";

test("a topic name must be a slug and must not be a lead already live in the project", () => {
  expect(topicProblem("billing", ["lead-search"])).toBeNull();
  expect(topicProblem("", [])).toBe("");
  expect(topicProblem("Bad Name", [])).toContain("lowercase words joined by hyphens");
  expect(topicProblem("search", ["lead-search"])).toBe("lead-search is already live in this project.");
});

test("the live leads are those of this room only", () => {
  const e = (name: string, room: string, role: string, status = "idle") => ({ name, room, role, status });
  const state = { employees: { a: e("lead-x", "r1", "lead"), b: e("lead-y", "r2", "lead"), c: e("lead-z", "r1", "pm"), d: e("lead-gone", "r1", "lead", "offline") } } as unknown as OfficeState;
  expect(liveLeads(state, "r1")).toEqual(["lead-x"]);
});

// The dialog's behaviour, driven through its state holder: there is no DOM here.
const store = (topic: string) => {
  let f: TopicForm = { topic, busy: false, refused: null };
  return { get: () => f, set: (u: (f: TopicForm) => TopicForm) => void (f = u(f)) };
};

test("Start is disabled on an invalid name, on a live lead's name and while busy", () => {
  const f = (topic: string, busy = false): TopicForm => ({ topic, busy, refused: null });
  expect(startDisabled(f("Bad Name"), [])).toBe(true);
  expect(startDisabled(f("search"), ["lead-search"])).toBe(true);
  expect(startDisabled(f("billing", true), [])).toBe(true);
  expect(startDisabled(f("billing"), ["lead-search"])).toBe(false);
});

test("submitting closes the dialog on success, and never posts for a bad name", async () => {
  let closed = 0, posts = 0;
  const send = async () => (posts++, { error: null, reply: null });
  await submitTopic(store("Bad"), "r1", [], send, () => closed++);
  expect([closed, posts]).toEqual([0, 0]);
  await submitTopic(store("billing"), "r1", [], send, () => closed++);
  expect([closed, posts]).toEqual([1, 1]);
});

test("a second submit while the first is in flight posts nothing", async () => {
  let posts = 0;
  const send = async () => (posts++, await Bun.sleep(5), { error: null, reply: null });
  const s = store("billing");
  await Promise.all([submitTopic(s, "r1", [], send, () => {}), submitTopic(s, "r1", [], send, () => {})]);
  expect(posts).toBe(1);
});

test("the server's refusal is shown and unbusies Start; editing the name clears it", async () => {
  const s = store("billing");
  await submitTopic(s, "r1", [], async () => ({ error: "Two teams are working.", reply: null }), () => {});
  expect(s.get()).toEqual({ topic: "billing", busy: false, refused: "Two teams are working." });
  expect(editTopic(s.get(), "billing2")).toEqual({ topic: "billing2", busy: false, refused: null });
});

test("a valid name posts topic with room and name and closes; a refusal shows the server's message", async () => {
  const calls: unknown[] = [];
  const ok = await startTopic("r1", "billing", async (path, body) => (calls.push([path, body]), { error: null, reply: { ok: true } }));
  expect(ok).toBeNull();
  expect(calls).toEqual([["topic", { room: "r1", name: "billing" }]]);
  const no = await startTopic("r1", "billing", async () => ({ error: "Two teams are working.", reply: null }));
  expect(no).toBe("Two teams are working.");
});

test("a bad or live name never posts", async () => {
  let n = 0;
  const fake = async () => (n++, { error: null, reply: null });
  expect(await startTopic("r1", "Bad", fake, [])).toContain("lowercase");
  expect(await startTopic("r1", "a", fake, ["lead-a"])).toContain("already live");
  expect(n).toBe(0);
});

test("the dialog has a name field and a Start button, disabled until the name passes", () => {
  const html = renderToStaticMarkup(<TopicDialog room="r1" name="shop" live={[]} onClose={() => {}} />);
  expect(html).toContain("New topic in");
  expect(html).toContain("<input");
  expect(html).toMatch(/<button type="submit" disabled="">Start<\/button>/);
});
