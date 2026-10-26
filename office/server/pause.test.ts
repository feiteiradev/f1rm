// Seam 1: the office's pause switch, in-process, with the machine faked: the hook answer, the 30 s stop on an injected clock, and the flag kept on disk.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFile } from "./editions.ts";
import { PAUSE_ANSWER } from "./pause.ts";
import { startServer } from "./server.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const TICK = 350; // the process check runs every offlineAfter / 4 = 100 ms; a few ticks pass
const SHOP = "/code/shop/.git";

const dir = mkdtempSync(join(tmpdir(), "f1rm-pause-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let now = 1_000_000;
// What `claude agents --json` lists: session id -> its pid and busy/idle status.
let listed = new Map<string, { pid: number; status?: "busy" | "idle" }>();
// Every `claude` call the office makes: the sessions it was told to stop, and anything else it ran.
let stopped: string[] = [];
let letGone: string[] = [];
const machine = () => ({
  gitCommonDir: (cwd: string) => `${cwd}/.git`,
  isRepo: () => true,
  liveSessions: async () => new Map(listed),
  backgroundId: async (sessionId: string) => `bg-${sessionId}`,
  stop: async (sessionId: string) => (stopped.push(sessionId), true),
  letGo: async (id: string) => void letGone.push(id),
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
afterEach(() => {
  servers.forEach((s) => s.stop(true));
  servers = [];
  listed = new Map();
  stopped = [];
  letGone = [];
  now = 1_000_000;
});

let n = 0;
/** An office with both projects registered; `pausedDir` is the folder the flag is kept in, so a second start on the same one is a restart. */
function start(pausedDir = join(dir, `paused-${n++}`), dbPath = join(dir, `events-${n}.db`), extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  for (const room of [SHOP, "/code/other/.git"]) writeFileSync(projectFile(projectsDir, room), "{}\n");
  const server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: machine() as any, clientDir: dir, projectsDir, pausedDir, dbPath, clock: () => now, offlineAfterMs: 400, removeAfterMs: 1e12, isAlive: () => true, ...extra });
  servers.push(server);
  return { server, pausedDir, dbPath };
}

const url = (server: { port?: number }, path = "ingest") => `http://127.0.0.1:${server.port}/${path}`;
function hook(server: { port?: number }, session_id: string, hook_event_name: string, extra: Record<string, unknown> = {}) {
  const transcript_path = join(dir, `${session_id}.jsonl`);
  writeFileSync(transcript_path, '{"type":"user"}\n');
  return fetch(url(server), {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, hook_event_name, cwd: "/code/shop", transcript_path, ...extra }),
  });
}
/** Seats a session: its first prompt names its title and role. */
const seat = (server: { port?: number }, id: string, title: string | undefined, agent_type: string | undefined, cwd = "/code/shop") =>
  hook(server, id, "UserPromptSubmit", { prompt: "go", cwd, ...(title && { session_title: title }), ...(agent_type && { agent_type }) });
