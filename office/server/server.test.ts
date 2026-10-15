// Seam 1: the f1rm server, in-process, with the machine module faked.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { machine } from "./machine.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";

// Canned answers, and a log of the OS calls Jump makes.
const calls: string[] = [];
let openTabs = new Set<string>();
let backgroundIds: Record<string, string> = {};
const fakeMachine = (repos: Record<string, string> = {}) => ({
  // cwd -> git common dir, canned
  gitCommonDir: (cwd: string) => repos[cwd] ?? null,
  liveSessions: async () => new Set<string>(),
  backgroundId: async (sessionId: string) => backgroundIds[sessionId] ?? null,
  focusIterm: async (id: string) => (calls.push(`iterm ${id}`), openTabs.has(id)),
  attachInIterm: async (id: string) => void calls.push(`attach ${id}`),
  openVsCode: async (folder: string) => void calls.push(`code ${folder}`),
});

let server: ReturnType<typeof startServer>;
let sockets: WebSocket[] = [];
afterEach(() => {
  calls.length = 0;
  openTabs = new Set();
  backgroundIds = {};
  sockets.forEach((s) => s.close());
  sockets = [];
  server?.stop(true);
});

// Stand-in for the built client.
const clientDir = mkdtempSync(join(tmpdir(), "f1rm-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>f1rm</title>");

function start(repos?: Record<string, string>) {
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(repos), clientDir });
  return server;
}
const base = () => `http://127.0.0.1:${server.port}`;

