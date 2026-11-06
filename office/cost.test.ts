import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { costUnits, specCosts, specTable } from "./cost.ts";
import { projectFolder } from "./cli/hire.ts";

const REPO = "/code/shop";
const usage = (id: string, input: number, output: number, cacheWrite: number, cacheRead: number) =>
  JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead } } });
const bash = (id: string, command: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: { command } }] } });
const result = (id: string, text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t-${id}`, content: text }] } });
const named = (name: string, role: string) => [JSON.stringify({ type: "agent-setting", agentSetting: role }), JSON.stringify({ type: "agent-name", agentName: name })];

function transcripts(files: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-cost-"));
  for (const [file, lines] of Object.entries(files)) {
    const path = join(dir, projectFolder(REPO), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n");
  }
  return dir;
}

test("cost units weigh input 1, cache write 1.25, cache read 0.1 and output 5", () => {
  expect(costUnits({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 2 })).toBe(10 + 125 + 100 + 10);
});

test("a spec's cost: the step sessions' own turns are coordination, each intern goes to the ticket its branch names, and a message written in parts counts once", () => {
  const dir = transcripts({
    "s1.jsonl": [...named("implement-7", "f1rm:step"), usage("a", 10, 100, 0, 1000), usage("a", 10, 120, 0, 1000), usage("b", 0, 30, 0, 0)],
    "s1/subagents/agent-x.jsonl": [bash("c", "/usr/bin/git checkout -b ticket-8 spec-7"), usage("c", 0, 400, 0, 0), bash("d", "/usr/bin/git checkout -b ticket-9 spec-7")],
    "s1/subagents/agent-y.jsonl": [bash("e", "/usr/bin/git checkout -b ticket-9 spec-7"), usage("e", 0, 200, 0, 0)],
    "s1/subagents/agent-z.jsonl": [bash("f", "/usr/bin/git diff main...ticket-8"), bash("f2", "/usr/bin/git merge ticket-9"), usage("f", 0, 100, 0, 0)],
    "s2.jsonl": [...named("close-7", "f1rm:step"), usage("g", 0, 50, 0, 0)],
    "s3.jsonl": [...named("tickets-9", "f1rm:step"), usage("h", 0, 999, 0, 0)],
    "s4.jsonl": [...named("someone", "f1rm:designer"), usage("i", 0, 999, 0, 0)],
  });
  const seven = specCosts(dir, REPO)[7];
  expect(seven.coordination).toEqual({ input: 10, cacheWrite: 0, cacheRead: 1000, output: 200 });
  expect(seven.tickets).toEqual({ 8: { input: 0, cacheWrite: 0, cacheRead: 0, output: 400 }, 9: { input: 0, cacheWrite: 0, cacheRead: 0, output: 200 } });
  expect(seven.other).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 100 });
  expect(seven.share).toBeCloseTo(200 / 900);
  expect(seven.total).toBe(5 * 900 + 10 + 0.1 * 1000);
  expect(Object.keys(specCosts(dir, REPO)).sort()).toEqual(["7", "9"]);
});

test("the PM that published a spec counts as that spec's coordination", () => {
  const dir = transcripts({
    "pm.jsonl": [...named("pm-shop", "f1rm:pm"), bash("a", "gh issue create --title 'Spec: x' --label ready-for-agent --body-file /tmp/s.md"), result("a", "https://github.com/o/shop/issues/12\n"), usage("a", 0, 300, 0, 0)],
    "pm/subagents/explore.jsonl": [usage("c", 0, 50, 0, 0)],
    "s1.jsonl": [...named("tickets-12", "f1rm:step"), usage("b", 0, 100, 0, 0)],
  });
  expect(specCosts(dir, REPO)[12].coordination.output).toBe(450);
});

test("f1rm cost lists the tickets over their size's budget; a ticket with no size label is medium", () => {
  const dir = transcripts({
    "s1.jsonl": [...named("implement-7", "f1rm:step")],
    "s1/subagents/a.jsonl": [bash("a", "git checkout -b ticket-8 spec-7"), usage("a", 0, 0, 0, 3_000_000)],
    "s1/subagents/b.jsonl": [bash("b", "git checkout -b ticket-9 spec-7"), usage("b", 0, 0, 0, 3_000_000)],
  });
  const row = specTable(REPO, dir, { 8: "l" }, "f1rm cost").split("\n").find((l) => l.startsWith("| #7 |"));
  expect(row).toEndWith("| #9 |");
});

test("a repo with no transcripts costs nothing", () => {
  expect(specCosts(mkdtempSync(join(tmpdir(), "f1rm-cost-")), REPO)).toEqual({});
});
