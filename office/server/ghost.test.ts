// Seam 1: the event log, the ghost sweep and restart recovery, on a controllable clock.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRuns, startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const OFFLINE_AFTER = 1000;
const REMOVE_AFTER = 3000;

const dir = mkdtempSync(join(tmpdir(), "f1rm-ghost-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let now = 0;
let alive: Map<string, number | undefined> | null = new Map();
// The pids that no longer run, and the pids the check asked about.
let dead = new Set<number>();
let asked: number[] = [];
let gate: Promise<unknown> = Promise.resolve();
// What the next listing answers instead of `alive`, once.
let once: Map<string, number | undefined> | null | undefined;
const fakeMachine = () => ({
  gitCommonDir: (cwd: string) => `${cwd}/.git`,
  liveSessions: async () => {
    await gate;
    const answer = once === undefined ? alive : once;
    once = undefined;
    return answer;
  },
  backgroundId: async () => null,
  letGo: async () => {},
  sessions: async () => [],
  mergedBranch: () => false,
  removeWorktree: () => {},
  focusIterm: async () => false,
  attachInIterm: async () => {},
  openVsCode: async () => {},
  askFork: async function* () {},
  tell: async () => {},
  workingHires: async () => 0,
  backgroundSessions: async () => [],
  spawnBackground: async () => "",
  startPmInIterm: async () => {},
});

let servers: ReturnType<typeof startServer>[] = [];
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  servers.forEach((s) => s.stop(true));
  servers = [];
  gate = Promise.resolve();
  once = undefined;
  alive = new Map();
  dead = new Set();
  asked = [];
});

let dbN = 0;

function start(dbPath = join(dir, `events-${dbN++}.db`)) {
  const server = startServer({
    port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir: dir,
    dbPath, clock: () => now, offlineAfterMs: OFFLINE_AFTER, removeAfterMs: REMOVE_AFTER,
    isAlive: (pid) => (asked.push(pid), !dead.has(pid)),
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
  alive = new Map();
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
  alive = new Map([["listed", undefined]]);
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
  alive = new Map([["running", undefined]]);
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

  alive = new Map();
  await office(server, (s) => ids(s).length === 0);
});

test("an offline employee that claude agents lists again is idle, not offline", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "back", "PreToolUse", bash("sleep 99"));

  now += 1500;
  await office(server, (s) => s.employees.back?.status === "offline");

  alive = new Map([["back", undefined]]);
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
  const { name } = (await office(first.server, (s) => "agent-1" in s.interns)).employees.boss;
  first.server.stop(true);

  const second = start(first.dbPath);
  const restored = await office(second.server, (s) => "agent-1" in s.interns);
  expect(restored.employees.boss).toMatchObject({ role: "designer", name, title: "login" });
  expect(restored.interns["agent-1"].parent).toBe("boss");

  now += 1500;
  const quiet = await office(second.server, (s) => s.employees.boss?.status === "offline");
  expect(quiet.interns).toEqual({});
});

test("a swept session frees its name for good: the Designer who replaced it keeps its name after a restart", async () => {
  now = 1_000_000;
  const first = start();
  await hook(first.server, "old", "SessionStart", { agent_type: "f1rm:designer" });
  now += 3500;
  await office(first.server, (s) => ids(s).length === 0);
  await hook(first.server, "new", "SessionStart", { agent_type: "f1rm:designer" });
  const before = await office(first.server, (s) => ids(s).join() === "new");
  first.server.stop(true);

  const second = start(first.dbPath);
  const after = await office(second.server, (s) => ids(s).join() === "new");
  expect(after.employees.new.name).toBe(before.employees.new.name);
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

test("a session whose process died without SessionEnd leaves within a tick, long before it is quiet; the others stay", async () => {
  now = 1_000_000;
  alive = new Map([["dead", 4242], ["running", 4243]]);
  dead = new Set([4242]);
  const first = start();
  await hook(first.server, "dead", "PreToolUse", bash("npm test"));
  await hook(first.server, "running", "PreToolUse", bash("npm test"));
  const state = await office(first.server, (s) => ids(s).join() === "running");
  expect(state.employees.running.status).toBe("working");
  first.server.stop(true);

  // The departure is in the log, so a restart does not bring the ghost back or hand its name to another.
  const second = start(first.dbPath);
  await office(second.server, (s) => ids(s).join() === "running");
});

test("a session claude agents never listed keeps the quiet path: offline after the first timeout, gone after the second, and no process is asked", async () => {
  now = 1_000_000;
  dead = new Set([1]);
  const { server } = start();
  await hook(server, "unlisted", "PreToolUse", bash("sleep 99"));

  await new Promise((r) => setTimeout(r, 700));
  expect(ids(await office(server, (s) => ids(s).length > 0))).toEqual(["unlisted"]);

  now += 1500;
  await office(server, (s) => s.employees.unlisted?.status === "offline");
  now += 2000;
  await office(server, (s) => ids(s).length === 0);
  expect(asked).toEqual([]);
});

test("a session that is listed and quiet is not taken for gone while its process runs", async () => {
  now = 1_000_000;
  alive = new Map([["quiet", 4242]]);
  const { server } = start();
  await hook(server, "quiet", "PreToolUse", bash("sleep 99"));
  await new Promise((r) => setTimeout(r, 700));

  now += 5000;
  await new Promise((r) => setTimeout(r, 700));
  expect(ids(await office(server, (s) => ids(s).length > 0))).toEqual(["quiet"]);
  expect(asked).toContain(4242);
});

test("a session resumed under its old id is not removed for the pid its dead process had", async () => {
  now = 1_000_000;
  alive = new Map([["resumed", 11]]);
  const { server } = start();
  await hook(server, "resumed", "PreToolUse", bash("ls"));
  while (!asked.includes(11)) await new Promise((r) => setTimeout(r, 50));

  await hook(server, "resumed", "SessionStart", { source: "resume" });
  dead = new Set([11]);
  alive = new Map([["resumed", 20]]);
  await new Promise((r) => setTimeout(r, 700));
  expect(ids(await office(server, (s) => ids(s).length > 0))).toEqual(["resumed"]);
  expect(asked).toContain(20);
});

test("a process that cannot be asked about is not taken for dead: only ESRCH ends a session", () => {
  // Bun throws ERR_INVALID_ARG_TYPE, not ESRCH, for a pid beyond 2^31.
  expect(processRuns(2 ** 31)).toBe(true);
});

test("pid 0 and -1 are no process: they would signal whole groups, so they are never signalled", () => {
  const kill = spyOn(process, "kill");
  try {
    expect([0, -1, 1.5, NaN].map(processRuns)).toEqual([false, false, false, false]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

test("a listing already under way when a session resumes does not give it back the pid its dead process had", async () => {
  now = 1_000_000;
  const { server } = start();
  let release!: () => void;
  gate = new Promise((r) => (release = () => r(null)));
  once = new Map([["resumed", 11]]);
  alive = new Map([["resumed", 20]]);
  dead = new Set([11]);
  await hook(server, "resumed", "PreToolUse", bash("ls"));
  await new Promise((r) => setTimeout(r, 400)); // a check is now waiting on claude agents

  await hook(server, "resumed", "SessionStart", { source: "resume" });
  release();
  await new Promise((r) => setTimeout(r, 700));
  expect(ids(await office(server, (s) => ids(s).length > 0))).toEqual(["resumed"]);
  expect(asked).toContain(20);
  expect(asked).not.toContain(11);
});