function hook(payload: object, headers: Record<string, string> = {}) {
  return fetch(`${base()}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET, ...headers },
    body: JSON.stringify(payload),
  });
}

// Connects like the browser does and resolves with the first state matching `until`.
function office(until: (s: OfficeState) => boolean, timeout = 1000) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, {
    headers: { origin: base() },
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

const sessionStart = (session_id: string, cwd: string) => ({
  session_id,
  transcript_path: `/Users/me/.claude/projects/x/${session_id}.jsonl`,
  cwd,
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-5-5",
});

test("a new session appears as an idle employee in its repo's room", async () => {
  start({ "/code/shop": "/code/shop/.git" });
  const seen = office((s) => Object.keys(s.employees).length === 1);
  expect((await hook(sessionStart("s1", "/code/shop"))).status).toBe(200);

  const state = await seen;
  expect(state.employees.s1).toMatchObject({ status: "idle", room: "/code/shop/.git", cwd: "/code/shop" });
  expect(state.rooms["/code/shop/.git"]).toEqual({ id: "/code/shop/.git", name: "shop" });
});

const common = (session_id: string, hook_event_name: string) => ({
  session_id,
  transcript_path: `/Users/me/.claude/projects/x/${session_id}.jsonl`,
  cwd: "/code/shop",
  permission_mode: "default",
  hook_event_name,
});
const preToolUse = (id: string, tool_name: string, tool_input: object) => ({
  ...common(id, "PreToolUse"),
  tool_name,
  tool_input,
  tool_use_id: "toolu_1",
});

test("tool use flips an employee to working, a permission prompt to waiting, stop to idle", async () => {
  start({ "/code/shop": "/code/shop/.git" });
  await hook(sessionStart("s1", "/code/shop"));
  const employee = async () => (await office(() => true)).employees.s1;

  await hook({ ...common("s1", "UserPromptSubmit"), prompt: "fix the login bug" });
  expect(await employee()).toMatchObject({ status: "working", activity: "Thinking" });

  await hook(preToolUse("s1", "Edit", { file_path: "/code/shop/src/login.ts", old_string: "a", new_string: "b" }));
  expect(await employee()).toMatchObject({ status: "working", activity: "Edit login.ts", tool: "Edit" });

  await hook({ ...preToolUse("s1", "Bash", { command: "rm -rf build" }), hook_event_name: "PermissionRequest" });
  expect(await employee()).toMatchObject({ status: "waiting", activity: "Bash: rm -rf build", tool: "Bash" });

  await hook({ ...common("s1", "PostToolUse"), tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: {} });
  expect(await employee()).toMatchObject({ status: "working", tool: "Bash" });

  await hook({ ...common("s1", "Stop"), stop_hook_active: false });
  expect(await employee()).toMatchObject({ status: "idle", activity: "", tool: "" });

  await hook({ ...common("s1", "SessionEnd"), reason: "prompt_input_exit" });
  expect(await employee()).toBeUndefined();
});

test("permission and idle notifications set waiting and idle; other notifications change nothing", async () => {
  start();
  const notify = (notification_type: string) =>
    hook({ ...common("s1", "Notification"), message: "…", notification_type });
  const status = async () => (await office(() => true)).employees.s1.status;

  await hook(preToolUse("s1", "Bash", { command: "curl example.com" }));
  await notify("permission_prompt");
  expect(await status()).toBe("waiting");
  await notify("auth_success");
  expect(await status()).toBe("waiting");
  await notify("idle_prompt");
  expect(await status()).toBe("idle");
});

test("a session already running when the server starts appears on its next event", async () => {
  start();
  await hook(preToolUse("old", "Read", { file_path: "/code/shop/README.md" }));
  expect((await office(() => true)).employees.old).toMatchObject({ status: "working", activity: "Read README.md" });
});

test("activity is a short description of the tool, file or command", async () => {
  start();
  const cases: [string, object, string][] = [
    ["Write", { file_path: "/a/b/new.ts", content: "x" }, "Write new.ts"],
    ["Read", { file_path: "/a/b/c.md" }, "Read c.md"],
    ["Grep", { pattern: "TODO", path: "/a" }, "Grep TODO"],
    ["Glob", { pattern: "**/*.ts" }, "Glob **/*.ts"],
    ["Bash", { command: "bun test\n&& echo done", description: "Run tests" }, "Bash: bun test"],
    ["Bash", { command: "x".repeat(200) }, "Bash: " + "x".repeat(53) + "…"],
    ["WebFetch", { url: "https://bun.sh/docs/api/http", prompt: "?" }, "WebFetch bun.sh"],
    ["WebSearch", { query: "bun websockets" }, "WebSearch bun websockets"],
    ["Agent", { description: "Explore auth", prompt: "..." }, "Agent: Explore auth"],
    ["mcp__github__create_issue", { title: "t" }, "mcp__github__create_issue"],
  ];
  for (const [tool, input, activity] of cases) {
    await hook(preToolUse("s", tool, input));
    expect((await office(() => true)).employees.s.activity).toBe(activity);
  }
});

test("an employee carries its terminal locator from the hook headers", async () => {
  start();
  await hook(sessionStart("iterm", "/a"), {
    "x-f1rm-iterm-session": "w0t1p0:6C2B4D3E-1A2B-4C5D-8E9F-0123456789AB",
    "x-f1rm-term-program": "iTerm.app",
  });
  await hook(sessionStart("vscode", "/b"), { "x-f1rm-iterm-session": "", "x-f1rm-term-program": "vscode" });
  await hook(sessionStart("bg", "/c"), { "x-f1rm-iterm-session": "", "x-f1rm-term-program": "" });

  const { employees } = await office((s) => Object.keys(s.employees).length === 3);
  expect(employees.iterm.terminal).toEqual({
    itermSessionId: "w0t1p0:6C2B4D3E-1A2B-4C5D-8E9F-0123456789AB",
    termProgram: "iTerm.app",
  });
  expect(employees.vscode.terminal).toEqual({ termProgram: "vscode" });
  expect(employees.bg.terminal).toEqual({});
});

test("a session in a worktree sits in its main repo's room; a non-git folder is its own room", async () => {
  start({
    "/code/shop": "/code/shop/.git",
    "/code/shop/.claude/worktrees/ticket-3": "/code/shop/.git",
    "/code/blog": "/code/blog/.git",
  });
  await hook(sessionStart("main", "/code/shop"));
  await hook(sessionStart("wt", "/code/shop/.claude/worktrees/ticket-3"));
  await hook(sessionStart("other", "/code/blog"));
  await hook(sessionStart("loose", "/Users/me/Downloads"));

  const state = await office((s) => Object.keys(s.employees).length === 4);
  expect(state.employees.wt.room).toBe(state.employees.main.room);
  expect(state.employees.other.room).not.toBe(state.employees.main.room);
  expect(Object.values(state.rooms).map((r) => r.name).sort()).toEqual(["Downloads", "blog", "shop"]);
});

test("the real machine resolves a worktree to its main repo's git common dir", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-repo-")));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", join(repo, "wt"));
  mkdirSync(join(repo, "sub"));
  const loose = mkdtempSync(join(tmpdir(), "f1rm-loose-"));

  expect(machine.gitCommonDir(repo)).toBe(join(repo, ".git"));
  expect(machine.gitCommonDir(join(repo, "wt"))).toBe(join(repo, ".git"));
  expect(machine.gitCommonDir(join(repo, "sub"))).toBe(join(repo, ".git"));
  expect(machine.gitCommonDir(loose)).toBeNull();
});

test("hook events without the right ingest secret are rejected and change nothing", async () => {
  start();
  expect((await hook(sessionStart("fake", "/x"), { "x-f1rm-secret": "wrong" })).status).toBe(401);
  const res = await fetch(`${base()}/ingest`, { method: "POST", body: JSON.stringify(sessionStart("fake", "/x")) });
  expect(res.status).toBe(401);

  await hook(sessionStart("real", "/y"));
  const state = await office((s) => "real" in s.employees);
  expect(Object.keys(state.employees)).toEqual(["real"]);
});

test("the page and the WebSocket need the per-launch UI token", async () => {
  start();
  expect((await fetch(`${base()}/${TOKEN}/`)).status).toBe(200);
  expect(await (await fetch(`${base()}/${TOKEN}/`)).text()).toContain("<title>f1rm</title>");
  for (const path of ["/", "/wrong/", "/wrong/ws", `/${TOKEN}x/`]) {
    expect((await fetch(base() + path)).status).toBe(401);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/wrong/ws`, { headers: { origin: base() } } as any);
  sockets.push(ws);
  const outcome = await new Promise((r) => {
    ws.onmessage = () => r("message");
    ws.onerror = () => r("rejected");
  });
  expect(outcome).toBe("rejected");
});

