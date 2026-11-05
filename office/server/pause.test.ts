// Seam 1: the office's pause switch, in-process, with the machine faked: the hook answer, the 30 s stop on an injected clock, and the flag kept on disk.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageHold } from "../cli/hire.ts";
import { planWake } from "../cli/wake.ts";
import { projectFile } from "./editions.ts";
import { pausedFile, PAUSE_ANSWER, writePaused } from "./pause.ts";
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
// What each `claude stop` answers, in order; true when the queue is empty.
let stopResults: boolean[] = [];
const machine = () => ({
  gitCommonDir: (cwd: string) => `${cwd}/.git`,
  isRepo: () => true,
  liveSessions: async () => new Map(listed),
  backgroundId: async (sessionId: string) => `bg-${sessionId}`,
  stop: async (sessionId: string) => (stopped.push(sessionId), stopResults.length ? stopResults.shift()! : true),
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
  stopResults = [];
  now = 1_000_000;
});

let n = 0;
/** An office with both projects registered; `pausedDir` is the folder the flag is kept in, so a second start on the same one is a restart. */
function start(pausedDir = join(dir, `paused-${n++}`), dbPath = join(dir, `events-${n}.db`), extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  for (const room of [SHOP, "/code/other/.git", "/code/idle/.git"]) writeFileSync(projectFile(projectsDir, room), "{}\n");
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
  const { server, pausedDir } = start();
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
  // PreToolUse is answered with a deny as well: the call in flight still runs after continue:false, so it must not be one the gate would refuse. A permission request is denied too.
  const answer = (kind: string) =>
    kind === "PreToolUse" ? { ...PAUSE_ANSWER, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "project paused by the PM" } }
    : kind === "PermissionRequest" ? { ...PAUSE_ANSWER, hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "project paused by the PM" } } }
    : PAUSE_ANSWER;
  for (const [kind, extra] of KINDS) for (const id of ["lead", "dev"]) {
    expect([id, kind, JSON.parse((await reply(id, kind, extra)) ?? "null")]).toEqual([id, kind, answer(kind)]);
  }
  expect(PAUSE_ANSWER).toEqual({ continue: false, stopReason: "project paused by the PM" });
  // The hires that were answered are kept by name, for the resume to tell or wake; the PM, the plain session and the other project's lead are not.
  expect(JSON.parse(readFileSync(join(pausedDir, readdirSync(pausedDir)[0]), "utf8")).halted).toEqual(["lead-checkout", "checkout.backend-dev-a"]);
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
  expect(await r.json()).toMatchObject(PAUSE_ANSWER);
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
  expect(woke).toEqual([{ name: DEV, note: expect.stringMatching(/^resumed after a pause; continue your task\. .*pause/) }]);
  expect(readdirSync(pausedDir)).toEqual([]);
});

test("f1rm resume wakes the stopped hire through the real wake checks with 9 sessions working elsewhere: no cap holds it", async () => {
  const boards = mkdtempSync(join(dir, "boards-"));
  writeFileSync(join(boards, "-code-shop.team.checkout.md"), "# Board: shop / checkout\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | checkout.backend-dev-a | doing | worktree-a | x |\n");
  const DEV = "checkout.backend-dev-a";
  const far = Array.from({ length: 9 }, (_, i) => ({ id: `far${i}0000`, kind: "background", name: `far.designer-${i}`, sessionId: `far-${i}`, cwd: `/code/far/.claude/worktrees/t${i}`, pid: 50 + i, startedAt: 1, state: "working", status: "busy" }));
  const lead = { id: "lead0000", kind: "background", name: "lead-checkout", sessionId: "lead", cwd: "/code/shop", pid: 40, startedAt: 1, state: "working", status: "busy" };
  let sessions: any[] = [...far, lead];
  const woke: string[] = [];
  const home = mkdtempSync(join(dir, "home-")); // no usage file: no hold
  const recovery = {
    everyMs: 50,
    deps: {
      now: () => now,
      sessions: async () => sessions,
      tail: async () => "", mtime: async () => null, promptOf: async () => null, commitTime: async () => null,
      store: { load: () => ({}), save: () => {} },
      sleep: () => Bun.sleep(100), // a counted refusal would wait here
      wake: async (repo: string, name: string, note: string) => {
        await planWake({ target: name, message: note, cwd: repo }, {
          agents: async (all: boolean) => (all ? sessions : sessions.filter((a) => a.pid || a.state === "blocked")),
          gitCommonDir: () => `${repo}/.git`, home, now, exists: () => true, modelOf: () => null, promptOf: () => null,
        });
        woke.push(name);
        sessions = [...sessions.filter((a) => a.name !== name), { id: "new11111", kind: "background", name, sessionId: "new", cwd: "/code/shop/.claude/worktrees/a", pid: 9, startedAt: 9, state: "working", status: "busy" }];
      },
    },
  };
  const { server } = start(undefined, undefined, { boardsDir: boards, recovery, boardPollMs: 30 });
  await seat(server, "dev", DEV, "f1rm:backend-dev");
  listed = new Map([["dev", { pid: 2, status: "busy" }]]);
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle();
  listed = new Map();
  sessions = [...sessions, { id: "dev11111", kind: "background", name: DEV, sessionId: "dev", cwd: "/code/shop", state: "stopped", startedAt: 1 }];
  expect(await (await post(server, "resume", { room: SHOP })).json()).toMatchObject({ ok: true, waking: 1 });
  await settle(300);
  expect(woke).toEqual([DEV]);
});

