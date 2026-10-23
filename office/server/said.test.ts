// What a hire last said, read from the tail of its own transcript.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSaid } from "./said.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-said-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const said = (text: string, extra: object = {}) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, ...extra });
const tool = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } };
/** A transcript at <root>/<project>/<session>.jsonl, and the path the hook would report for it. */
function transcript(session: string, lines: unknown[], project = "-code-shop") {
  mkdirSync(join(root, project), { recursive: true });
  const path = join(root, project, `${session}.jsonl`);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

test("the last assistant text, past tool calls, user lines and a sub-agent's words", () => {
  const path = transcript("a", [said("first"), said("Running the build to see why the test fails."), tool, { type: "user", message: { content: "ok" } }, said("a sub-agent's words", { isSidechain: true }), tool]);
  expect(lastSaid(root, "a", path)).toBe("Running the build to see why the test fails.");
});

test("only text counts: a thinking block and a tool call are left out, and a message's text blocks join", () => {
  const path = transcript("b", [{ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "Deleting" }, { type: "text", text: "the build folder." }, tool.message.content[0]] } }]);
  expect(lastSaid(root, "b", path)).toBe("Deleting the build folder.");
});

test("it is cut to 300 characters, with control characters and runs of space gone", () => {
  const path = transcript("c", [said("x".repeat(500))]);
  const out = lastSaid(root, "c", path);
  expect([out.length, out.endsWith("…")]).toEqual([300, true]);
  expect(lastSaid(root, "c", transcript("c", [said("one\n\ntwo\u0007   three‮")]))).toBe("one two three");
});

test("a long transcript is read from its tail", () => {
  const filler = Array.from({ length: 3000 }, (_, i) => said(`old line ${i} ${"y".repeat(100)}`));
  const path = transcript("d", [...filler, said("the newest words"), tool]);
  expect(lastSaid(root, "d", path)).toBe("the newest words");
});

test("a transcript with no assistant text, a broken line or no file says nothing", () => {
  expect(lastSaid(root, "e", transcript("e", [tool, "{not json", { type: "user", message: { content: "hi" } }]))).toBe("");
  expect(lastSaid(root, "nope", join(root, "-code-shop", "nope.jsonl"))).toBe("");
  expect(lastSaid(root, "e", undefined)).toBe("");
});

test("only the session's own file under the transcripts folder is read", () => {
  const other = transcript("f", [said("not mine")]);
  expect(lastSaid(root, "g", other)).toBe(""); // another session's file
  expect(lastSaid(root, "f", `${root}/-code-shop/../-code-shop/f.jsonl`)).toBe(""); // a ..
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-said-out-")));
  writeFileSync(join(outside, "h.jsonl"), JSON.stringify(said("outside")) + "\n");
  mkdirSync(join(root, "-link"));
  symlinkSync(join(outside, "h.jsonl"), join(root, "-link", "h.jsonl"));
  expect(lastSaid(root, "h", join(root, "-link", "h.jsonl"))).toBe(""); // a link that leads out
  rmSync(outside, { recursive: true, force: true });
});
