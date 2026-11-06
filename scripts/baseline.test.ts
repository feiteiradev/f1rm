import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type Merge } from "./baseline";

const at = (hhmmss: string) => `2026-01-01T${hhmmss}Z`;
const ms = (hhmmss: string) => Date.parse(at(hhmmss));
const meta = (type: string, key: string, value: string) => JSON.stringify({ type, [key]: value });
const usage = (ts: string, id: string, i: number, o: number, cc: number, cr: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ts),
    message: {
      id,
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr },
    },
  });
const said = (ts: string) => JSON.stringify({ type: "user", timestamp: at(ts) });

function session(dir: string, folder: string, file: string, lines: string[]) {
  mkdirSync(dirname(join(dir, folder, file)), { recursive: true });
  writeFileSync(join(dir, folder, file), lines.join("\n") + "\n");
}

test("a task's row sums its dev and reviewer tokens once per message, and leads count only inside the window", () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  session(dir, "-repo--claude-worktrees-alpha", "dev.jsonl", [
    meta("agent-setting", "agentSetting", "f1rm:backend-dev"),
    usage("10:05:00", "m1", 10, 1, 100, 1000),
    usage("10:05:01", "m1", 10, 5, 100, 1000),
    usage("10:30:00", "m2", 20, 7, 0, 2000),
    said("10:31:00"),
  ]);
  session(dir, "-repo--claude-worktrees-alpha", "dev/subagents/agent-1.jsonl", [usage("10:10:00", "s1", 5, 5, 5, 5)]);
  session(dir, "-repo", "rev.jsonl", [
    meta("agent-setting", "agentSetting", "f1rm:reviewer"),
    meta("agent-name", "agentName", "rules.reviewer-review-alpha"),
    usage("11:45:00", "m3", 1, 2, 3, 4),
    said("11:50:00"),
  ]);
  session(dir, "-repo", "other-task-rev.jsonl", [
    meta("agent-setting", "agentSetting", "f1rm:reviewer"),
    meta("agent-name", "agentName", "rules.reviewer-review-beta"),
    usage("11:45:00", "m4", 7, 7, 7, 7),
  ]);
  session(dir, "-repo", "lead.jsonl", [
    meta("agent-setting", "agentSetting", "f1rm:lead"),
    meta("agent-name", "agentName", "lead-rules"),
    usage("09:00:00", "l1", 1000, 1000, 1000, 1000),
    usage("11:45:00", "l2", 100, 200, 300, 400),
    usage("13:00:00", "l3", 1000, 1000, 1000, 1000),
  ]);
  const merges: Merge[] = [
    { sha: "bbb2222", slug: "beta", startedAt: ms("05:00:00"), mergedAt: ms("06:00:00") },
    { sha: "aaa1111", slug: "alpha", startedAt: ms("10:00:00"), mergedAt: ms("11:00:00") },
    { sha: "ccc3333", slug: "alpha", startedAt: ms("11:10:00"), mergedAt: ms("12:00:00") },
  ];
  const out = join(dir, "out.md");

  run(["--last", "1", "--out", out], { merges, projectsDir: dir, mainFolder: "-repo" });
  const md = readFileSync(out, "utf8");

  expect(md).toContain("| alpha | aaa1111, ccc3333 | 35 | 17 | 105 | 3005 | 1 | 2 | 3 | 4 | 36 | 19 | 108 | 3009 | 1.75 | 0.52 | 2.00 | 2 |");
  expect(md).not.toContain("| beta |");
  expect(md).toContain("| lead | 1 | 100 | 200 | 300 | 400 |");
});

test("--specs reports each spec of a repo in cost units: coordination, each ticket, the rest, the total and the coordination share, and the tickets over their warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const folder = "/code/shop".replace(/[^a-zA-Z0-9]/g, "-");
  session(dir, folder, "s1.jsonl", [meta("agent-setting", "agentSetting", "f1rm:step"), meta("agent-name", "agentName", "implement-7"), usage("10:00:00", "a", 0, 1000, 0, 0)]);
  session(dir, folder, "s1/subagents/x.jsonl", [JSON.stringify({ type: "assistant", message: { id: "b", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "git checkout -b ticket-8 spec-7" } }] } }), usage("10:01:00", "b", 0, 3000, 0, 0)]);
  const out = join(dir, "specs.md");
  run(["--specs", "/code/shop", "--out", out], { merges: [], projectsDir: dir, mainFolder: folder });
  const text = readFileSync(out, "utf8");
  expect(text).toContain("| #7 | 5,000 | #8 15,000 | 0 | 20,000 | 25% | none |");
  session(dir, folder, "s1/subagents/y.jsonl", [JSON.stringify({ type: "assistant", message: { id: "c", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git checkout -b ticket-9 spec-7" } }] } }), usage("10:02:00", "c", 0, 0, 0, 4_000_000)]);
  run(["--specs", "/code/shop", "--out", out], { merges: [], projectsDir: dir, mainFolder: folder, sizes: { 9: "s" } });
  expect(readFileSync(out, "utf8")).toContain("| #7 | 5,000 | #8 15,000, #9 400,000 | 0 | 420,000 | 25% | #9 |");
});