test("a paused hire's next call meets the gate too: continue:false lets the call in flight run, so the same answer denies it", async () => {
  const { server } = start();
  await seat(server, "lead", "lead-checkout", "f1rm:lead");
  await seat(server, "dev", "checkout.backend-dev-a", "f1rm:backend-dev");
  await post(server, "pause", { room: SHOP });
  const pre = async (id: string, command: string) => (await hook(server, id, "PreToolUse", { tool_name: "Bash", tool_input: { command } })).json();
  for (const [id, command] of [["lead", "f1rm resume"], ["lead", "f1rm pause --all"], ["dev", "git push origin main"], ["dev", "f1rm hire designer a b c"], ["dev", `curl -X POST http://127.0.0.1:${server.port}/${TOKEN}/resume`]]) {
    expect([id, command, await pre(id, command)]).toEqual([id, command, { ...PAUSE_ANSWER, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "project paused by the PM" } }]);
  }
});

test("only a hire whose work was stopped is kept for the resume: a Stop, a Notification or a SessionEnd after the pause adds nobody", async () => {
  const { server, pausedDir } = start();
  await seat(server, "done", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seat(server, "busy", "checkout.backend-dev-b", "f1rm:backend-dev");
  await post(server, "pause", { room: SHOP });
  const halted = () => JSON.parse(readFileSync(join(pausedDir, readdirSync(pausedDir)[0]), "utf8")).halted;
  for (const [kind, extra] of [["Stop", {}], ["Notification", { notification_type: "idle_prompt" }], ["SessionEnd", {}]] as const) await hook(server, "done", kind, extra);
  expect(halted()).toBeUndefined();
  await hook(server, "busy", "PostToolUse", { tool_name: "Read", tool_input: {} });
  expect(halted()).toEqual(["checkout.backend-dev-b"]);
});

test("a stop that failed, or a hire that turns busy after the 30 s, is tried again on the next check while the project stays paused", async () => {
  const { server, pausedDir } = start();
  await seat(server, "a", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seat(server, "b", "checkout.backend-dev-b", "f1rm:backend-dev");
  listed = new Map([["a", { pid: 2, status: "busy" }], ["b", { pid: 3, status: "idle" }]]);
  stopResults = [false];
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle();
  expect(stopped.filter((s) => s === "a").length).toBeGreaterThan(1); // refused once, then stopped
  expect(stopped).not.toContain("b");
  listed.set("b", { pid: 3, status: "busy" }); // a text-only turn after a message
  await settle();
  expect(stopped.filter((s) => s === "b")).toEqual(["b"]);
  expect(stopped.filter((s) => s === "a")).toHaveLength(2); // a hire already stopped is not stopped again
  expect(JSON.parse(readFileSync(join(pausedDir, readdirSync(pausedDir)[0]), "utf8")).stopped).toEqual(["checkout.backend-dev-a", "checkout.backend-dev-b"]);
});

test("a busy session that claude stop cannot find (an interactive one wearing a hire's title) is tried a few times, not at every check", async () => {
  const { server } = start();
  await seat(server, "mine", "checkout.backend-dev-a", "f1rm:backend-dev");
  listed = new Map([["mine", { pid: 2, status: "busy" }]]);
  stopResults = Array(50).fill(false);
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle(1500); // fourteen checks
  expect(stopped).toEqual(["mine", "mine", "mine"]);
});

test("a new pause forgets the failed stops of the one before, so the same hire is tried again", async () => {
  const { server } = start();
  await seat(server, "mine", "checkout.backend-dev-a", "f1rm:backend-dev");
  listed = new Map([["mine", { pid: 2, status: "busy" }]]);
  stopResults = Array(50).fill(false);
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle(900);
  expect(stopped).toEqual(["mine", "mine", "mine"]);
  await post(server, "resume", { room: SHOP });
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle(900);
  expect(stopped).toHaveLength(6);
});

test("--all names a project no session has been in from its registration, which keeps the folder, and falls back to the last word of its key", async () => {
  const { server } = start();
  writeFileSync(projectFile(join(dir, "projects"), "/code/my-shop"), JSON.stringify({ folder: "/code/my-shop" }) + "\n");
  const names = (await (await post(server, "pause", { all: true })).json()).rooms.sort();
  rmSync(projectFile(join(dir, "projects"), "/code/my-shop"));
  expect(names).toEqual(["idle", "my-shop", "other", "shop"]); // the old registrations hold {}: the key's last word
});

test("--all covers every registered project, one no session has been in yet included", async () => {
  const { server, pausedDir } = start();
  await seat(server, "far", "lead-search", "f1rm:lead", "/code/other");
  const reply = await (await post(server, "pause", { all: true })).json();
  expect(reply.rooms.sort()).toEqual(["idle", "other", "shop"]);
  await seat(server, "late", "lead-idle", "f1rm:lead", "/code/idle"); // its first session arrives after
  const r = await hook(server, "late", "PostToolUse", { cwd: "/code/idle", tool_name: "Read", tool_input: {} });
  expect(await r.json()).toEqual(PAUSE_ANSWER);
  expect(readdirSync(pausedDir)).toHaveLength(3);
  expect((await (await post(server, "resume", { all: true })).json()).rooms.sort()).toEqual(["idle", "other", "shop"]);
  expect(readdirSync(pausedDir)).toEqual([]);
});

test("a pause during a resume ends that resume and hands its unfinished hires to the next; the recovery tick stays out while any resume runs", async () => {
  const boards = mkdtempSync(join(dir, "boards-"));
  writeFileSync(join(boards, "-code-shop.team.checkout.md"), "# Board: shop / checkout\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | checkout.backend-dev-a | doing | worktree-a | x |\n");
  const DEV = "checkout.backend-dev-a";
  const notes: string[] = [];
  const recovery = {
    everyMs: 30,
    deps: {
      now: () => now,
      sessions: async () => [{ id: "dev11111", kind: "background", name: DEV, sessionId: "dev", cwd: "/code/shop", state: "stopped", startedAt: 1 }],
      tail: async () => "", mtime: async () => null, promptOf: async () => null, commitTime: async () => null,
      store: { load: () => ({}), save: () => {} },
      sleep: () => Bun.sleep(200), // the usage hold is on: every try waits
      wake: async (_repo: string, _name: string, note: string) => {
        notes.push(note);
        throw new UsageHold("usage hold: 5-hour usage is 95% (resets 20:00); new sessions wait until 20:00", 1);
      },
    },
  };
  const { server } = start(undefined, undefined, { boardsDir: boards, recovery, boardPollMs: 30 });
  await seat(server, "dev", DEV, "f1rm:backend-dev");
  listed = new Map([["dev", { pid: 2, status: "busy" }]]);
  await post(server, "pause", { room: SHOP });
  now += 30_000;
  await settle();
  listed = new Map();
  await post(server, "resume", { room: SHOP });
  await settle(80);
  expect(notes).toHaveLength(1); // tried once, now waiting for a slot
  await post(server, "pause", { room: SHOP });
  await settle(450);
  expect(notes).toHaveLength(1); // the pause ended that resume
  // Two resumes overlap: the first is still sleeping when the project is paused and resumed again.
  await post(server, "resume", { room: SHOP });
  await post(server, "pause", { room: SHOP });
  await post(server, "resume", { room: SHOP });
  await settle(700);
  expect(notes.length).toBeGreaterThan(2); // the hire went on to the later resume
  expect(notes.every((note) => note.startsWith("resumed after a pause; continue your task"))).toBe(true); // the tick never woke it with its own note
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

test("the page's snapshot lists the paused projects by name, a schedule pause included, and the office pushes it on pause and resume", async () => {
  const pausedDir = join(dir, `paused-${n++}`);
  writePaused(pausedFile(pausedDir, "/code/idle/.git"), { by: "schedule", at: 1, why: "" });
  const { server } = start(pausedDir);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: `http://127.0.0.1:${server.port}` } } as any);
  let last: unknown = "nothing yet";
  ws.onmessage = (m) => (last = JSON.parse(String(m.data)).paused);
  const sees = async (names: string[]) => {
    for (let i = 0; i < 40 && JSON.stringify(last) !== JSON.stringify(names); i++) await settle(25);
    expect(last).toEqual(names);
  };
  try {
    await sees(["idle"]);
    await post(server, "pause", { room: SHOP });
    await sees(["idle", "shop"]);
    await post(server, "resume", { all: true });
    await sees([]);
  } finally {
    ws.close();
  }
});
