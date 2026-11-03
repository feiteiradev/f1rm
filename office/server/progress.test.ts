// The progress seam: a team's board text plus its desk.md text become one topic's numbers, and the evidence route serves only inside the evidence folder.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFile } from "./editions.ts";
import { evidenceFile, parseDesk, topicProgress } from "./progress.ts";
import { startServer } from "./server.ts";

const board = (...rows: string[]) => ["# Board: t", "| id | owner | status | branch | task |", "| - | - | - | - | - |", ...rows].join("\n");
const row = (id: string, status: string, branch = "-") => `| ${id} | dev | ${status} | ${branch} | do ${id} |`;

test("done over total, stuck from blocked rows, last from the newest desk line, desk lines in file order", () => {
  const b = board(row("T1", "done"), row("T2", "done"), row("T3", "done"), row("T4", "blocked"), row("T5", "todo"));
  const desk = [
    "| 2026-11-03T10:00:00Z | a | shot-a.png | landed a |",
    "| 2026-11-03T12:00:00Z | c | https://example.com/c | landed c |",
    "| 2026-11-03T11:00:00Z | b | none (not visible) | landed b |",
  ].join("\n");
  const t = topicProgress(b, desk);
  expect([t.done, t.total]).toEqual([3, 5]);
  expect(t.stuck).toEqual(["T4 blocked: do T4"]);
  expect(t.last).toEqual({ task: "c", at: "2026-11-03T12:00:00Z" });
  expect(t.desk.map((d) => d.task)).toEqual(["a", "c", "b"]);
  expect(t.desk[0]).toEqual({ task: "a", at: "2026-11-03T10:00:00Z", proof: "shot-a.png", note: "landed a" });
});

test("an empty board and no desk file is zero of zero, no last, nothing stuck", () => {
  expect(topicProgress("", "")).toEqual({ done: 0, total: 0, last: null, stuck: [], desk: [] });
});

test("without a desk file the last landed task is the last done row, with no time", () => {
  const t = topicProgress(board(row("T1", "done", "worktree-effort-flag"), row("T2", "todo")), "");
  expect(t.last).toEqual({ task: "effort-flag", at: null });
});

test("malformed desk lines are skipped, a pipe in the note stays in it, a long cell is clipped", () => {
  const desk = ["not a line", "| only | three | cells |", "| | | | |", "| 2026-11-03 | ok | p.png | a | b |", `| 2026-11-03 | long | p | ${"x".repeat(999)} |`, "|---|---|---|---|"].join("\n");
  const lines = parseDesk(desk);
  expect(lines.map((l) => l.task)).toEqual(["ok", "long"]);
  expect(lines[0].note).toBe("a | b");
  expect(lines[1].note.length).toBeLessThanOrEqual(200);
});

test("a lead's open question counts as stuck, none does not", () => {
  expect(topicProgress(board(row("T1", "todo")) + "\n## Open question for the user\nPick a color?", "").stuck).toEqual(["waits for you: Pick a color?"]);
  expect(topicProgress(board(row("T1", "todo")) + "\n## Open question for the user\nnone", "").stuck).toEqual([]);
});

let dir: string;
let server: ReturnType<typeof startServer> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("evidenceFile returns the real path of a media file inside the root and refuses `..`, absolute paths, links out, non-media files and directories", () => {
  dir = mkdtempSync(join(tmpdir(), "f1rm-ev-"));
  const root = join(dir, "evidence");
  mkdirSync(join(root, "shop", "lead-x"), { recursive: true });
  writeFileSync(join(root, "shop", "lead-x", "shot.png"), "png");
  writeFileSync(join(root, "shop", "lead-x", "desk.md"), "md");
  writeFileSync(join(root, "shop", "page.html"), "<script>");
  writeFileSync(join(dir, "secret.png"), "secret");
  symlinkSync(join(dir, "secret.png"), join(root, "shop", "link.png"));
  symlinkSync(dir, join(root, "shop", "dirlink"));
  // A link inside the root to a non-media file: its own name says png, its target does not.
  symlinkSync(join(root, "shop", "lead-x", "desk.md"), join(root, "shop", "inner.png"));
  // A link inside the root to a media file inside the root is served as the real path.
  symlinkSync(join(root, "shop", "lead-x", "shot.png"), join(root, "shop", "ok.png"));
  expect(evidenceFile(root, "shop/lead-x/shot.png")).toBe(join(realpathSync(root), "shop", "lead-x", "shot.png"));
  expect(evidenceFile(root, "shop/ok.png")).toBe(join(realpathSync(root), "shop", "lead-x", "shot.png"));
  for (const bad of ["../secret.png", "shop/../../secret.png", "/etc/passwd", "shop/link.png", "shop/dirlink/secret.png", "shop/inner.png", "shop/lead-x/desk.md", "shop/page.html", "shop/lead-x", "shop/missing.png", ""]) expect(evidenceFile(root, bad), bad).toBeNull();
});