const post = (server: { port?: number }, path: string, body: object) =>
  fetch(url(server, `${TOKEN}/${path}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const settle = (ms = TICK) => new Promise((r) => setTimeout(r, ms));

// One payload per hook kind the installed hooks send.
const KINDS: [string, Record<string, unknown>][] = [
  ["SessionStart", {}], ["UserPromptSubmit", { prompt: "go on" }],
  ["PreToolUse", { tool_name: "Read", tool_input: { file_path: "/code/shop/a.ts" } }], ["PostToolUse", { tool_name: "Read", tool_input: {} }],
  ["PostToolUseFailure", { tool_name: "Read", tool_input: {} }], ["PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }],
  ["Notification", { notification_type: "idle_prompt" }], ["Stop", {}], ["SubagentStart", { agent_id: "a1", agent_type: "Explore" }], ["SubagentStop", { agent_id: "a1", agent_type: "Explore" }], ["CwdChanged", {}],
  ["SessionEnd", {}], // last: it removes the session
];

test("a paused project's sessions get continue:false on every hook kind; the PM, another project and a plain session are untouched", async () => {
  const { server } = start();
  await seat(server, "lead", "lead-checkout", "f1rm:lead");
  await seat(server, "dev", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seat(server, "pm", "pm-shop", "f1rm:pm");
  await seat(server, "free", undefined, undefined);
  await seat(server, "far", "lead-search", "f1rm:lead", "/code/other");
  const reply = async (id: string, kind: string, extra: object, cwd = "/code/shop") => {
    const r = await hook(server, id, kind, { cwd, ...extra });
    return (await r.text()) || null;
  };
  expect(await reply("lead", "PreToolUse", KINDS[3][1])).toBeNull(); // before the pause the usual answer
  expect((await post(server, "pause", { room: SHOP })).status).toBe(200);
  for (const [kind, extra] of KINDS) for (const id of ["lead", "dev"]) {
    expect([id, kind, JSON.parse((await reply(id, kind, extra)) ?? "null")]).toEqual([id, kind, PAUSE_ANSWER]);
  }
  expect(PAUSE_ANSWER).toEqual({ continue: false, stopReason: "project paused by the PM" });
  // The PM runs `f1rm resume` and answers the user, so it keeps working; so does a session that is no company employee, and another project's.
  for (const [kind, extra] of KINDS.filter(([kind]) => kind !== "PermissionRequest")) { // theirs is held for the browser, as ever
    expect([kind, await reply("pm", kind, extra)]).toEqual([kind, null]);
    expect([kind, await reply("free", kind, extra)]).toEqual([kind, null]);
    expect([kind, await reply("far", kind, extra, "/code/other")]).toEqual([kind, null]);
  }
});

test("a pause is kept on disk outside the repo, and a restarted office still answers continue:false", async () => {
  const first = start();
  await seat(first.server, "lead", "lead-checkout", "f1rm:lead");
  await post(first.server, "pause", { room: SHOP, why: "going to lunch" });
  const file = join(first.pausedDir, readdirSync(first.pausedDir)[0]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ by: "manual", at: now, why: "going to lunch" });
  first.server.stop(true);
  const again = start(first.pausedDir, first.dbPath);
  const r = await hook(again.server, "lead", "PreToolUse", { tool_name: "Read", tool_input: {} });
  expect(await r.json()).toEqual(PAUSE_ANSWER);
  expect(await (await post(again.server, "resume", { room: SHOP })).json()).toMatchObject({ ok: true });
  expect(readdirSync(first.pausedDir)).toEqual([]);
  expect(await (await hook(again.server, "lead", "PreToolUse", { tool_name: "Read", tool_input: {} })).text()).toBe("");
});

test("30 s after the pause a still-busy hire is stopped with claude stop, an idle one and the PM are not, and nothing is ever removed", async () => {
  const { server, pausedDir } = start();
  await seat(server, "lead", "lead-checkout", "f1rm:lead");
  await seat(server, "busy", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seat(server, "idle", "checkout.backend-dev-b", "f1rm:backend-dev");
  await seat(server, "pm", "pm-shop", "f1rm:pm");
  await seat(server, "far", "lead-search", "f1rm:lead", "/code/other");
  listed = new Map([["lead", { pid: 1, status: "idle" }], ["busy", { pid: 2, status: "busy" }], ["idle", { pid: 3, status: "idle" }], ["pm", { pid: 4, status: "busy" }], ["far", { pid: 5, status: "busy" }]]);
  await post(server, "pause", { room: SHOP });
  await settle();
  expect(stopped).toEqual([]);
  now += 29_999;
  await settle();
  expect(stopped).toEqual([]); // not yet 30 s
  now += 1;
  await settle();
  expect(stopped).toEqual(["busy"]); // the busy hire only: not the idle ones, the PM (a terminal session) or the other project's
  await settle();
  expect(stopped).toEqual(["busy"]); // once
  expect(letGone).toEqual([]);
  expect(JSON.parse(readFileSync(join(pausedDir, readdirSync(pausedDir)[0]), "utf8")).stopped).toEqual(["checkout.backend-dev-a"]);
});

test("the office's recovery leaves a paused project alone, and a resume wakes the hire the pause stopped, with the pause note", async () => {
  const boards = mkdtempSync(join(dir, "boards-"));
  writeFileSync(join(boards, "-code-shop.team.checkout.md"), "# Board: shop / checkout\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | checkout.backend-dev-a | doing | worktree-a | x |\n");
  const DEV = "checkout.backend-dev-a";
  let sessions: any[] = [];
  const woke: { name: string; note: string }[] = [];
  const store: Record<string, any> = {};
  const recovery = {
    everyMs: 50,
    deps: {
      now: () => now,
      sessions: async () => sessions,
      tail: async () => "",
      mtime: async () => null,
      promptOf: async () => null,
      commitTime: async () => null,
      store: { load: (repo: string) => structuredClone(store[repo] ?? {}), save: (repo: string, e: object) => void (store[repo] = structuredClone(e)) },
      wake: async (_repo: string, name: string, note: string) => {
        woke.push({ name, note });
        sessions = [...sessions, { id: "new11111", kind: "background", name, sessionId: "new", cwd: "/code/shop/.claude/worktrees/a", pid: 9, startedAt: 9, state: "working", status: "busy" }];
      },
    },
  };
  const { server, pausedDir } = start(undefined, undefined, { boardsDir: boards, recovery, boardPollMs: 30 });
  await seat(server, "dev", DEV, "f1rm:backend-dev");
  listed = new Map([["dev", { pid: 2, status: "busy" }]]);
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle();
  expect(stopped).toEqual(["dev"]);
  // The stop took its process; the listing now shows it ended, with its board row still doing.
  listed = new Map();
  sessions = [{ id: "dev11111", kind: "background", name: DEV, sessionId: "dev", cwd: "/code/shop", state: "stopped", startedAt: 1 }];
  await settle(500);
  expect(woke).toEqual([]); // nothing wakes it while paused: a stopped session in a doing row is what the tick would wake
  const reply = await (await post(server, "resume", { room: SHOP })).json();
  expect(reply).toMatchObject({ ok: true, rooms: ["shop"], waking: 1 });
  await settle(300);
  expect(woke).toEqual([{ name: DEV, note: "resumed after a pause; continue your task" }]);
  expect(readdirSync(pausedDir)).toEqual([]);
});

test("a project resumed before the 30 s are up stops nothing", async () => {
  const { server } = start();
  await seat(server, "busy", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seat(server, "late", "checkout.backend-dev-b", "f1rm:backend-dev");
  listed = new Map([["busy", { pid: 2, status: "busy" }], ["late", { pid: 3, status: "busy" }]]);
  await post(server, "pause", { room: SHOP });
  now += 10_000;
  listed.set("busy", { pid: 2, status: "idle" }); // the continue:false ended its turn
  await post(server, "resume", { room: SHOP });
  now += 30_000;
  await settle();
  expect(stopped).toEqual([]);
});
