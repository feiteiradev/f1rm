// Seam 1: the event log, the ghost sweep and restart recovery, on a controllable clock.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const OFFLINE_AFTER = 1000;
const REMOVE_AFTER = 3000;

const dir = mkdtempSync(join(tmpdir(), "f1rm-ghost-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let now = 0;
let alive: Set<string> | null = new Set();
let gate: Promise<unknown> = Promise.resolve();
const fakeMachine = () => ({
  gitCommonDir: (cwd: string) => `${cwd}/.git`,
  liveSessions: async () => {
    await gate;
    return alive;
  },
  backgroundId: async () => null,
  focusIterm: async () => false,
  attachInIterm: async () => {},
  openVsCode: async () => {},
  askFork: async function* () {},
  tell: async () => {},
  workingHires: async () => 0,
  spawnBackground: async () => "",
});

let servers: ReturnType<typeof startServer>[] = [];
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  servers.forEach((s) => s.stop(true));
  servers = [];
  gate = Promise.resolve();
  alive = new Set();
});

let dbN = 0;

function start(dbPath = join(dir, `events-${dbN++}.db`)) {
  const server = startServer({
    port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir: dir,
    dbPath, clock: () => now, offlineAfterMs: OFFLINE_AFTER, removeAfterMs: REMOVE_AFTER,
  });
  servers.push(server);
  return { server, dbPath };
}

function hook(server: { port?: number }, session_id: string, hook_event_name: string, extra: object = {}) {
  return fetch(`http://127.0.0.1:${server.port}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, hook_event_name, cwd: "/code/shop", transcript_path: join(dir, `${session_id}.jsonl`), ...extra }),
  });
}
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

function office(server: { port?: number }, until: (s: OfficeState) => boolean, timeout = 2000) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, {
    headers: { origin: `http://127.0.0.1:${server.port}` },
  } as any);
  sockets.push(ws);
  return new Promise<OfficeState>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no matching state within " + timeout + "ms")), timeout);
    ws.onmessage = (m) => {
      const state = JSON.parse(String(m.data)) as OfficeState;
      if (until(state)) {
        clearTimeout(timer);
        resolve(state);
      }
    };
  });
}

const touchTranscript = (session: string, at: number) => {
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, '{"type":"user"}\n');
  utimesSync(path, at / 1000, at / 1000);
};

const ids = (s: OfficeState) => Object.keys(s.employees).sort();

test("every event is appended to a SQLite log, in order", async () => {
  now = 1_000_000;
  const { server, dbPath } = start();
  await hook(server, "s1", "SessionStart");
  await hook(server, "s1", "PreToolUse", bash("ls"));
  await hook(server, "s1", "PreToolUse", bash("ls"));

  const rows = new Database(dbPath, { readonly: true }).query("SELECT json_extract(event, '$.kind') AS kind FROM events ORDER BY id").all();
  expect(rows).toEqual([{ kind: "SessionStart" }, { kind: "PreToolUse" }, { kind: "PreToolUse" }]);
});

test("an employee goes offline, then leaves, after the timeouts; a transcript change defers it", async () => {
  now = 1_000_000;
  alive = new Set();
  const { server } = start();
  await hook(server, "quiet", "PreToolUse", bash("sleep 99"));
  await hook(server, "writing", "PreToolUse", bash("sleep 99"));
  touchTranscript("quiet", now);
  touchTranscript("writing", now + 900);

  now += 1500;
  const offline = await office(server, (s) => s.employees.quiet?.status === "offline");
  expect(offline.employees.writing.status).toBe("working");

  now += 700;
  await office(server, (s) => s.employees.writing?.status === "offline");

  now += 1400;
  const gone = await office(server, (s) => !("quiet" in s.employees));
  expect(ids(gone)).toEqual(["writing"]);

  now += 1000;
  await office(server, (s) => ids(s).length === 0);
});

test("a killed terminal and a claude -p run leave no ghost; a session claude still lists stays", async () => {
  now = 1_000_000;
  alive = new Set(["listed"]);
  const { server } = start();
  await hook(server, "killed", "SessionStart");
  await hook(server, "killed", "PreToolUse", bash("npm test"));
  await hook(server, "headless", "SessionStart");
  await hook(server, "headless", "UserPromptSubmit", { prompt: "summarize" });
  await hook(server, "headless", "Stop");
  await hook(server, "listed", "PreToolUse", bash("make build"));
  await office(server, (s) => ids(s).length === 3);

  now += 3500;
  await hook(server, "chatty", "PreToolUse", bash("ls"));
  const state = await office(server, (s) => ids(s).join() === "chatty,listed");
  expect(state.employees.listed.status).toBe("working");
  expect(state.employees.chatty.status).toBe("working");
});