test("the route serves a known project's proof behind the token and origin gate, and refuses another repo, non-media files, links out and encoded traversal", async () => {
  dir = mkdtempSync(join(tmpdir(), "f1rm-ev-"));
  const root = join(dir, "evidence"), projectsDir = join(dir, "projects");
  mkdirSync(join(root, "shop"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  mkdirSync(projectsDir);
  writeFileSync(projectFile(projectsDir, "/code/shop/.git"), "{}\n");
  writeFileSync(join(root, "shop", "shot.png"), "png");
  writeFileSync(join(root, "shop", "clip.mp4"), "mp4");
  writeFileSync(join(root, "shop", "desk.md"), "md");
  writeFileSync(join(root, "shop", "page.html"), "<script>");
  writeFileSync(join(root, "other", "theirs.png"), "theirs");
  // The target of `..%2f..%2f` from inside shop: it exists, outside the root.
  writeFileSync(join(dir, "secret.png"), "secret");
  symlinkSync(join(dir, "secret.png"), join(root, "shop", "link.png"));
  symlinkSync(dir, join(root, "shop", "dirlink"));
  const clientDir = mkdtempSync(join(dir, "client-"));
  writeFileSync(join(clientDir, "index.html"), "<!doctype html>");
  server = startServer({ port: 0, secret: "s", token: "t", clientDir, evidenceDir: root, projectsDir, machine: { gitCommonDir: () => "/code/shop/.git", isRepo: () => true, liveSessions: async () => new Set<string>() } as any });
  const base = `http://127.0.0.1:${server.port}`;
  await fetch(`${base}/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-f1rm-secret": "s" }, body: JSON.stringify({ session_id: "a", cwd: "/code/shop", hook_event_name: "SessionStart" }) });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: "manual" });
  const ok = await get("/t/evidence/shop/shot.png");
  expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, "image/png", "png"]);
  expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await get("/t/evidence/shop/clip.mp4")).headers.get("content-type")).toBe("video/mp4");
  for (const bad of ["other/theirs.png", "shop/desk.md", "shop/page.html", "shop/link.png", "shop/dirlink/secret.png", "shop/..%2f..%2fsecret.png", "shop/%2e%2e/%2e%2e/secret.png", "%2fetc%2fpasswd", "shop/missing.png", "shop"]) {
    expect((await get(`/t/evidence/${bad}`)).status, bad).toBe(404);
  }
  expect((await get("/x/evidence/shop/shot.png")).status).toBe(401);
  expect((await get("/t/evidence/shop/shot.png", { origin: "http://evil.example" })).status).toBe(403);
});

test("the snapshot carries each team board of the room with its desk lines, even after its lead is gone", async () => {
  dir = mkdtempSync(join(tmpdir(), "f1rm-ev-"));
  const boardsDir = join(dir, "boards"), projectsDir = join(dir, "projects"), root = join(dir, "evidence");
  mkdirSync(boardsDir);
  mkdirSync(projectsDir);
  mkdirSync(join(root, "shop", "lead-checkout"), { recursive: true });
  writeFileSync(join(boardsDir, "-code-shop.team.checkout.md"), board(row("T1", "done"), row("T2", "blocked")));
  writeFileSync(join(root, "shop", "lead-checkout", "desk.md"), "| 2026-11-03T10:00:00Z | cart | cart.png | the cart lands |\n");
  const clientDir = mkdtempSync(join(dir, "client-"));
  writeFileSync(join(clientDir, "index.html"), "<!doctype html>");
  writeFileSync(projectFile(projectsDir, "/code/shop/.git"), "{}\n");
  server = startServer({ port: 0, secret: "s", token: "t", clientDir, boardsDir, evidenceDir: root, projectsDir, boardPollMs: 20, machine: { gitCommonDir: () => "/code/shop/.git", isRepo: () => true, liveSessions: async () => new Set<string>() } as any });
  await fetch(`http://127.0.0.1:${server.port}/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-f1rm-secret": "s" }, body: JSON.stringify({ session_id: "a", cwd: "/code/shop", hook_event_name: "SessionStart" }) });
  const seen: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/t/ws`, { headers: { origin: `http://127.0.0.1:${server.port}` } } as any);
  ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)));
  const t0 = Date.now();
  while (!seen.some((s) => s.topics?.["/code/shop/.git"]) && Date.now() - t0 < 3000) await Bun.sleep(20);
  ws.close();
  const [topic] = seen.findLast((s) => s.topics?.["/code/shop/.git"]).topics["/code/shop/.git"];
  expect(topic).toMatchObject({ team: "checkout", done: 1, total: 2, stuck: ["T2 blocked: do T2"], last: { task: "cart", at: "2026-11-03T10:00:00Z" } });
  expect(topic.desk[0].proof).toBe("cart.png");
});