test("the page without its trailing slash redirects, so its assets resolve under the token", async () => {
  start();
  const res = await fetch(`${base()}/${TOKEN}`, { redirect: "manual" });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(`/${TOKEN}/`);
  expect((await fetch(`${base()}/wrong`, { redirect: "manual" })).status).toBe(401);
});

test("a foreign Origin or an unexpected Host is rejected, even with valid credentials", async () => {
  start();
  const page = `${base()}/${TOKEN}/`;
  const bad: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: `http://127.0.0.1:${server.port! + 1}` },
    { host: `evil.example:${server.port}` }, // DNS rebinding
    { host: "127.0.0.1" },
  ];
  for (const headers of bad) {
    expect((await fetch(page, { headers })).status).toBe(403);
    expect((await hook(sessionStart("x", "/x"), headers)).status).toBe(403);
  }
  // The browser's own origins are fine, as are hook requests with no Origin.
  for (const origin of [base(), `http://localhost:${server.port}`]) {
    expect((await fetch(page, { headers: { origin } })).status).toBe(200);
  }
  expect((await fetch(page, { headers: { host: `localhost:${server.port}` } })).status).toBe(200);

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, {
    headers: { origin: "https://evil.example" },
  } as any);
  sockets.push(ws);
  const outcome = await new Promise((r) => {
    ws.onmessage = () => r("message");
    ws.onerror = () => r("rejected");
  });
  expect(outcome).toBe("rejected");
  expect(Object.keys((await office(() => true)).employees)).toEqual([]);
});

test("the server listens on loopback only", async () => {
  start();
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) return; // no other interface to probe from
  const reached = await fetch(`http://${lan.address}:${server.port}/`).then(() => true, () => false);
  expect(reached).toBe(false);
});

test("the server sends no CORS headers", async () => {
  start();
  const origin = "https://evil.example";
  const responses = [
    await fetch(`${base()}/${TOKEN}/`, { headers: { origin } }),
    await fetch(`${base()}/${TOKEN}/`),
    await fetch(`${base()}/ingest`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    }),
    await hook(sessionStart("s", "/s")),
  ];
  for (const res of responses) {
    expect(Array.from(res.headers, ([h]) => h).filter((h) => h.startsWith("access-control-"))).toEqual([]);
  }
});

const ITERM_ID = (n: number) => `w${n % 5}t${n}p0:6C2B4D3E-1A2B-4C5D-8E9F-${String(n).padStart(12, "0")}`;
const jumpTo = (id: string, init: RequestInit = { method: "POST" }, token = TOKEN) =>
  fetch(`${base()}/${token}/jump/${encodeURIComponent(id)}`, init);

