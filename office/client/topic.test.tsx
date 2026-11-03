// The New topic dialog: the name check, the POST and the dialog's markup.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OfficeState } from "../server/office.ts";
import { liveLeads, startTopic, topicProblem } from "./topic.ts";
import { TopicDialog } from "./topic.tsx";

test("a topic name must be a slug and must not be a lead already live in the project", () => {
  expect(topicProblem("billing", ["lead-search"])).toBeNull();
  expect(topicProblem("", [])).toBe("");
  expect(topicProblem("Bad Name", [])).toContain("lowercase words joined by hyphens");
  expect(topicProblem("search", ["lead-search"])).toBe("lead-search is already live in this project.");
});

test("the live leads are those of this room only", () => {
  const e = (name: string, room: string, role: string) => ({ name, room, role });
  const state = { employees: { a: e("lead-x", "r1", "lead"), b: e("lead-y", "r2", "lead"), c: e("lead-z", "r1", "pm") } } as unknown as OfficeState;
  expect(liveLeads(state, "r1")).toEqual(["lead-x"]);
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