test("a restarted server restores the sessions that are still running", async () => {
  now = 1_000_000;
  alive = new Set(["running"]);
  const first = start();
  await hook(first.server, "running", "PreToolUse", bash("make build"));
  await hook(first.server, "recent", "PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/code/shop/a.ts" } });
  await hook(first.server, "ended", "SessionStart");
  await hook(first.server, "ended", "SessionEnd");
  first.server.stop(true);

  now += 100;
  const second = start(first.dbPath);
  const restored = await office(second.server, (s) => ids(s).length === 2);
  expect(ids(restored)).toEqual(["recent", "running"]);
  expect(restored.employees.recent).toMatchObject({ status: "working", activity: "Edit a.ts", room: "/code/shop/.git" });
  expect(restored.employees.running.activity).toBe("Bash: make build");
  second.server.stop(true);

  now += 5000;
  const third = start(first.dbPath);
  const later = await office(third.server, (s) => ids(s).join() === "running");
  expect(later.employees.running).toMatchObject({ status: "working", activity: "Bash: make build" });
});

test("a failing claude agents skips the sweep: quiet sessions stay until it answers", async () => {
  now = 1_000_000;
  alive = null;
  const { server } = start();
  await hook(server, "quiet", "PreToolUse", bash("sleep 99"));

  now += 5000;
  await new Promise((r) => setTimeout(r, 700));
  const kept = await office(server, (s) => ids(s).length > 0);
  expect(kept.employees.quiet.status).toBe("working");

  alive = new Set();
  await office(server, (s) => ids(s).length === 0);
});

test("an offline employee that claude agents lists again is idle, not offline", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "back", "PreToolUse", bash("sleep 99"));

  now += 1500;
  await office(server, (s) => s.employees.back?.status === "offline");

  alive = new Set(["back"]);
  const state = await office(server, (s) => s.employees.back?.status === "idle");
  expect(state.employees.back.status).toBe("idle");
});

test("an event for an offline employee brings it back idle", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "away", "PreToolUse", bash("sleep 99"));

  now += 1500;
  await office(server, (s) => s.employees.away?.status === "offline");

  await hook(server, "away", "CwdChanged", { cwd: "/code/shop/app" });
  const state = await office(server, (s) => s.employees.away?.cwd === "/code/shop/app");
  expect(state.employees.away.status).toBe("idle");
});

test("interns and names survive a restart, and interns leave when their parent goes quiet", async () => {
  now = 1_000_000;
  const first = start();
  await hook(first.server, "boss", "SessionStart", { agent_type: "f1rm:designer", session_title: "login" });
  await hook(first.server, "boss", "SubagentStart", { agent_id: "agent-1", agent_type: "Explore" });
  first.server.stop(true);

  const second = start(first.dbPath);
  const restored = await office(second.server, (s) => "agent-1" in s.interns);
  expect(restored.employees.boss).toMatchObject({ role: "designer", name: "Maya", title: "login" });
  expect(restored.interns["agent-1"].parent).toBe("boss");

  now += 1500;
  const quiet = await office(second.server, (s) => s.employees.boss?.status === "offline");
  expect(quiet.interns).toEqual({});
});

test("a swept session frees its name for good: the Designer who replaced it is still Maya after a restart", async () => {
  now = 1_000_000;
  const first = start();
  await hook(first.server, "old", "SessionStart", { agent_type: "f1rm:designer" });
  now += 3500;
  await office(first.server, (s) => ids(s).length === 0);
  await hook(first.server, "new", "SessionStart", { agent_type: "f1rm:designer" });
  const before = await office(first.server, (s) => ids(s).join() === "new");
  expect(before.employees.new.name).toBe("Maya");
  first.server.stop(true);

  const second = start(first.dbPath);
  const after = await office(second.server, (s) => ids(s).join() === "new");
  expect(after.employees.new.name).toBe("Maya");
});

test("a restarted server answers nothing until its first sweep has dropped the ghosts", async () => {
  now = 1_000_000;
  const first = start();
  await hook(first.server, "ghost", "PreToolUse", bash("npm test"));
  first.server.stop(true);

  now += 1500;
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const second = start(first.dbPath);
  const states: OfficeState[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${second.server.port}/${TOKEN}/ws`, {
    headers: { origin: `http://127.0.0.1:${second.server.port}` },
  } as any);
  sockets.push(ws);
  ws.onmessage = (m) => states.push(JSON.parse(String(m.data)));
  await new Promise((r) => setTimeout(r, 300));
  expect(states).toEqual([]);

  release();
  await new Promise((r) => (ws.onmessage = (m) => { states.push(JSON.parse(String(m.data))); r(null); }));
  expect(states[0].employees.ghost.status).toBe("offline");
});