test("Jump focuses the iTerm2 tab of exactly the employee asked for, among 40 tabs", async () => {
  start();
  for (let n = 0; n < 40; n++) {
    await hook(sessionStart(`s${n}`, `/code/p${n}`), { "x-f1rm-iterm-session": ITERM_ID(n), "x-f1rm-term-program": "iTerm.app" });
    openTabs.add(ITERM_ID(n));
  }
  await office((s) => Object.keys(s.employees).length === 40);

  for (const n of [0, 27, 39]) {
    const res = await jumpTo(`s${n}`);
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  }
  expect(calls).toEqual([0, 27, 39].map((n) => `iterm ${ITERM_ID(n)}`));
});

test("Jump says so when the employee's tab is closed, and does not guess another", async () => {
  start();
  await hook(sessionStart("s1", "/a"), { "x-f1rm-iterm-session": ITERM_ID(1) });
  const res = await jumpTo("s1");
  expect([res.status, await res.json()]).toEqual([409, { ok: false, error: "Its terminal tab is closed." }]);
  expect(calls).toEqual([`iterm ${ITERM_ID(1)}`]);
});

test("a background employee with no tab gets a new tab running claude attach", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"), { "x-f1rm-iterm-session": "", "x-f1rm-term-program": "" });
  expect((await jumpTo("bg1")).status).toBe(200);
  expect(calls).toEqual(["attach 7c5dcf5d"]);
});

test("a VS Code session focuses the VS Code window for its folder, even if iTerm2 launched VS Code", async () => {
  start();
  await hook(sessionStart("vs", "/code/shop"), { "x-f1rm-iterm-session": ITERM_ID(3), "x-f1rm-term-program": "vscode" });
  expect((await jumpTo("vs")).status).toBe(200);
  expect(calls).toEqual(["code /code/shop"]);
});

test("Jump to a session with nowhere to go, or an unknown or inherited name, does nothing", async () => {
  start();
  await hook(sessionStart("plain", "/a"), { "x-f1rm-term-program": "Apple_Terminal" });
  const res = await jumpTo("plain");
  expect([res.status, (await res.json()).ok]).toEqual([409, false]);
  expect((await jumpTo("nobody")).status).toBe(404);
  expect((await jumpTo("constructor")).status).toBe(404);
  expect(calls).toEqual([]);
});

