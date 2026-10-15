// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { createBroker, DEFAULT_TIMEOUT_S, DENY_MESSAGE } from "./approvals.ts";
import { boardFile, readBoard, type BoardRow } from "./board.ts";
import { emptyOffice, normalize, reduce, sweep, type Employee, type F1rmEvent, type Room } from "./office.ts";
import { askStream, MAX_QUESTION } from "./ask.ts";
import { jump } from "./jump.ts";
import { MAX_MESSAGE, tell } from "./tell.ts";
import type { machine as realMachine } from "./machine.ts";

type Options = {
  port: number;
  secret: string;
  token: string;
  machine: typeof realMachine;
  /** The built browser client. */
  clientDir: string;
  /** SQLite file for the append-only event log; the office is rebuilt from it on start. */
  dbPath?: string;
  /** Where the PM's board files live; without it no room has a board. */
  boardsDir?: string;
  /** How often the board files are checked for edits. */
  boardPollMs?: number;
  /** How long a PermissionRequest hook is held for the browser before the terminal prompt decides. */
  approvalTimeoutMs?: number;
  /** Time source in ms; tests control it. */
  clock?: () => number;
  /** Quiet this long (no event, no transcript write) and an employee goes offline. */
  offlineAfterMs?: number;
  /** Quiet this long and an employee leaves the office. */
  removeAfterMs?: number;
};

