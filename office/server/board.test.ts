// The board seam: the file the guidelines describe, read by the server and pushed with the office.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardFile, MAX_BOARD_BYTES, openQuestion, teamBoardFile, parseBoard } from "./board.ts";
import { projectFile, readEdition, writeEdition } from "./editions.ts";
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
  const boardsDir = join(dir, "boards"), projectsDir = join(dir, "projects");
  // A door needs a registration, which only `f1rm pm` writes: the shop has one, as if it had run.
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(projectFile(projectsDir, "/code/shop/.git"), "{}\n");
  server = startServer({
    port: 0, secret: SECRET, token: TOKEN, clientDir, boardsDir, projectsDir, boardPollMs: 20,
    machine: { gitCommonDir: () => "/code/shop/.git", isRepo: () => true, liveSessions: async () => new Set<string>() } as any,
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
  return { boardsDir, projectsDir, next, seen };
}

test("a project's edition reaches the office from its file, and the office sets it only to work or founder for a room it knows", async () => {
  const { projectsDir, next } = await officeWithRepo();
  const room = "/code/shop/.git";
  expect((await next((s) => !!s.rooms[room])).editions).toEqual({});
  expect(projectFile(projectsDir, room)).toBe(join(projectsDir, "-code-shop.json"));
  writeEdition(projectFile(projectsDir, room), "founder");
  await next((s) => s.editions?.[room] === "founder");

  const set = (body: object) => fetch(`http://127.0.0.1:${server.port}/${TOKEN}/edition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await set({ room, edition: "work" })).status).toBe(200);
  expect(readEdition(projectFile(projectsDir, room))).toBe("work");
  await next((s) => s.editions?.[room] === "work");
  expect((await set({ room, edition: "startup" })).status).toBe(400);
  expect((await set({ room: "/code/nope", edition: "work" })).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${server.port}/wrong-token/edition`, { method: "POST", body: JSON.stringify({ room, edition: "founder" }) })).status).toBe(401);
  expect(readEdition(projectFile(projectsDir, room))).toBe("work");
});

test("openQuestion reads the line under an 'Open question for the user' heading; the last such heading wins", () => {
  const board = (middle: string) => `# Board: shop / checkout\n\n${middle}\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | - | todo | - | x |\n`;
  expect(openQuestion(board("## Open question for the user\nShip the guest checkout first?"))).toBe("Ship the guest checkout first?");
  expect(openQuestion(board("## Open question for the user\n\n- Ship it first?  \n"))).toBe("Ship it first?");
  expect(openQuestion(board("### open question for the user\n1. Ship A or B? (recommend A)"))).toBe("1. Ship A or B? (recommend A)");
  for (const none of ["none", "None.", "**none**", "`none`", "None (answered 2026-10-23: A)", "N/A", "n/a.", "Nothing.", "(none)", "- none", "No.", "No open question", ""]) expect([none, openQuestion(board(`## Open question for the user\n${none}`))]).toEqual([none, ""]);
  expect(openQuestion(board("## Open question for the user\nNone of these work, which one do you want?"))).toBe("None of these work, which one do you want?");
  expect(openQuestion(board("## Open question for the user\nNo, or should we wait?"))).toBe("No, or should we wait?");
  expect(openQuestion(board("## Open question for the user\nNotes: ship A?"))).toBe("Notes: ship A?");
  expect(openQuestion(board("## Open question for the user\n## Notes\nnot a question"))).toBe("");
  expect(openQuestion(board("## Open question for the user"))).toBe("");
  expect(openQuestion(board("Open questions are tracked elsewhere."))).toBe("");
  expect(openQuestion("")).toBe("");
});

test("openQuestion on the shapes a real team board has: an older bullet, a dated heading, a backticked none", () => {
  // An older answered bullet, then the lead's later heading with a date: the heading's question counts, the bullet does not.
  const older = "- Open question for the user: none.\n\n## Open question for the user (2026-10-22, R9b live proof)\nPick 1 or 2?\n";
  expect(openQuestion(older)).toBe("Pick 1 or 2?");
  // The live heading and its question, then a later log bullet that mentions the heading: the bullet must not take over (round 1's loose heading regex read it as the last one and cleared the tag).
  const logged = "## Open question for the user (2026-10-23)\nShip A or B?\n\n## Log\n- 2026-10-22: Open question for the user: none.\n- Open question for the user answered by the PM.\n  Open question for the user: none\n";
  expect(openQuestion(logged)).toBe("Ship A or B?");
  // A bullet saying a question is open is no heading either.
  expect(openQuestion("- Open question for the user: ship A?\n")).toBe("");
  // The text on the heading's own line is not the question, so answering means replacing the next line.
  expect(openQuestion("## Open question for the user (2026-10-22, R9b)\nPick 1 or 2?\n")).toBe("Pick 1 or 2?");
  expect(openQuestion("## Open question for the user (2026-10-22, R9b)\nnone\n")).toBe("");
  expect(openQuestion("## Open question for the user (2026-10-22, R9b)\n`none`\n")).toBe("");
  // Two headings: the last one is the lead's current state.
  expect(openQuestion("## Open question for the user\nOld question?\n\n## Open question for the user (later)\nnone\n")).toBe("");
  expect(openQuestion("## Open question for the user\nnone\n\n## Open question for the user (later)\nNew question?\n")).toBe("New question?");
});

test("openQuestion is bounded plain text", () => {
  expect(openQuestion(`## Open question for the user\n${"Q".repeat(1000)}‮`).length).toBe(200);
});
