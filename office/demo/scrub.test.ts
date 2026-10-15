// The scrub step against a hostile log: secrets, home paths, private titles and fields it was never told about.
import { expect, test } from "bun:test";
import type { F1rmEvent } from "../server/office.ts";
import { scrub } from "./scrub.ts";

const KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HOSTILE = [
  KEY,
  "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  "AKIAIOSFODNN7EXAMPLE",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  "hunter2hunter2",
  "/Users/pedro",
  "/home/pedro",
  "C:\\Users\\pedro",
  "secret-client",
  "Acme",
  "payroll",
  "w0t1p0:7F3A1E2B-0000-4444-8888-ABCDEF012345",
  "transcript.jsonl",
  "what is my salary",
];

const base = { cwd: "/Users/pedro/code/secret-client", room: { id: "/Users/pedro/code/secret-client/.git", name: "secret-client" }, terminal: {} };
const hostile = [
  { ...base, sessionId: "real-uuid-1", kind: "UserPromptSubmit", at: 5_000, activity: "Thinking", tool: "",
    terminal: { itermSessionId: "w0t1p0:7F3A1E2B-0000-4444-8888-ABCDEF012345", termProgram: "iTerm.app" },
    transcript: "/Users/pedro/.claude/projects/-Users-pedro-code-secret-client/transcript.jsonl",
    prompt: "what is my salary at Acme payroll", title: "fix payroll for Acme layoffs" },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 6_000, tool: "Bash",
    activity: `Bash: curl -H "Authorization: Bearer ${KEY}" https://internal.acme.test/payroll`, tool_input: { command: `echo password=hunter2hunter2` } },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 7_000, tool: "Bash", activity: "Bash: API_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz make" },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 8_000, tool: "Read", activity: "Read id_rsa" },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 9_000, tool: "Read", activity: `Read ${KEY}.txt` },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 10_000, tool: "WebSearch", activity: "WebSearch acme layoffs list" },
  { ...base, sessionId: "real-uuid-1", kind: "PreToolUse", at: 11_000, tool: "Grep", activity: "Grep AKIAIOSFODNN7EXAMPLE" },
  { ...base, sessionId: "real-uuid-1", kind: "Notification/hunter2hunter2", at: 12_000 },
  { ...base, sessionId: "real-uuid-1", kind: "SubagentStart", at: 13_000, intern: { id: "agent-uuid", type: "acme-payroll-auditor" } },
  { ...base, sessionId: "real-uuid-2", kind: "PreToolUse", at: 14_000, tool: "Edit", activity: "Edit app.ts",
    cwd: "/home/pedro/code/secret-client/.claude/worktrees/fix-acme-payroll", role: "backend" },
  { ...base, sessionId: "real-uuid-3", kind: "Stop", at: 15_000, activity: "",
    cwd: "C:\\Users\\pedro\\notes", room: { id: "C:\\Users\\pedro\\notes", name: "notes" } },
] as unknown as F1rmEvent[];

test("a hostile log comes out without a prompt, secret, home path or private name", () => {
  const out = scrub(hostile);
  const json = JSON.stringify(out);
  for (const needle of HOSTILE) expect(json).not.toContain(needle);

  const activities = out.map((e) => e.activity);
  expect(activities).toEqual(["Thinking", "Bash: curl", "Bash", "Read id_rsa", "Read", "WebSearch", "Grep", undefined, "Edit app.ts", ""]);
  expect(out.map((e) => e.kind)).not.toContain("Notification/hunter2hunter2");
  expect(out.map((e) => e.at)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 9000, 10000]);
});

test("rooms, sessions and worktrees are renamed consistently; kept names and titles survive", () => {
  const out = scrub(hostile, { keep: ["notes"] });
  expect(out.map((e) => [e.sessionId, e.room.name, e.cwd])).toEqual([
    ...Array(8).fill(["session-1", "project-1", "/home/demo/project-1"]),
    ["session-2", "project-1", "/home/demo/project-1/.claude/worktrees/task-1"],
    ["session-3", "notes", "/home/demo/notes"],
  ]);
  expect(out[8].room.id).toBe("/home/demo/project-1/.git");
  expect(out[8].role).toBe("backend");
  expect(out[0].terminal).toEqual({ termProgram: "iTerm.app" });
  expect(out[7].intern).toEqual({ id: "agent-1", type: "" });
});

test("a title is kept only when it is vouched for", () => {
  expect(scrub(hostile)[0].title).toBeUndefined();
  const [kept] = scrub([{ ...hostile[0], title: "landing page" }], { keep: ["landing page"] });
  expect(kept.title).toBe("landing page");
});

test("a vouched-for name that looks like a secret stops the scrub", () => {
  const leaky = { ...hostile[0], room: { id: "/x/.git", name: KEY } } as F1rmEvent;
  expect(() => scrub([leaky], { keep: [KEY] })).toThrow("looks private");
});