test("Jump needs the UI token and a POST", async () => {
  start();
  await hook(sessionStart("s1", "/a"), { "x-f1rm-iterm-session": ITERM_ID(1) });
  openTabs.add(ITERM_ID(1));
  expect((await jumpTo("s1", { method: "POST" }, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/jump/s1`, { method: "POST" })).status).toBe(401);
  expect((await jumpTo("s1", { method: "GET" })).status).toBe(405);
  expect((await jumpTo("s1", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect(calls).toEqual([]);
  expect((await jumpTo("s1")).status).toBe(200);
});

const ROLE_NAMES = ["Priya", "Maya", "Felix", "Bruno", "Ines", "Kofi"];

test("a session started with --agent is that role's employee, titled by --name; any other session is a freelancer", async () => {
  start();
  const prompt = (id: string, extra: object) => hook({ ...common(id, "UserPromptSubmit"), prompt: "go", ...extra });
  await prompt("d", { agent_type: "f1rm:designer", session_title: "login-redesign" });
  await prompt("f", { agent_type: "f1rm:frontend-dev" });
  await prompt("b", { agent_type: "f1rm:backend-dev" });
  await prompt("p", { agent_type: "f1rm:pm" });
  await prompt("v", { agent_type: "f1rm:reviewer" });
  await prompt("r", { agent_type: "f1rm:researcher" });
  await prompt("x", { agent_type: "other:designer" });
  await prompt("e", { agent_type: "Explore" });
  await prompt("n", {});

  const { employees: e } = await office((s) => Object.keys(s.employees).length === 9);
  const seen = (id: string) => [e[id].role, e[id].name];
  expect(seen("d")).toEqual(["designer", "Maya"]);
  expect(seen("f")).toEqual(["frontend", "Felix"]);
  expect(seen("b")).toEqual(["backend", "Bruno"]);
  expect(seen("p")).toEqual(["pm", "Priya"]);
  expect(seen("v")).toEqual(["reviewer", "Ines"]);
  expect(seen("r")).toEqual(["researcher", "Kofi"]);
  expect(e.d.title).toBe("login-redesign");
  for (const id of ["x", "e", "n"]) {
    expect(e[id].role).toBeNull();
    expect(ROLE_NAMES).not.toContain(e[id].name);
  }

  // Later events without the fields keep them.
  await hook(preToolUse("d", "Bash", { command: "ls" }));
  expect((await office(() => true)).employees.d).toMatchObject({ role: "designer", name: "Maya", title: "login-redesign" });
});

test("tool events from inside a sub-agent do not give the session the sub-agent's role", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  await hook({ ...preToolUse("s1", "Read", { file_path: "/a" }), agent_id: "a1", agent_type: "f1rm:reviewer" });
  const { employees } = await office((s) => s.employees.s1?.tool === "Read");
  expect(employees.s1.role).toBeNull();

  // The main session's own event names the role, and the employee takes the role's name.
  await hook({ ...preToolUse("s1", "Read", { file_path: "/a" }), agent_type: "f1rm:designer" });
  expect((await office(() => true)).employees.s1).toMatchObject({ role: "designer", name: "Maya" });
});

test("concurrent shifts of a role count up, and a freed counter is reused", async () => {
  start();
  const shift = (id: string) => hook({ ...common(id, "SessionStart"), source: "startup", agent_type: "f1rm:designer" });
  await shift("a");
  await shift("b");
  await shift("c");
  const names = async () => Object.fromEntries(Object.entries((await office(() => true)).employees).map(([id, e]) => [id, e.name]));
  expect(await names()).toEqual({ a: "Maya", b: "Maya (2)", c: "Maya (3)" });

  await hook({ ...common("a", "SessionEnd"), reason: "other" });
  expect(await names()).toEqual({ b: "Maya (2)", c: "Maya (3)" });
  await shift("d");
  expect(await names()).toEqual({ b: "Maya (2)", c: "Maya (3)", d: "Maya" });
});

test("freelancer names are unique among the employees present and never a role's name, even with 120 sessions", async () => {
  start();
  const ids = Array.from({ length: 120 }, (_, i) => `session-${i}`);
  for (const id of ids) await hook(sessionStart(id, "/code/shop"));
  const { employees } = await office((s) => Object.keys(s.employees).length === ids.length);
  const names = Object.values(employees).map((e) => e.name);
  expect(new Set(names).size).toBe(ids.length);
  for (const name of names) expect(ROLE_NAMES).not.toContain(name.replace(/ \(\d+\)$/, ""));
});

test("a sub-agent is an intern of its parent from its start to its stop, and never an employee", async () => {
  start({ "/code/shop": "/code/shop/.git" });
  await hook(sessionStart("parent", "/code/shop"));
  await hook({ ...common("parent", "Stop"), stop_hook_active: false });
  const sub = (event: string, agent_id: string, extra: object = {}) =>
    hook({ ...common("parent", event), agent_id, agent_type: "Explore", ...extra });

  await sub("SubagentStart", "agent-1");
  await sub("SubagentStart", "agent-2");
  const busy = await office((s) => Object.keys(s.interns).length === 2);
  expect(busy.interns["agent-1"]).toEqual({ agentId: "agent-1", parent: "parent", type: "Explore" });
  expect(Object.keys(busy.employees)).toEqual(["parent"]);
  expect(busy.employees.parent.status).toBe("working");

  await sub("SubagentStop", "agent-1", { agent_transcript_path: "/t", last_assistant_message: "done" });
  const left = await office((s) => Object.keys(s.interns).length === 1);
  expect(Object.keys(left.interns)).toEqual(["agent-2"]);

  // Claude Code's own helper agents stop without ever starting; that says nothing about the parent.
  await hook({ ...common("parent", "Stop"), stop_hook_active: false });
  await sub("SubagentStop", "never-started");
  const after = await office(() => true);
  expect(after.employees.parent.status).toBe("idle");
  expect(Object.keys(after.interns)).toEqual(["agent-2"]);
});

test("a parent's interns leave with it", async () => {
  start();
  await hook(sessionStart("parent", "/code/shop"));
  await hook({ ...common("parent", "SubagentStart"), agent_id: "agent-1", agent_type: "Explore" });
  await office((s) => "agent-1" in s.interns);
  await hook({ ...common("parent", "SessionEnd"), reason: "other" });
  expect(await office(() => true)).toMatchObject({ employees: {}, interns: {} });
});
