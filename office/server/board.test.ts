// The board seam: the file the guidelines describe, read by the server and pushed with the office.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardFile, MAX_BOARD_BYTES, parseBoard } from "./board.ts";
import { startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const guidelines = readFileSync(join(import.meta.dir, "../../plugin/skills/f1rm-guidelines/SKILL.md"), "utf8");
const example = /## Board format[\s\S]*?```\n(# Board:[\s\S]*?)```/.exec(guidelines)![1];

test("the board example in the guidelines parses into its rows", () => {
  expect(parseBoard(example)).toEqual([
    { id: "T1", owner: "researcher-auth-options", status: "done", branch: "worktree-auth-options", task: "Compare session and token auth" },
    { id: "T2", owner: "backend-dev-auth-api", status: "doing", branch: "worktree-auth-api", task: "Add login endpoint" },
    { id: "T3", owner: "-", status: "todo", branch: "-", task: "Build the login form" },
  ]);
});

test("the board path is the main working directory with every non-alphanumeric as a dash, as the guidelines say", () => {
  expect(guidelines).toContain("not an ASCII letter or digit");
  expect(boardFile("/boards", "/Users/me/my repo/.git")).toBe("/boards/-Users-me-my-repo.md");
  expect(boardFile("/boards", "/Users/me/café.app/.git")).toBe("/boards/-Users-me-caf--app.md");
  expect(boardFile("/boards", "/work/notes")).toBe("/boards/-work-notes.md");
});

test("a hostile board is bounded plain text: no HTML interpretation, clipped cells, capped rows", () => {
  const hostile = [
    "# Board: <script>alert(1)</script>",
    "| id | owner | status | branch | task |",
    "| :- | :- | :- | :- | :- |",
    "| T1 | <img src=x onerror=alert(1)> | DOING | - | <script>alert('x')</script>‮evil | extra |",
    ...Array.from({ length: 500 }, (_, i) => `| T${i + 2} | - | todo | - | ${"A".repeat(5000)} |`),
  ].join("\n");
  const rows = parseBoard(hostile);
  expect(rows.length).toBe(100);
  expect(rows[0]).toEqual({
    id: "T1",
    owner: "<img src=x onerror=alert(1)>",
    status: "doing",
    branch: "-",
    task: "<script>alert('x')</script> evil | extra",
  });
  expect(rows[1].task.length).toBe(200);
  expect(parseBoard("not a board\n| only | three | cells |")).toEqual([]);
});

const SECRET = "s", TOKEN = "t";
let server: ReturnType<typeof startServer>;
let ws: WebSocket;
let dir: string;
afterEach(() => {
  ws?.close();
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const clientDir = mkdtempSync(join(tmpdir(), "f1rm-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html>");

async function officeWithRepo() {
  dir = mkdtempSync(join(tmpdir(), "f1rm-board-"));
  const boardsDir = join(dir, "boards");
  server = startServer({
    port: 0, secret: SECRET, token: TOKEN, clientDir, boardsDir, boardPollMs: 20,
    machine: { gitCommonDir: () => "/code/shop/.git", liveSessions: async () => new Set<string>() } as any,
  });
  await fetch(`http://127.0.0.1:${server.port}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id: "a", cwd: "/code/shop", hook_event_name: "SessionStart" }),
  });
  const seen: OfficeState[] = [];
  ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: `http://127.0.0.1:${server.port}` } } as any);
  ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)));
  const next = (until: (s: OfficeState) => boolean, from = 0) =>
    new Promise<OfficeState>((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const hit = seen.slice(from).find(until);
        if (hit) resolve(hit), clearInterval(tick);
        else if (Date.now() - t0 > 2000) reject(new Error("no matching state")), clearInterval(tick);
      }, 10);
    });
  return { boardsDir, next, seen };
}

test("a missing board is no rows and no error, and an edit reaches the open socket without a reconnect", async () => {
  const { boardsDir, next, seen } = await officeWithRepo();
  const room ="/code/shop/.git";
  const bare = await next((s) => !!s.rooms[room]);
  expect(bare.boards).toEqual({});

  mkdirSync(boardsDir);
  const file = boardFile(boardsDir, room);
  writeFileSync(file, example);
  const first = await next((s) => s.boards?.[room]?.length === 3);
  expect(first.boards![room].map((r) => r.status)).toEqual(["done", "doing", "todo"]);

  writeFileSync(file, example.replace("| T3 | - | todo |", "| T3 | - | blocked |"));
  const edited = await next((s) => s.boards?.[room]?.[2]?.status === "blocked");
  expect(edited.boards![room].length).toBe(3);

  const mark = seen.length;
  rmSync(file);
  await next((s) => Object.keys(s.boards!).length === 0, mark);
});

test("a board bigger than the read cap still yields a bounded state", async () => {
  const { boardsDir, next } = await officeWithRepo();
  mkdirSync(boardsDir);
  const row = `| T1 | - | todo | - | ${"x".repeat(1000)} |\n`;
  writeFileSync(boardFile(boardsDir, "/code/shop/.git"), row.repeat(Math.ceil((MAX_BOARD_BYTES * 4) / row.length)));
  const s = await next((s) => (s.boards?.["/code/shop/.git"]?.length ?? 0) > 0);
  expect(s.boards!["/code/shop/.git"].length).toBeLessThanOrEqual(65);
  expect(JSON.stringify(s).length).toBeLessThan(MAX_BOARD_BYTES * 2);
});