// A stat and never a parse: the transcript format isn't a public contract, and its mtime is all liveness needs.
const transcriptMtime = (path?: string) => {
  try {
    return path ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
};

/** Constant-time credential check. */
function same(given: string | null | undefined, expected: string) {
  const a = Buffer.from(given ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer({
  port, secret, token, machine, clientDir,
  dbPath = ":memory:",
  boardsDir,
  boardPollMs = 500,
  approvalTimeoutMs = DEFAULT_TIMEOUT_S * 1000,
  clock = Date.now,
  offlineAfterMs = 5 * 60_000,
  removeAfterMs = 15 * 60_000,
}: Options) {
  clientDir = resolve(clientDir);

  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  const append = db.prepare("INSERT INTO events (at, event) VALUES (?, ?)");

  // ponytail: replays the whole log on every start; add snapshots or pruning when startup gets slow.
  let state = emptyOffice();
  for (const row of db.query("SELECT event FROM events ORDER BY id").all() as { event: string }[]) {
    try {
      state = reduce(state, JSON.parse(row.event));
    } catch {} // a row this build can't read must not stop the office from starting
  }

  // ponytail: cached per cwd for the server's lifetime; a folder that later gets `git init` needs a restart.
  const rooms = new Map<string, Room>();
  const roomOf = (cwd: string): Room => {
    let room = rooms.get(cwd);
    if (!room) {
      const common = machine.gitCommonDir(cwd);
      // A repo's room is its git common dir, so worktrees share it; a non-git folder is its own room.
      room = common
        ? { id: common, name: basename(basename(common) === ".git" ? dirname(common) : common).replace(/\.git$/, "") }
        : { id: cwd, name: basename(cwd) || cwd };
      rooms.set(cwd, room);
    }
    return room;
  };

  const employeeOf = (id: string) => (Object.hasOwn(state.employees, id) ? state.employees[id] : undefined);

  let boards: Record<string, BoardRow[]> = {};
  const approvals = createBroker(approvalTimeoutMs, () => push());
  const snapshot = () => JSON.stringify({ ...state, boards, approvals: approvals.list() });
  const push = () => server.publish("office", snapshot());

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // The fork can be silent for a while (starting up, reading files) before its first words.
    idleTimeout: 120,
    async fetch(req, server) {
      await ready;
      // Host defeats DNS rebinding; Origin defeats other sites (hooks send none).
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const origin = req.headers.get("origin");
      if (!hosts.includes(req.headers.get("host") ?? "") || (origin !== null && !hosts.some((h) => origin === `http://${h}`))) {
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ingest" && req.method === "POST") {
        if (!same(req.headers.get("x-f1rm-secret"), secret)) return new Response("unauthorized", { status: 401 });
        const payload = await req.json().catch(() => null);
        const event = normalize(payload, req.headers, roomOf, clock());
        if (event) {
          append.run(event.at, JSON.stringify(event));
          state = reduce(state, event);
          // Any later event means the session moved on, except the notification about the very prompt being held.
          if (!event.kind.startsWith("Notification/")) approvals.release(event.sessionId);
          push();
          if (event.kind === "PermissionRequest") {
            server.timeout(req, 0); // the hold outlasts the idle timeout
            const decision = await approvals.hold(event.sessionId, String(payload.tool_name ?? ""), payload.tool_input, event.at, req.signal);
            if (decision) return Response.json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
          }
        }
        return new Response(null, { status: 200 });
      }
      // Everything for the browser lives under /<ui token>/, so every request carries the token.
      const [, given, ...rest] = url.pathname.split("/");
      if (!same(given, token)) return new Response("unauthorized", { status: 401 });
      if (rest.length === 0) return new Response(null, { status: 307, headers: { location: `/${given}/` } });
      const path = rest.join("/");
      if (rest[0] === "jump" && rest.length === 2) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const result = await jump(machine, employee);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if ((rest[0] === "approve" || rest[0] === "deny") && rest.length === 2) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const decided = approvals.answer(rest[1], rest[0] === "approve" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE });
        return decided
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "That request is no longer waiting; the terminal has it." }, { status: 404 });
      }
      if (rest[0] === "ask" && rest.length === 2) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ error: "No such employee." }, { status: 404 });
        const question = ((await req.json().catch(() => null)) as { question?: unknown } | null)?.question;
        if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
          return Response.json({ error: `Ask a question of 1 to ${MAX_QUESTION} characters.` }, { status: 400 });
        }
        return new Response(askStream(machine, employee, question.trim()), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }
      if (rest[0] === "tell" && rest.length === 2) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const message = ((await req.json().catch(() => null)) as { message?: unknown } | null)?.message;
        if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) {
          return Response.json({ ok: false, error: `Tell a message of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
        }
        const result = await tell(machine, employee, message.trim());
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if (path === "ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      const file = resolve(clientDir, path || "index.html");
      if (!file.startsWith(clientDir + sep) || !(await Bun.file(file).exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file));
    },
    websocket: {
      open(ws) {
        ws.subscribe("office");
        ws.send(snapshot());
      },
      message() {},
    },
  });

  const timeouts = { offlineAfter: offlineAfterMs, removeAfter: removeAfterMs };
  const lastActive = (e: Employee) => Math.max(e.lastEventAt, transcriptMtime(e.transcript));
  let sweeping = false;
  async function sweepOnce() {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = clock();
      // ponytail: asks `claude agents --json` on every tick while anyone is quiet; cache it if that gets heavy.
      const quiet = Object.values(state.employees).some((e) => now - lastActive(e) >= offlineAfterMs);
      const alive = quiet ? await machine.liveSessions() : new Set<string>();
      if (!alive) return;
      const next = sweep(state, clock(), timeouts, lastActive, alive);
      if (next !== state) {
        // Replay must see the same departures, or a dead session keeps its name and the next arrival is renamed.
        for (const e of Object.values(state.employees)) {
          if (next.employees[e.sessionId]) continue;
          const gone: F1rmEvent = { sessionId: e.sessionId, kind: "SessionEnd", cwd: e.cwd, room: state.rooms[e.room], terminal: e.terminal, at: clock() };
          append.run(gone.at, JSON.stringify(gone));
        }
        state = next;
        push();
      }
    } finally {
      sweeping = false;
    }
  }
  // ponytail: polls and rereads each room's board every tick; swap in fs.watch if many rooms make that heavy.
  let reading = false;
  async function readBoards() {
    if (!boardsDir || reading) return;
    reading = true;
    try {
      const next: Record<string, BoardRow[]> = {};
      for (const id of Object.keys(state.rooms)) {
        const rows = await readBoard(boardFile(boardsDir, id));
        if (rows.length) next[id] = rows;
      }
      if (JSON.stringify(next) !== JSON.stringify(boards)) {
        boards = next;
        push();
      }
    } finally {
      reading = false;
    }
  }
  const ready = Promise.all([sweepOnce(), readBoards()]);
  const timer = setInterval(sweepOnce, Math.min(15_000, offlineAfterMs / 4));
  const boardTimer = setInterval(readBoards, boardPollMs);
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    clearInterval(timer);
    clearInterval(boardTimer);
    approvals.releaseAll();
    await stop(closeActiveConnections);
    db.close();
  };
  return server;
}
