// What a hire said in the message that holds a call, read from the tail of its own transcript.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSaid } from "./said.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-said-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Claude Code writes each content block of one assistant message as its own line, all with the message's id.
const block = (msg: string, content: object, extra: object = {}) => ({ type: "assistant", message: { id: msg, content: [content] }, ...extra });
const said = (msg: string, text: string, extra: object = {}) => block(msg, { type: "text", text }, extra);
const call = (msg: string, id: string, input: object, extra: object = {}, name = "Bash") => block(msg, { type: "tool_use", id, name, input }, extra);
const result = (id: string, extra: object = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });
/** A transcript at <root>/<project>/<session>.jsonl, and the path the hook would report for it. */
function transcript(session: string, lines: unknown[], project = "-code-shop") {
  mkdirSync(join(root, project), { recursive: true });
  const path = join(root, project, `${session}.jsonl`);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}
const ls = { command: "ls", description: "List the files" };
const why = (session: string, path: string | undefined, input: object = ls, tool = "Bash") => lastSaid(root, session, path, tool, input);

test("the words of the message that holds the call, past the call itself and a sub-agent's words", () => {
  const path = transcript("a", [said("m0", "first"), said("m1", "Running the build to see why the test fails."), call("m1", "t1", ls), said("m9", "a sub-agent's words", { isSidechain: true }), result("tX", { isSidechain: true })]);
  expect(why("a", path)).toBe("Running the build to see why the test fails.");
});

test("every call of a batch has the batch's words, even though each result is written before the next call's prompt", () => {
  const waiting = transcript("a1", [said("m1", "Checking both folders."), call("m1", "t1", { command: "ls docs" }), call("m1", "t2", { command: "ls src" }), result("t1")]);
  expect(why("a1", waiting, { command: "ls src" })).toBe("Checking both folders.");
});

test("a call whose message has no words has no why: an earlier step's words are not its reason", () => {
  expect(why("a2", transcript("a2", [said("m1", "Listing the files."), call("m1", "t1", { command: "pwd" }), result("t1"), call("m2", "t2", ls)]))).toBe("");
  expect(why("a2", transcript("a2", [said("m1", "An old answer."), { type: "user", message: { content: "next task please" } }, call("m2", "t2", ls)]))).toBe("");
  expect(why("a2", transcript("a2", [said("m1", "Listing the files."), call("m1", "t1", { command: "pwd" }), result("t1"), said("m2", "Now the build."), call("m2", "t2", ls)]))).toBe("Now the build.");
});

test("a call that is not in the transcript yet has no why, and an identical call that already ran is not it", () => {
  expect(why("a3", transcript("a3", [said("m1", "Before it is written.")]))).toBe("");
  expect(why("a3", transcript("a3", [said("m1", "First time."), call("m1", "t1", ls), result("t1")]))).toBe(""); // the same command ran and finished; this one is not written yet
  expect(why("a3", transcript("a3", [said("m1", "First time."), call("m1", "t1", ls), result("t1"), said("m2", "Again."), call("m2", "t2", ls)]))).toBe("Again.");
  expect(why("a3", transcript("a3", [said("m1", "Other tool."), call("m1", "t1", ls, {}, "Read")]))).toBe(""); // same input, other tool
  expect(why("a3", transcript("a3", [said("m1", "Other command."), call("m1", "t1", { command: "pwd" })]))).toBe("");
});

test("a sub-agent's call has its own words, never the parent's", () => {
  const path = transcript("a4", [
    said("p1", "The parent's plan.", { isSidechain: false }), call("p1", "tp", { description: "Explore", prompt: "x" }, {}, "Agent"),
    said("s1", "The sub-agent reads the docs.", { isSidechain: true }), call("s1", "ts", ls, { isSidechain: true }),
  ]);
  expect(why("a4", path)).toBe("The sub-agent reads the docs.");
  expect(why("a4", transcript("a4", [said("p1", "The parent's plan."), call("p1", "tp", { description: "Explore" }, {}, "Agent"), call("s1", "ts", ls, { isSidechain: true })]))).toBe("");
});

test("only text counts: a thinking block and a tool call are left out, and a message's text blocks join", () => {
  const path = transcript("b", [block("m1", { type: "thinking", thinking: "secret plan" }), said("m1", "Deleting"), said("m1", "the build folder."), call("m1", "t1", ls)]);
  expect(why("b", path)).toBe("Deleting the build folder.");
});

test("it is cut to 300 characters, with control characters and runs of space gone", () => {
  const out = why("c", transcript("c", [said("m1", "x".repeat(500)), call("m1", "t1", ls)]));
  expect([out.length, out.endsWith("…")]).toEqual([300, true]);
  expect(why("c", transcript("c", [said("m1", "one\n\ntwo\u0007   three‮"), call("m1", "t1", ls)]))).toBe("one two three");
});

test("a long transcript is read from its tail", () => {
  const filler = Array.from({ length: 3000 }, (_, i) => said(`old${i}`, `old line ${i} ${"y".repeat(100)}`));
  const path = transcript("d", [...filler, said("new", "the newest words"), call("new", "t1", ls)]);
  expect(why("d", path)).toBe("the newest words");
});

test("a transcript with no such call, a broken line or no file says nothing", () => {
  expect(why("e", transcript("e", [call("m1", "t1", { command: "pwd" }), "{not json", { type: "user", message: { content: "hi" } }]))).toBe("");
  expect(why("nope", join(root, "-code-shop", "nope.jsonl"))).toBe("");
  expect(why("e", undefined)).toBe("");
});

test("only the session's own file under the transcripts folder is read", () => {
  const other = transcript("f", [said("m1", "not mine"), call("m1", "t1", ls)]);
  expect(why("g", other)).toBe(""); // another session's file
  expect(why("f", `${root}/-code-shop/../-code-shop/f.jsonl`)).toBe(""); // a ..
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-said-out-")));
  writeFileSync(join(outside, "h.jsonl"), JSON.stringify(said("m1", "outside")) + "\n" + JSON.stringify(call("m1", "t1", ls)) + "\n");
  mkdirSync(join(root, "-link"));
  symlinkSync(join(outside, "h.jsonl"), join(root, "-link", "h.jsonl"));
  expect(why("h", join(root, "-link", "h.jsonl"))).toBe(""); // a link that leads out
  rmSync(outside, { recursive: true, force: true });
});
