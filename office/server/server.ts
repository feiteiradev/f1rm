// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { emptyOffice, normalize, reduce, sweep, type Employee, type F1rmEvent, type Room } from "./office.ts";
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

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
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
          server.publish("office", JSON.stringify(state));
        }
        return new Response(null, { status: 200 });
      }
      // Everything for the browser lives under /<ui token>/, so every request carries the token.
      const [, given, ...rest] = url.pathname.split("/");
      if (!same(given, token)) return new Response("unauthorized", { status: 401 });
      if (rest.length === 0) return new Response(null, { status: 307, headers: { location: `/${given}/` } });
      const path = rest.join("/");
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
        ws.send(JSON.stringify(state));
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
      const next = sweep(state, clock(), timeouts, lastActive, alive);
      if (next !== state) {
        state = next;
        server.publish("office", JSON.stringify(state));
      }
    } finally {
      sweeping = false;
    }
  }
  void sweepOnce();
  const timer = setInterval(sweepOnce, Math.min(15_000, offlineAfterMs / 4));
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    clearInterval(timer);
    await stop(closeActiveConnections);
    db.close();
  };
  return server;
}
