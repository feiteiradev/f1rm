// Seam 1: what the office says a session is doing, on a controllable clock and a controllable `claude agents` listing.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFile } from "./editions.ts";
import { startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const HOT_MS = 90_000;
const TICK = 350; // the process check runs every offlineAfter / 4 = 100 ms; a few ticks pass

const dir = mkdtempSync(join(tmpdir(), "f1rm-honest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let now = 0;
// What `claude agents --json` lists (session id -> pid), the status it gives each, and whether it can answer at all.
let listed = new Map<string, number | undefined>();
let statuses: Record<string, "busy" | "idle"> = {};
const machine = () => ({
  gitCommonDir: (cwd: string) => `${cwd}/.git`,
  isRepo: () => true,
  liveSessions: async () => new Map([...listed].map(([id, pid]) => [id, { ...(pid !== undefined && { pid }), ...(statuses[id] && { status: statuses[id] }) }])),
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
  listed = new Map();
  statuses = {};
});

let dbN = 0;
function start(dbPath = join(dir, `events-${dbN++}.db`)) {
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(projectFile(projectsDir, "/code/shop/.git"), "{}\n");
  // The transcripts are written in real time, far after the injected clock, so the quiet sweep never takes a session offline: only the status rule is under test.
  const server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: machine(), clientDir: dir, projectsDir, dbPath, clock: () => now, offlineAfterMs: 400, removeAfterMs: 1e12, isAlive: () => true });
  servers.push(server);
  return { server, dbPath };
}

function hook(server: { port?: number }, session_id: string, hook_event_name: string, extra: object = {}) {
  const transcript_path = join(dir, `${session_id}.jsonl`);
  writeFileSync(transcript_path, '{"type":"user"}\n');
  return fetch(`http://127.0.0.1:${server.port}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, hook_event_name, cwd: "/code/shop", transcript_path, ...extra }),
  });
}
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

/** The first state the office pushes to a new browser, after waiting a few ticks of the process check. */
async function seen(server: { port?: number }, settle = TICK) {
  await new Promise((r) => setTimeout(r, settle));
  return office(server, () => true);
}
function office(server: { port?: number }, until: (s: OfficeState) => boolean, timeout = 2000) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: `http://127.0.0.1:${server.port}` } } as any);
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

test("a session no listing names reads working for 90 s after its last hook event, then idle", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "gone", "PreToolUse", bash("make build"));
  now += HOT_MS - 1;
  expect((await seen(server)).employees.gone.status).toBe("working");
  now += 1;
  await office(server, (s) => s.employees.gone?.status === "idle");
});

test("a session claude agents lists without a busy status (blocked, or odd) is idle once its last hook event is 90 s old", async () => {
  now = 1_000_000;
  listed = new Map([["blocked", 4242]]);
  const { server } = start();
  await hook(server, "blocked", "PostToolUse", bash("make build"));
  expect((await seen(server)).employees.blocked.status).toBe("working");
  now += HOT_MS;
  await office(server, (s) => s.employees.blocked?.status === "idle");
});

test("a session claude agents lists as busy stays working however long it is silent", async () => {
  now = 1_000_000;
  listed = new Map([["long", 4243]]);
  statuses = { long: "busy" };
  const { server } = start();
  await hook(server, "long", "PreToolUse", bash("make build"));
  now += 10 * 60_000;
  expect((await seen(server)).employees.long.status).toBe("working");
});

test("a recent hook event reads working even when the listing says idle, and a Stop or the listing's idle ends it once the event is old", async () => {
  now = 1_000_000;
  listed = new Map([["rest", 4244], ["done", 4245]]);
  statuses = { rest: "idle", done: "idle" };
  const { server } = start();
  await hook(server, "rest", "PreToolUse", bash("make build"));
  await hook(server, "done", "PreToolUse", bash("make build"));
  await hook(server, "done", "Stop");
  const state = await seen(server);
  expect(state.employees.rest.status).toBe("working");
  expect(state.employees.done.status).toBe("idle");
  now += HOT_MS;
  await office(server, (s) => s.employees.rest?.status === "idle");
});

test("a sub-agent's events do not make a finished parent working", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "parent", "PreToolUse", bash("make build"));
  await hook(server, "parent", "Stop");
  await hook(server, "parent", "SubagentStart", { agent_id: "a1", agent_type: "Explore" });
  await hook(server, "parent", "PostToolUse", { ...bash("ls"), agent_id: "a1", agent_type: "Explore" });
  await hook(server, "parent", "SubagentStop", { agent_id: "a1", agent_type: "Explore" });
  expect((await seen(server)).employees.parent.status).toBe("idle");
});

test("a sub-agent's events keep a working parent working", async () => {
  now = 1_000_000;
  const { server } = start();
  await hook(server, "parent", "PreToolUse", bash("make build"));
  now += HOT_MS - 1000;
  await hook(server, "parent", "PostToolUse", { ...bash("ls"), agent_id: "a1", agent_type: "Explore" });
  now += 2000;
  expect((await seen(server)).employees.parent.status).toBe("working");
});

test("events replayed after a restart make no one working, from the first snapshot on; the listing still does", async () => {
  now = 1_000_000;
  listed = new Map([["busy", 4246]]);
  statuses = { busy: "busy" };
  const first = start();
  await hook(first.server, "replayed", "PreToolUse", bash("make build"));
  await hook(first.server, "busy", "PreToolUse", bash("make build"));
  await first.server.stop(true);

  const second = start(first.dbPath);
  const state = await office(second.server, () => true); // the very first push, before any check
  expect(state.employees.replayed.status).toBe("idle");
  await office(second.server, (s) => s.employees.busy?.status === "working");
  expect((await seen(second.server)).employees.replayed.status).toBe("idle");
});

test("a raised hand stays waiting however old the last event is", async () => {
  now = 1_000_000;
  listed = new Map([["asking", 4247]]);
  statuses = { asking: "idle" };
  const { server } = start();
  hook(server, "asking", "PermissionRequest", bash("rm -rf build")).catch(() => {});
  await office(server, (s) => (s.approvals ?? []).length === 1);
  now += 10 * HOT_MS;
  expect((await seen(server)).employees.asking.status).toBe("waiting");
});
