// Seam 1: the f1rm server, in-process, with the machine module faked.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { LOAD_FIRST, SECURITY } from "../cli/hire.ts";
import { machine } from "./machine.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";

// Canned answers, and a log of the OS calls Jump makes.
const calls: string[] = [];
let openTabs = new Set<string>();
let backgroundIds: Record<string, string> = {};
// What `claude agents --json` lists (session id -> pid), and the pids whose process has ended.
let listing = new Map<string, number | undefined>();
let deadPids = new Set<number>();
const fakeMachine = (repos: Record<string, string> = {}) => ({
  // cwd -> git common dir, canned
  gitCommonDir: (cwd: string) => repos[cwd] ?? null,
  liveSessions: async () => listing,
  backgroundId: async (sessionId: string) => backgroundIds[sessionId] ?? null,
  letGo: async (id: string) => {
    calls.push(`letgo ${id}`);
    if (letGoFails) throw new Error(letGoFails);
  },
  sessions: async () => (await sessionsGate, sessionList),
  mergedBranch: (_repo: string, branch: string) => mergedBranches.has(branch),
  removeWorktree: (repo: string, task: string) => void calls.push(`remove ${repo} ${task}`),
  focusIterm: async (id: string) => (calls.push(`iterm ${id}`), openTabs.has(id)),
  attachInIterm: async (id: string) => void calls.push(`attach ${id}`),
  openVsCode: async (folder: string) => void calls.push(`code ${folder}`),
  tell: async (socket: string, sessionId: string, message: string) => {
    calls.push(`tell ${socket} ${sessionId} ${message}`);
    if (tellFails) throw new Error(tellFails);
  },
  workingHires: async () => working,
  backgroundSessions: async () => (working === null ? null : Array.from({ length: working }, (_, i) => ({ name: `hire-${i}`, state: "working", cwd: "/elsewhere" }))),
  startPmInIterm: async (folder: string) => {
    calls.push(`pm ${folder}`);
    if (pmFails) throw new Error(pmFails);
  },
  spawnBackground: async (argv: string[], cwd: string) => {
    spawned.push({ argv, cwd });
    if (spawnFails) throw new Error(spawnFails);
    return "backgrounded";
  },
  askFork: (sessionId: string, cwd: string, question: string, signal?: AbortSignal) => {
    calls.push(`ask ${sessionId} ${cwd} ${question}`);
    return askAnswer(signal);
  },
});
// What the faked fork says; a test swaps it to gate or fail the answer.
const defaultAnswer = async function* () {
  yield "The codeword is ";
  yield "MANGO.";
};
let tellFails = "";
let letGoFails = "";
// What `claude agents --json --all` lists, and which branches are merged into the base, for the safety net.
let sessionList: { id: string; name: string; kind: string; state: string; cwd: string }[] = [];
let mergedBranches = new Set<string>();
let sessionsGate: Promise<void> | undefined; // a test sets one that never settles: `claude agents` hanging
let working: number | null = 0;
let spawnFails = "";
let pmFails = "";
let spawned: { argv: string[]; cwd: string }[] = [];
let askAnswer: (signal?: AbortSignal) => AsyncGenerator<string> = defaultAnswer;

let afterEachRestore = () => {};
let server: ReturnType<typeof startServer>;
let sockets: WebSocket[] = [];
afterEach(() => {
  afterEachRestore();
  afterEachRestore = () => {};
  calls.length = 0;
  openTabs = new Set();
  backgroundIds = {};
  listing = new Map();
  deadPids = new Set();
  askAnswer = defaultAnswer;
  tellFails = "";
  letGoFails = "";
  sessionList = [];
  mergedBranches = new Set();
  sessionsGate = undefined;
  working = 0;
  spawnFails = "";
  pmFails = "";
  spawned = [];
  sockets.forEach((s) => s.close());
  sockets = [];
  server?.stop(true);
});

// Stand-in for the built client.
const clientDir = mkdtempSync(join(tmpdir(), "f1rm-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>f1rm</title>");

function start(repos?: Record<string, string>, approvalTimeoutMs?: number, boardsDir?: string) {
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(repos), clientDir, approvalTimeoutMs, boardsDir, projectsDir: mkdtempSync(join(tmpdir(), "f1rm-projects-")), isAlive: (pid) => !deadPids.has(pid) });
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

  void hook({ ...preToolUse("s1", "Bash", { command: "rm -rf build" }), hook_event_name: "PermissionRequest" }); // held until decided
  await office((s) => s.employees.s1?.status === "waiting");
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

test("the bare address and a wrong key say how to open the office, never show or redirect to the key", async () => {
  start();
  for (const path of ["/", "/wrong/", "/wrong"]) {
    const res = await fetch(base() + path, { redirect: "manual" });
    const body = await res.text();
    expect([path, res.status, res.headers.get("content-type"), res.headers.get("location")]).toEqual([path, 401, "text/html; charset=utf-8", null]);
    expect(body).toContain("Open the office with");
    expect(body).not.toContain(TOKEN);
  }
  expect((await fetch(`${base()}/${TOKEN}/`)).status).toBe(200);
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

test("Jump on a session that has ended says 410, removes the employee at once and opens nothing", async () => {
  start();
  await hook(sessionStart("gone", "/a"), { "x-f1rm-iterm-session": ITERM_ID(1) });
  await hook(sessionStart("here", "/b"), { "x-f1rm-iterm-session": ITERM_ID(2) });
  openTabs.add(ITERM_ID(2));
  listing = new Map([["gone", 4242], ["here", 4243]]);
  deadPids = new Set([4242]);
  const watching = office((s) => !("gone" in s.employees) && "here" in s.employees);

  const res = await jumpTo("gone");
  expect([res.status, await res.json()]).toEqual([410, { ok: false, ended: true, error: "This session has ended" }]);
  expect(Object.keys((await watching).employees)).toEqual(["here"]);
  expect(calls).toEqual([]);
  expect((await jumpTo("gone")).status).toBe(404);

  // A session whose process runs jumps as before.
  expect((await jumpTo("here")).status).toBe(200);
  expect(calls).toEqual([`iterm ${ITERM_ID(2)}`]);
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

test("a hook whose cwd is not an absolute path is dropped, so it can never reach a command line as a flag", async () => {
  start();
  const vscode = { "x-f1rm-term-program": "vscode" };
  for (const cwd of ["--opt=value", "-n", "relative/dir"]) await hook(sessionStart("flag", cwd), vscode);
  await hook(sessionStart("ok", "/code/shop"), vscode);
  const state = await office((s) => "ok" in s.employees);
  expect(Object.keys(state.employees)).toEqual(["ok"]);
  expect((await jumpTo("flag")).status).toBe(404);
  expect(calls).toEqual([]);
});

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
  const roles = Object.fromEntries(["d", "f", "b", "p", "v", "r", "x", "e", "n"].map((id) => [id, e[id].role]));
  expect(roles).toEqual({ d: "designer", f: "frontend", b: "backend", p: "pm", v: "reviewer", r: "researcher", x: null, e: null, n: null });
  expect(new Set(Object.values(e).map((x) => x.name)).size).toBe(9);
  expect(e.d.title).toBe("login-redesign");

  // Later events without the fields keep them.
  await hook(preToolUse("d", "Bash", { command: "ls" }));
  expect((await office(() => true)).employees.d).toMatchObject({ role: "designer", name: e.d.name, title: "login-redesign" });
});

test("tool events from inside a sub-agent do not give the session the sub-agent's role", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  await hook({ ...preToolUse("s1", "Read", { file_path: "/a" }), agent_id: "a1", agent_type: "f1rm:reviewer" });
  const { employees } = await office((s) => s.employees.s1?.tool === "Read");
  expect(employees.s1.role).toBeNull();

  // The main session's own event names the role, and the employee keeps its name.
  await hook({ ...preToolUse("s1", "Read", { file_path: "/a" }), agent_type: "f1rm:designer" });
  expect((await office(() => true)).employees.s1).toMatchObject({ role: "designer", name: employees.s1.name });
});

test("shifts of one role each get their own name, with no counter, and keep it while others come and go", async () => {
  start();
  const shift = (id: string) => hook({ ...common(id, "SessionStart"), source: "startup", agent_type: "f1rm:designer" });
  await shift("a");
  await shift("b");
  await shift("c");
  const names = async () => Object.fromEntries(Object.entries((await office(() => true)).employees).map(([id, e]) => [id, e.name]));
  const first = await names();
  expect(new Set(Object.values(first)).size).toBe(3);
  expect(Object.values(first).some((n) => n.includes("("))).toBe(false);

  await hook({ ...common("a", "SessionEnd"), reason: "other" });
  expect(await names()).toEqual({ b: first.b, c: first.c });
  await shift("d");
  const after = await names();
  expect([after.b, after.c]).toEqual([first.b, first.c]);
  expect([first.b, first.c]).not.toContain(after.d);
});

test("names are unique among the employees present, even with 120 sessions", async () => {
  start();
  const ids = Array.from({ length: 120 }, (_, i) => `session-${i}`);
  for (const id of ids) await hook(sessionStart(id, "/code/shop"));
  const { employees } = await office((s) => Object.keys(s.employees).length === ids.length);
  const names = Object.values(employees).map((e) => e.name);
  expect(new Set(names).size).toBe(ids.length);
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

const askOf = (id: string, body: unknown = { question: "What is the codeword?" }, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base()}/${token}/ask/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
const ndjson = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

test("Ask forks the asked employee's session in its own folder and streams the answer back", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  await hook(sessionStart("s2", "/code/blog"));
  const res = await askOf("s1");
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/x-ndjson"]);
  expect(await ndjson(res)).toEqual([{ text: "The codeword is " }, { text: "MANGO." }]);
  expect(calls).toEqual(["ask s1 /code/shop What is the codeword?"]);
});

test("Ask delivers the first words before the answer is finished", async () => {
  start();
  await hook(sessionStart("s1", "/a"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  askAnswer = async function* () {
    yield "first ";
    await gate;
    yield "second";
  };
  const reader = (await askOf("s1")).body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('{"text":"first "}\n');
  release();
  const rest = await reader.read();
  expect(new TextDecoder().decode(rest.value)).toBe('{"text":"second"}\n');
  expect((await reader.read()).done).toBe(true);
});

test("Ask reports a fork that fails, and stops the fork when the browser goes away", async () => {
  start();
  await hook(sessionStart("s1", "/a"));
  askAnswer = async function* () {
    yield "partial ";
    throw new Error("No conversation found with session ID: s1");
  };
  expect(await ndjson(await askOf("s1"))).toEqual([{ text: "partial " }, { error: "Ask failed: No conversation found with session ID: s1" }]);

  let stopped = false;
  askAnswer = async function* (signal) {
    while (!signal!.aborted) {
      yield "more ";
      await Bun.sleep(10);
    }
    stopped = true;
  };
  // A raw socket, because a fetch cancelled in-process leaves its connection open.
  const body = JSON.stringify({ question: "q" });
  const socket = connect(server.port!, "127.0.0.1", () =>
    socket.write(`POST /${TOKEN}/ask/s1 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`),
  );
  await new Promise((r) => socket.once("data", r));
  socket.destroy();
  await Bun.sleep(100);
  expect(stopped).toBe(true);
});

test("Ask needs the UI token, a POST, a known employee and a sane question", async () => {
  start();
  await hook(sessionStart("s1", "/a"));
  expect((await askOf("s1", undefined, {}, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/ask/s1`, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(`${base()}/${TOKEN}/ask/s1`)).status).toBe(405);
  expect((await askOf("s1", undefined, { headers: { origin: "https://evil.example", "content-type": "application/json" } })).status).toBe(403);
  expect((await askOf("s1", undefined, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await askOf("nobody")).status).toBe(404);
  expect((await askOf("constructor")).status).toBe(404);
  for (const bad of [{}, { question: "  " }, { question: 7 }, { question: "x".repeat(4001) }, "not json"]) {
    expect((await askOf("s1", bad)).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

const tellOf = (id: string, body: unknown = { message: "Use the staging database." }, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base()}/${token}/tell/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

test("Tell writes the message to the socket its hooks reported, for the employee asked for", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/101.sock" });
  await hook(sessionStart("s2", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/202.sock" });
  const res = await tellOf("s2", { message: "  Use the staging database.  " });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(calls).toEqual(["tell /tmp/cc-socks/202.sock s2 Use the staging database."]);
});

test("a later event without a socket header keeps the socket the employee reported", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/101.sock" });
  await hook(preToolUse("s1", "Bash", { command: "ls" }), { "x-f1rm-messaging-socket": "" });
  expect((await tellOf("s1")).status).toBe(200);
  expect(calls).toEqual(["tell /tmp/cc-socks/101.sock s1 Use the staging database."]);
});

test("Tell says why it failed: no socket reported, or the machine refused it", async () => {
  start();
  await hook(sessionStart("quiet", "/code/shop"));
  await hook(sessionStart("gone", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/9.sock" });
  const none = await tellOf("quiet");
  expect([none.status, await none.json()]).toEqual([409, { ok: false, error: "This session has no inbox to tell." }]);
  tellFails = "its inbox socket is gone, so the session has ended";
  const refused = await tellOf("gone");
  expect([refused.status, await refused.json()]).toEqual([409, { ok: false, error: "Tell failed: its inbox socket is gone, so the session has ended" }]);
});

test("Tell needs the UI token, a POST, a known employee and a sane message", async () => {
  start();
  await hook(sessionStart("s1", "/a"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/1.sock" });
  expect((await tellOf("s1", undefined, {}, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/tell/s1`, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(`${base()}/${TOKEN}/tell/s1`)).status).toBe(405);
  expect((await tellOf("s1", undefined, { headers: { origin: "https://evil.example", "content-type": "application/json" } })).status).toBe(403);
  expect((await tellOf("s1", undefined, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await tellOf("nobody")).status).toBe(404);
  expect((await tellOf("constructor")).status).toBe(404);
  for (const bad of [{}, { message: "  " }, { message: 7 }, { message: "x".repeat(4001) }, "not json"]) {
    expect((await tellOf("s1", bad)).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

const SHOP = { "/code/shop": "/code/shop/.git" };
const ROOM = "/code/shop/.git";
const ui = (path: string, init: RequestInit = {}, token = TOKEN) => fetch(`${base()}/${token}/${path}`, init);
const hireOf = (body: unknown, init: RequestInit = {}, token = TOKEN) =>
  ui("hire", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);
const ASSIGN = { room: ROOM, role: "designer", task: "login-page", brief: "Design the login page. Reply OK and stop." };
const inRoom = (id: string, extra: object) => hook({ ...common(id, "UserPromptSubmit"), cwd: "/code/shop", prompt: "go", ...extra });

test("roles lists the plugin's role files, read from the folder, with the PM left out and the working count per project", async () => {
  start(SHOP);
  await inRoom("d1", { agent_type: "f1rm:designer" });
  await inRoom("d2", { agent_type: "f1rm:designer" });
  await hook({ ...common("d3", "Stop"), cwd: "/code/shop" });
  await inRoom("p", { agent_type: "f1rm:pm" });
  await office((s) => Object.keys(s.employees).length === 4);
  working = 3;
  const reply = (await (await ui(`roles?room=${encodeURIComponent(ROOM)}`)).json()) as { roles: any[]; hires: unknown };
  const roles = reply.roles;
  expect(reply.hires).toEqual({ working: 3, cap: 30 });
  const founder = ["marketer", "seo-specialist", "social-media", "sales", "strategist"];
  const files = readdirSync(join(import.meta.dir, "../../plugin/agents")).map((f) => f.replace(/\.md$/, "")).filter((r) => r !== "pm").sort();
  expect([...roles.map((r) => r.id)].sort()).toEqual(files.filter((r) => !founder.includes(r)));
  expect(roles.map((r) => r.id)).toEqual(["designer", "frontend-dev", "backend-dev", "reviewer", "researcher", "lead"]);
  const designer = roles.find((r) => r.id === "designer");
  const fm = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(import.meta.dir, "../../plugin/agents/designer.md"), "utf8"))![1]) as any;
  expect(designer).toMatchObject({ title: "Designer", description: fm.description, model: fm.model, skills: fm.skills, working: 2 });
  expect(roles.find((r) => r.id === "reviewer").skills).toEqual(["code-review", "f1rm:f1rm-guidelines", "ponytail:ponytail-review"]);
  expect(roles.every((r) => r.id === "designer" || r.working === 0)).toBe(true);
  const elsewhere = (await (await ui("roles?room=/code/blog/.git")).json()) as { roles: any[] };
  expect(elsewhere.roles.find((r) => r.id === "designer").working).toBe(0);
  working = null;
  expect(((await (await ui(`roles?room=${encodeURIComponent(ROOM)}`)).json()) as any).hires).toEqual({ working: null, cap: 30 });
});

test("Hire starts a background session through the machine: the exact argv, in the room's repo folder, the brief as one argument", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  const brief = "Design the login page.\n$(rm -rf /) 'quoted' --flag";
  const res = await hireOf({ ...ASSIGN, brief, cwd: "/etc", folder: "/etc" });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(spawned).toEqual([
    {
      cwd: "/code/shop",
      argv: ["claude", "--bg", "--agent", "f1rm:designer", "--name", "designer-login-page", "--worktree", "login-page", `/design-pipeline\n\n${brief}`],
    },
  ]);
});

test("Hire reports to the project's PM when it has one, and takes a lower model", async () => {
  start(SHOP);
  await inRoom("p", { agent_type: "f1rm:pm" });
  await office((s) => ROOM in s.rooms);
  expect((await hireOf({ ...ASSIGN, model: "haiku" })).status).toBe(200);
  expect(spawned[0].argv.slice(8)).toEqual(["/design-pipeline Report to: pm-shop\n\n" + ASSIGN.brief, "--model", "haiku"]);
  expect((await hireOf({ ...ASSIGN, model: null })).status).toBe(200);
  expect(spawned[1].argv).not.toContain("--model");
});

test("Hire refuses an unknown role, a bad task name, a bad model, a bad brief and an unknown project, and spawns nothing", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  const cases: [object | string, number][] = [
    [{ ...ASSIGN, role: "pm" }, 400],
    [{ ...ASSIGN, role: "janitor" }, 400],
    [{ ...ASSIGN, role: "../designer" }, 400],
    [{ ...ASSIGN, role: 7 }, 400],
    [{ ...ASSIGN, task: "Login Page" }, 400],
    [{ ...ASSIGN, task: "--evil" }, 400],
    [{ ...ASSIGN, task: "" }, 400],
    [{ ...ASSIGN, model: "gpt-5" }, 400],
    [{ ...ASSIGN, model: "haiku --dangerously-skip-permissions" }, 400],
    [{ ...ASSIGN, brief: "  " }, 400],
    [{ ...ASSIGN, brief: "x".repeat(8001) }, 400],
    [{ ...ASSIGN, room: "/code/shop" }, 404],
    [{ ...ASSIGN, room: "constructor" }, 404],
    ["not json", 404],
  ];
  for (const [body, status] of cases) expect([JSON.stringify(body), (await hireOf(body)).status]).toEqual([JSON.stringify(body), status]);
  expect(spawned).toEqual([]);
});

test("at the cap Hire answers 409 with the working count and spawns nothing; when it can't count, it doesn't hire", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  working = 29;
  expect((await hireOf(ASSIGN)).status).toBe(200);
  spawned.length = 0;
  working = 30;
  const capped = await hireOf(ASSIGN);
  expect([capped.status, await capped.json()]).toEqual([409, { error: "30 hires are already working (the cap is 30).", working: 30 }]);
  working = null;
  const blind = await hireOf(ASSIGN);
  expect([blind.status, (await blind.json()).working]).toEqual([409, null]);
  expect(spawned).toEqual([]);
});

test("Hire anyway: override spends a slot past the cap, a plain hire after it is still refused, and override must be a boolean", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  working = 30;
  expect((await hireOf({ ...ASSIGN, override: false })).status).toBe(409);
  expect(spawned).toEqual([]);
  expect((await hireOf({ ...ASSIGN, override: "yes" })).status).toBe(400);
  expect((await hireOf({ ...ASSIGN, override: true })).status).toBe(200);
  expect(spawned.map((s) => s.argv.slice(0, 3))).toEqual([["claude", "--bg", "--agent"]]);
  working = 31;
  expect((await hireOf(ASSIGN)).status).toBe(409);
  expect(spawned.length).toBe(1);
});

test("Hire says so when claude fails to start the session", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  spawnFails = "not a git repository";
  const res = await hireOf(ASSIGN);
  expect([res.status, await res.json()]).toEqual([502, { error: "Hire failed: not a git repository" }]);
});

test("Roles and Hire need the UI token, the right method and the browser's own origin", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  expect((await hireOf(ASSIGN, {}, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/hire`, { method: "POST", body: JSON.stringify(ASSIGN) })).status).toBe(401);
  expect((await ui("hire")).status).toBe(405);
  expect((await hireOf(ASSIGN, { headers: { origin: "https://evil.example", "content-type": "application/json" } })).status).toBe(403);
  expect((await hireOf(ASSIGN, { headers: { host: "evil.example", "content-type": "application/json" } })).status).toBe(403);
  expect((await ui("roles", {}, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/roles`)).status).toBe(401);
  expect((await ui("roles", { method: "POST" })).status).toBe(405);
  expect((await ui("roles", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect(spawned).toEqual([]);
});

const pmPost = (path: "decide" | "start-pm", body: unknown, init: RequestInit = {}, token = TOKEN) =>
  ui(path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);
const PM_SOCKET = { "x-f1rm-messaging-socket": "/tmp/cc-socks/pm.sock" };

test("Let the PM decide tells the project's PM the need and asks them to hire per the guidelines", async () => {
  start(SHOP);
  await hook({ ...common("pm1", "UserPromptSubmit"), cwd: "/code/shop", prompt: "plan", agent_type: "f1rm:pm" }, PM_SOCKET);
  await inRoom("des1", { agent_type: "f1rm:designer" });
  await office((s) => Object.keys(s.employees).length === 2);
  const res = await pmPost("decide", { room: ROOM, need: "  A login page with passkeys.  " });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("tell /tmp/cc-socks/pm.sock pm1 ");
  expect(calls[0]).toContain("per the f1rm guidelines");
  expect(calls[0]).toContain("f1rm hire");
  expect(calls[0]).toEndWith("The need:\nA login page with passkeys.");
});

test("Let the PM decide says so when the project has no PM, the PM has no inbox, or the machine refuses", async () => {
  start(SHOP);
  await inRoom("des1", { agent_type: "f1rm:designer" });
  await office((s) => ROOM in s.rooms);
  const none = await pmPost("decide", { room: ROOM, need: "x" });
  expect([none.status, await none.json()]).toEqual([409, { error: "This project has no PM." }]);
  await inRoom("pm1", { agent_type: "f1rm:pm" });
  await office((s) => Object.keys(s.employees).length === 2);
  const quiet = await pmPost("decide", { room: ROOM, need: "x" });
  expect([quiet.status, await quiet.json()]).toEqual([409, { ok: false, error: "This session has no inbox to tell." }]);
  await hook({ ...common("pm1", "Stop"), cwd: "/code/shop" }, PM_SOCKET);
  tellFails = "its inbox socket is gone, so the session has ended";
  const gone = await pmPost("decide", { room: ROOM, need: "x" });
  expect([gone.status, await gone.json()]).toEqual([409, { ok: false, error: "Tell failed: its inbox socket is gone, so the session has ended" }]);
});

test("Let the PM decide refuses an unknown project and a bad need, and tells nobody", async () => {
  start(SHOP);
  await hook({ ...common("pm1", "UserPromptSubmit"), cwd: "/code/shop", prompt: "plan", agent_type: "f1rm:pm" }, PM_SOCKET);
  await office((s) => ROOM in s.rooms);
  const cases: [unknown, number][] = [
    [{ room: "/code/shop", need: "x" }, 404],
    [{ room: "constructor", need: "x" }, 404],
    ["not json", 404],
    [{ room: ROOM }, 400],
    [{ room: ROOM, need: "  " }, 400],
    [{ room: ROOM, need: 7 }, 400],
    [{ room: ROOM, need: "x".repeat(8001) }, 400],
  ];
  for (const [body, status] of cases) expect([JSON.stringify(body), (await pmPost("decide", body)).status]).toEqual([JSON.stringify(body), status]);
  expect(calls).toEqual([]);
});

test("Start PM opens a PM tab in the room's repo folder, whatever folder the request names", async () => {
  start(SHOP);
  await inRoom("des1", { agent_type: "f1rm:designer" });
  await office((s) => ROOM in s.rooms);
  const res = await pmPost("start-pm", { room: ROOM, folder: "/etc", cwd: "/etc" });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(calls).toEqual(["pm /code/shop"]);
});

test("Start PM opens nothing when the project has a PM, the project is unknown, or the tab fails to open", async () => {
  start(SHOP);
  await hook({ ...common("pm1", "UserPromptSubmit"), cwd: "/code/shop", prompt: "plan", agent_type: "f1rm:pm" });
  await office((s) => ROOM in s.rooms);
  const had = await pmPost("start-pm", { room: ROOM });
  expect([had.status, await had.json()]).toEqual([409, { error: "This project already has a PM." }]);
  expect((await pmPost("start-pm", { room: "/code/blog/.git" })).status).toBe(404);
  expect((await pmPost("start-pm", "not json")).status).toBe(404);
  expect(calls).toEqual([]);
  await hook({ ...common("pm1", "SessionEnd"), cwd: "/code/shop" });
  await office((s) => !Object.values(s.employees).some((e) => e.role === "pm"));
  pmFails = "iTerm2 isn't installed";
  const failed = await pmPost("start-pm", { room: ROOM });
  expect([failed.status, await failed.json()]).toEqual([502, { error: "Start PM failed: iTerm2 isn't installed" }]);
});

test("Let the PM decide and Start PM need the UI token, a POST and the browser's own origin", async () => {
  start(SHOP);
  await hook({ ...common("pm1", "UserPromptSubmit"), cwd: "/code/shop", prompt: "plan", agent_type: "f1rm:pm" }, PM_SOCKET);
  await office((s) => ROOM in s.rooms);
  const json = { "content-type": "application/json" };
  for (const path of ["decide", "start-pm"] as const) {
    const body = { room: ROOM, need: "x" };
    expect([path, (await pmPost(path, body, {}, "wrong")).status]).toEqual([path, 401]);
    expect([path, (await fetch(`${base()}/${path}`, { method: "POST", body: JSON.stringify(body) })).status]).toEqual([path, 401]);
    expect([path, (await ui(path)).status]).toEqual([path, 405]);
    expect([path, (await pmPost(path, body, { headers: { origin: "https://evil.example", ...json } })).status]).toEqual([path, 403]);
    expect([path, (await pmPost(path, body, { headers: { host: "evil.example", ...json } })).status]).toEqual([path, 403]);
  }
  expect(calls).toEqual([]);
});

const letGoOf = (id: string, body: unknown = { confirm: true }, init: RequestInit = {}, token = TOKEN) =>
  ui(`letgo/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);
const internOf = (id: string, body: unknown = { subtask: "Check the staging logs." }, init: RequestInit = {}, token = TOKEN) =>
  ui(`intern/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);

test("background says whether claude agents lists the employee's session as a background one", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"));
  await hook(sessionStart("fg1", "/code/shop"));
  const is = async (id: string) => {
    const res = await ui(`background/${id}`);
    return [res.status, await res.json()];
  };
  expect(await is("bg1")).toEqual([200, { background: true }]);
  expect(await is("fg1")).toEqual([200, { background: false }]);
  expect(await is("nobody")).toEqual([200, { background: false }]);
});

test("Let go stops and removes the background hire's session by its short id, and the employee leaves the office", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"));
  await hook(sessionStart("other", "/code/shop"));
  await office((s) => Object.keys(s.employees).length === 2);
  const res = await letGoOf("bg1");
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(calls).toEqual(["letgo 7c5dcf5d"]);
  const after = await office((s) => !s.employees.bg1);
  expect(Object.keys(after.employees)).toEqual(["other"]);
});

test("Let go does nothing without an explicit confirm, for a session that isn't a background hire, or for an unknown employee", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"));
  await hook(sessionStart("fg1", "/code/shop"));
  for (const body of [{}, { confirm: false }, { confirm: "yes" }, "not json"]) expect([JSON.stringify(body), (await letGoOf("bg1", body)).status]).toEqual([JSON.stringify(body), 400]);
  const fg = await letGoOf("fg1");
  expect([fg.status, await fg.json()]).toEqual([409, { error: "Only a background hire can be let go." }]);
  expect((await letGoOf("nobody")).status).toBe(404);
  expect((await letGoOf("constructor")).status).toBe(404);
  expect(calls).toEqual([]);
  expect(Object.keys((await office((s) => Object.keys(s.employees).length === 2)).employees).sort()).toEqual(["bg1", "fg1"]);
});

test("Let go says why claude refused or couldn't finish, and the employee stays", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"));
  letGoFails = "worktree has unpushed commits";
  const res = await letGoOf("bg1");
  expect([res.status, await res.json()]).toEqual([502, { error: "Let go failed: worktree has unpushed commits" }]);
  expect(Object.keys((await office((s) => Object.keys(s.employees).length === 1)).employees)).toEqual(["bg1"]);
});

test("Give them an intern tells the employee to hand the named subtask to a sub-agent", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/101.sock" });
  const res = await internOf("s1", { subtask: "  Check the staging logs.  " });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("tell /tmp/cc-socks/101.sock s1 ");
  expect(calls[0]).toContain("sub-agent");
  expect(calls[0]).toEndWith("\nCheck the staging logs.");
});

test("Give them an intern says why it failed, and refuses a bad subtask or an unknown employee", async () => {
  start();
  await hook(sessionStart("quiet", "/code/shop"));
  await hook(sessionStart("s1", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/101.sock" });
  const none = await internOf("quiet");
  expect([none.status, await none.json()]).toEqual([409, { ok: false, error: "This session has no inbox to tell." }]);
  expect((await internOf("nobody")).status).toBe(404);
  for (const bad of [{}, { subtask: "  " }, { subtask: 7 }, { subtask: "x".repeat(4001) }, "not json"]) expect((await internOf("s1", bad)).status).toBe(400);
  expect(calls).toEqual([]);
});

test("Let go, Give them an intern and background need the UI token, the right method and the browser's own origin", async () => {
  start();
  backgroundIds = { bg1: "7c5dcf5d" };
  await hook(sessionStart("bg1", "/code/shop"), { "x-f1rm-messaging-socket": "/tmp/cc-socks/1.sock" });
  const json = { "content-type": "application/json" };
  const posts = { letgo: { confirm: true }, intern: { subtask: "x" } };
  for (const [path, body] of Object.entries(posts)) {
    const of = (init: RequestInit = {}, token = TOKEN) => ui(`${path}/bg1`, { method: "POST", headers: json, body: JSON.stringify(body), ...init }, token);
    expect([path, (await of({}, "wrong")).status]).toEqual([path, 401]);
    expect([path, (await fetch(`${base()}/${path}/bg1`, { method: "POST", body: JSON.stringify(body) })).status]).toEqual([path, 401]);
    expect([path, (await ui(`${path}/bg1`)).status]).toEqual([path, 405]);
    expect([path, (await of({ headers: { origin: "https://evil.example", ...json } })).status]).toEqual([path, 403]);
    expect([path, (await of({ headers: { host: "evil.example", ...json } })).status]).toEqual([path, 403]);
  }
  expect((await ui("background/bg1", {}, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/${TOKEN}/background/bg1`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await ui("background/bg1", { method: "POST" })).status).toBe(405);
  expect(calls).toEqual([]);
});

const permissionRequest = (id: string, command: string) => ({ ...preToolUse(id, "Bash", { command }), hook_event_name: "PermissionRequest" });
const decide = (verb: "approve" | "deny", id: string, token = TOKEN, init: RequestInit = {}) =>
  fetch(`${base()}/${token}/${verb}/${id}`, { method: "POST", ...init });
/** Sends a PermissionRequest and returns its still-held response with the approval the office lists for it. */
async function raiseHand(session = "s1", command = "rm -rf build") {
  const held = hook(permissionRequest(session, command));
  const [approval] = (await office((s) => (s.approvals ?? []).some((a) => a.sessionId === session))).approvals!.filter((a) => a.sessionId === session);
  return { held, approval };
}
const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), Bun.sleep(150).then(() => false)]);

test("a permission request is held while the office lists it with its tool and arguments", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  expect(approval).toMatchObject({ sessionId: "s1", tool: "Bash", input: { command: "rm -rf build" } });
  expect(await settled(held)).toBe(false);
});

test("approving answers the held hook with an allow decision and clears the tray", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  const res = await decide("approve", approval.id);
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  const answer = await held;
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  expect((await office(() => true)).approvals).toEqual([]);
  expect((await decide("approve", approval.id)).status).toBe(404); // answered once
});

test("denying answers the held hook with a deny decision that tells Claude why", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  expect((await decide("deny", approval.id)).status).toBe(200);
  expect(await (await held).json()).toEqual({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from the f1rm office." } },
  });
});

test("when the timeout passes the hook gets no decision and the tray empties", async () => {
  start(undefined, 100);
  await hook(sessionStart("s1", "/code/shop"));
  const { held } = await raiseHand();
  const answer = await held;
  expect([answer.status, await answer.text()]).toEqual([200, ""]);
  const state = await office(() => true);
  expect(state.approvals).toEqual([]);
  expect(state.employees.s1.status).toBe("waiting"); // the terminal prompt is still up
});

test("a later event for the session drops its pending hand and answers the hook with no decision", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  const other = await raiseHand("s2");
  await hook({ ...common("s1", "PostToolUse"), tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: {} }); // answered in the terminal
  const answer = await held;
  expect([answer.status, await answer.text()]).toEqual([200, ""]);
  expect((await office((s) => s.approvals!.length === 1)).approvals!.map((a) => a.sessionId)).toEqual(["s2"]); // only s1's hand dropped
  expect((await decide("approve", approval.id)).status).toBe(404);
  expect(await settled(other.held)).toBe(false);
});

test("an employee removed because its process ended takes its pending hand with it", async () => {
  start();
  await hook(sessionStart("gone", "/code/shop"));
  const { held, approval } = await raiseHand("gone");
  listing = new Map([["gone", 4242]]);
  deadPids = new Set([4242]);
  expect((await jumpTo("gone")).status).toBe(410);
  const answer = await held;
  expect([answer.status, await answer.text()]).toEqual([200, ""]);
  expect((await office(() => true)).approvals).toEqual([]);
  expect((await decide("approve", approval.id)).status).toBe(404);
});

test("a permission_prompt notification for the held prompt does not drop it", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  await hook({ ...common("s1", "Notification"), message: "Claude needs your permission", notification_type: "permission_prompt" });
  expect(await settled(held)).toBe(false);
  expect((await decide("approve", approval.id)).status).toBe(200);
});

test("a second request from the same session replaces the first", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const first = await raiseHand("s1", "ls");
  const second = hook(permissionRequest("s1", "pwd"));
  await office((s) => s.approvals!.length === 1 && (s.approvals![0].input as any).command === "pwd");
  expect((await first.held).status).toBe(200);
  expect(await settled(second)).toBe(false);
});

test("a hook cancelled by Claude Code drops its hand", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const abort = new AbortController();
  fetch(`${base()}/ingest`, { method: "POST", signal: abort.signal, headers: { "x-f1rm-secret": SECRET }, body: JSON.stringify(permissionRequest("s1", "ls")) }).catch(() => {});
  await office((s) => s.approvals!.length === 1);
  abort.abort();
  expect((await office((s) => s.approvals!.length === 0)).approvals).toEqual([]);
});

test("Approve and Deny need the UI token, a POST and the browser's own origin", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held, approval } = await raiseHand();
  expect((await decide("approve", approval.id, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/approve/${approval.id}`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base()}/${TOKEN}/approve/${approval.id}`)).status).toBe(405);
  expect((await decide("approve", approval.id, TOKEN, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await decide("deny", approval.id, TOKEN, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await decide("approve", "no-such-id")).status).toBe(404);
  expect(await settled(held)).toBe(false); // none of that answered it
});

// The PreToolUse reply: a deny holds the call, an empty 200 lets it run.
async function held(r: Response) {
  const body = await r.text();
  return body ? JSON.parse(body).hookSpecificOutput : null;
}

test("only the PM, a lead and the user's own sessions run `f1rm hire`; a specialist's is denied, and so is its intern's", async () => {
  start();
  const as = (id: string, agent_type?: string) => hook({ ...common(id, "UserPromptSubmit"), prompt: "go", ...(id === "l" && { session_title: "lead-checkout" }), ...(agent_type && { agent_type }) });
  for (const [id, type] of [["p", "f1rm:pm"], ["l", "f1rm:lead"], ["d", "f1rm:designer"], ["v", "f1rm:reviewer"], ["f", undefined]] as const) await as(id, type);
  await office((s) => Object.keys(s.employees).length === 5);
  const run = (id: string, command: string, extra = {}) => hook({ ...preToolUse(id, "Bash", { command }), ...extra });
  expect(await held(await run("p", "f1rm hire lead lead-checkout checkout 'Task: a'"))).toBeNull();
  for (const id of ["l", "f"]) expect(await held(await run(id, "f1rm hire --team checkout designer checkout.designer-a a 'Task: a'"))).toBeNull();
  for (const command of ["f1rm hire designer designer-a a brief", "cd /code/shop && bun office/cli/f1rm.ts hire reviewer reviewer-a a b"]) {
    const out = await held(await run("d", command));
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.permissionDecisionReason).toContain("Only the PM and team leads hire");
  }
  expect((await held(await run("v", "f1rm hire designer designer-a a b", { agent_id: "agent-1", agent_type: "Explore" })))?.permissionDecision).toBe("deny");
  expect(await held(await run("d", "git status && echo f1rm is hiring"))).toBeNull();
});

test("`f1rm hire` is held only as a command; a command that merely mentions it passes", async () => {
  await delegationOffice();
  const run = async (command: string) => (await held(await hook(preToolUse("d", "Bash", { command }))))?.permissionDecision ?? null;
  for (const command of ["f1rm hire designer a b c", "cd x && f1rm hire designer a b c", "ls; f1rm hire designer a b c", "true || f1rm hire designer a b c", "echo hi | f1rm hire designer a b c", "(f1rm hire designer a b c)", "echo $(f1rm hire designer a b c)", "echo hi\nf1rm hire designer a b c", "bun office/cli/f1rm.ts hire designer a b c", "F1RM_X=1 /usr/local/bin/f1rm hire designer a b c", "bun run office/cli/f1rm.ts hire designer a b c", "npx f1rm hire designer a b c", '"f1rm" hire designer a b c']) {
    expect([command, await run(command)]).toEqual([command, "deny"]);
  }
  for (const command of ['git commit -m "mentions f1rm hire"', 'grep "f1rm hire" README.md', "echo 'ls; f1rm hire designer'", "cat docs/f1rm.ts", "f1rm hired"]) {
    expect([command, await run(command)]).toEqual([command, null]);
  }
});

// A PM, a lead, a designer and a freelancer, to see which of the delegation rules reach whom.
async function delegationOffice(boardsDir?: string) {
  start(undefined, undefined, boardsDir);
  for (const [id, type] of [["p", "f1rm:pm"], ["l", "f1rm:lead"], ["d", "f1rm:designer"], ["f", undefined]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", session_title: `${id}-title`, ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 4);
}

test("a PM's or lead's Write, Edit and NotebookEdit land only in boards, milestones, memory, evidence and scratch; others write anywhere", async () => {
  await delegationOffice("/home/me/.f1rm/boards");
  const home = process.env.HOME;
  process.env.HOME = "/home/me";
  afterEachRestore = () => (process.env.HOME = home);
  const write = async (id: string, tool: string, file_path: string) => held(await hook(preToolUse(id, tool, tool === "NotebookEdit" ? { notebook_path: file_path } : { file_path })));
  const allowed = ["/home/me/.f1rm/boards/shop.md", "/home/me/.f1rm/milestones/-code-shop.md", "/home/me/.claude/agent-memory/pm/notes.md", "/home/me/.f1rm/evidence/a/shot.png", "/private/tmp/claude-501/x/scratchpad/n.md", "/tmp/claude-501/n.md"];
  const refused = ["/code/shop/src/login.ts", "/home/me/.f1rm/boards/../events.db", "/home/me/.f1rm/milestones/../../x", "/home/me/.f1rm/milestones-evil/x.md", "/home/me/.claude/agent-memory-evil/x.md", "src/login.ts"];
  for (const id of ["p", "l"]) {
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      for (const file of allowed) expect([id, tool, file, await write(id, tool, file)]).toEqual([id, tool, file, null]);
      for (const file of refused) {
        const out = await write(id, tool, file);
        expect([id, tool, file, out?.permissionDecision]).toEqual([id, tool, file, "deny"]);
        expect(out.permissionDecisionReason).toBe("The PM and leads write only boards, milestones, memory, evidence and scratch files. Put this work on the board and hire for it.");
      }
    }
  }
  for (const id of ["d", "f"]) expect(await write(id, "Write", "/code/shop/src/login.ts")).toBeNull();
});

test("with no HOME, a PM's or lead's write under .f1rm or .claude relative to the server's folder is refused; the boards folder still works", async () => {
  await delegationOffice("/home/me/.f1rm/boards");
  const home = process.env.HOME;
  delete process.env.HOME;
  afterEachRestore = () => void (home === undefined ? delete process.env.HOME : (process.env.HOME = home));
  const write = async (id: string, file_path: string) => held(await hook(preToolUse(id, "Write", { file_path })));
  for (const id of ["p", "l"]) {
    for (const file of [".f1rm/milestones/x.md", ".f1rm/evidence/x.md", ".claude/agent-memory/x.md"]) {
      const out = await write(id, join(process.cwd(), file));
      expect([id, file, out?.permissionDecision]).toEqual([id, file, "deny"]);
    }
    expect(await write(id, "/home/me/.f1rm/boards/shop.md")).toBeNull();
  }
});

test("a PM's or lead's landing git commands are refused, past global options; read-only git and everyone else's are not", async () => {
  await delegationOffice();
  const bash = async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
  const landing = ["git merge agent-comms", "git -C x push", "git commit -m 'a; b'", "cd x && git -C '/my repo' -c core.editor=true rebase main", "git --no-pager reset --hard", "git cherry-pick abc", "FOO=1 git push origin main | cat", "echo $(git commit -am x)", "git pull origin main", "git -C x am fix.patch", "git revert abc", "gh pr merge 3 --squash", "cd x && gh pr merge 3", "if true; then git merge x; fi", "time git commit -am x", "! git revert abc", "env gh pr merge 3"];
  const readOnly = ["git log --oneline", "git status", "git diff HEAD", "git show abc", "git rev-parse HEAD", "git worktree list", "git -C x log", "git log --grep 'git push; git merge'", "echo git push", "gh pr view 3"];
  for (const id of ["p", "l"]) {
    for (const command of landing) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toBe("Landing, merging and pushing belong to the Reviewer and the user. Hire for it, or ask the user to run it with `!`.");
    }
    for (const command of readOnly) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  // A specialist lands on its own branch, but never pushes (see the push test); a freelancer is held by nothing.
  for (const command of landing) expect(await bash("f", command)).toBeNull();
  for (const command of landing.filter((c) => !/push|pr merge/.test(c))) expect(await bash("d", command)).toBeNull();
});

test("a PM's or lead's Agent or Task call for an f1rm role is refused; an ordinary intern, and a specialist's call, are not", async () => {
  await delegationOffice();
  const call = async (id: string, tool: string, subagent_type: string) => held(await hook(preToolUse(id, tool, { description: "x", prompt: "x", subagent_type })));
  for (const id of ["p", "l"]) {
    for (const tool of ["Agent", "Task"]) {
      const out = await call(id, tool, "f1rm:backend-dev");
      expect([id, tool, out?.permissionDecision]).toEqual([id, tool, "deny"]);
      expect(out.permissionDecisionReason).toBe("A role is hired with `f1rm hire`, never started as an intern.");
    }
  }
  expect(await call("p", "Agent", "Explore")).toBeNull();
  expect(await call("l", "Task", "general-purpose")).toBeNull();
  expect(await call("d", "Agent", "f1rm:backend-dev")).toBeNull();
});

// A PM, the checkout lead, a designer, a Reviewer and a freelancer, for the hire and push rules.
async function gateOffice() {
  start();
  for (const [id, type, title] of [["p", "f1rm:pm", "p-title"], ["l", "f1rm:lead", "lead-checkout"], ["d", "f1rm:designer", "d-title"], ["v", "f1rm:reviewer", "v-title"], ["f", undefined, "f-title"]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", session_title: title, ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 5);
  return async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
}

test("a PM hires only leads, with any flags before the role; a specialist hire, or a lead hire named only in the brief, is refused", async () => {
  const bash = await gateOffice();
  const allowed = ["f1rm hire lead lead-checkout checkout 'Task: a'", "f1rm hire --report-to pm-shop lead lead-checkout checkout b", "f1rm hire --skills x,y lead lead-checkout checkout b", "f1rm hire --override lead lead-checkout checkout b", "f1rm hire --override --report-to pm-shop --skills 'a,b' lead lead-checkout checkout b", "bun office/cli/f1rm.ts hire lead lead-a a b", "f1rm hire --help"];
  for (const command of allowed) expect([command, await bash("p", command)]).toEqual([command, null]);
  const refused = ["f1rm hire backend-dev backend-dev-a a brief", "f1rm hire --team checkout backend-dev checkout.backend-dev-a a b", "f1rm hire --override --skills x designer designer-a a b", "cd x && f1rm hire reviewer reviewer-a review-a b", "f1rm hire backend-dev backend-dev-a a lead", "echo hi | f1rm hire --report-to lead designer designer-a a b"];
  for (const command of refused) {
    const out = await bash("p", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("PMs hire leads; send this to a lead");
  }
});

test("a lead hires only into its own team: not a lead, not without --team, not into another team", async () => {
  const bash = await gateOffice();
  const allowed = ["f1rm hire --team checkout backend-dev checkout.backend-dev-a a b", "f1rm hire --report-to x --override --skills s --team checkout reviewer checkout.reviewer-a review-a b", 'f1rm hire --team "checkout" designer checkout.designer-a a b', "f1rm hire --level high --team checkout reviewer checkout.reviewer-a review-a b", "f1rm hire --help"];
  for (const command of allowed) expect([command, await bash("l", command)]).toEqual([command, null]);
  const refused = ["f1rm hire lead lead-other other b", "f1rm hire --team checkout lead lead-other other b", "f1rm hire backend-dev backend-dev-a a b", "f1rm hire --team other backend-dev other.backend-dev-a a b", "f1rm hire backend-dev backend-dev-a a '--team checkout'", "f1rm hire --team check backend-dev check.backend-dev-a a b", "f1rm hire --team checkout-2 backend-dev a a b"];
  for (const command of refused) {
    const out = await bash("l", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain(command.includes("hire lead") || command.includes("hire --team checkout lead") ? "never another lead" : "add --team checkout");
  }
});

test("a lead whose name carries no team can hire into none", async () => {
  start();
  await hook({ ...common("l", "UserPromptSubmit"), prompt: "go", session_title: "plain", agent_type: "f1rm:lead" });
  await office((s) => Object.keys(s.employees).length === 1);
  expect((await held(await hook(preToolUse("l", "Bash", { command: "f1rm hire --team plain backend-dev plain.backend-dev-a a b" }))))?.permissionDecision).toBe("deny");
});

const PUSHES = ["git push", "git push origin main", "git -C . push", "git -C '/my repo' -c core.editor=true push --tags", "cd x && git push", "FOO=1 git push | cat", "git 'push'", "gh pr merge 3", "gh pr merge 3 --squash", "cd x && gh pr merge 3", "if git diff --quiet; then echo ok; else git push; fi", "then git push", "! git push", "{ git push; }", "env git push", "env -i FOO=1 git push", "command git push", "exec git push", "time git push", "nohup git push &", "xargs git push", "sudo git push", "while true; do git push; done", "git --config-env x=Y push", "'gh' pr merge 3", "gh pr -R o/r merge 3", "gh --repo o/r pr merge 3", "gh -R o/r pr merge 3"];

test("nobody pushes or merges a PR: a specialist's and a Reviewer's git push and gh pr merge are refused, every form", async () => {
  const bash = await gateOffice();
  for (const id of ["d", "v"]) {
    for (const command of PUSHES) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the user pushes");
    }
    for (const command of ["git log --oneline", "git status", "echo git push", "git log --grep 'git push'", "gh pr view 3", "gh pr list", "gh pr checkout 3", "gh -R o/r pr view 3", "git commit -m 'git push later'", "if git diff --quiet; then echo ok; fi"]) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  for (const command of PUSHES) expect([command, await bash("f", command)]).toEqual([command, null]);
});

test("a Reviewer's history-rewriting and forcing git commands are refused; its merge, worktree add and worktree remove are not", async () => {
  const bash = await gateOffice();
  const refused = ["git reset --hard HEAD~1", "git -C x rebase main", "git cherry-pick abc", "git revert abc", "git am fix.patch", "git pull origin main", "git clean -fd", "git branch -D worktree-a", "git branch -Df worktree-a", "git merge --force x", "git checkout -f main", "git worktree remove --force .claude/worktrees/review-a", "git worktree remove -f ../x", "git worktree remove --force .claude/worktrees/red-a ../x", "git worktree remove --force .claude/worktrees/red-a/../../..", "git worktree add -f x", "git fetch origin -f", "cd x && git reset --hard", "then git reset --hard", "git branch -fD x", "git branch -M x", "git checkout -B x", "git switch -C x", "git update-ref -d refs/heads/x", "git stash drop", "git stash clear", "git restore .", "git checkout -- .", "git checkout .", "git -C /other/repo worktree remove --force .claude/worktrees/red-a", "git --git-dir=/x/.git worktree remove --force .claude/worktrees/red-a", "git worktree remove --force /code/shop/.claude/worktrees/red-a", "git worktree remove --force ./.claude/worktrees/red-a", "git clean -fdX", "git tag -f v1"];
  for (const command of refused) {
    const out = await bash("v", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Reviewer");
  }
  const allowed = ["git worktree remove --force .claude/worktrees/red-a", "git worktree remove -f .claude/worktrees/red-add-login/", "git worktree add .claude/worktrees/red-a -b red-a main", "git merge --no-ff worktree-a -m 'Merge a'", "git merge --ff-only main", "git merge --abort", "git worktree remove .claude/worktrees/review-a", "git branch -d worktree-a", "git log --oneline", "git diff main...worktree-a", "git status", "git commit -m 'conflict fix'", "git -C x worktree list", "git log --format=%h", "git log --grep 'git reset'", "git log -Sfoo", "git log -Gfix", "git diff -Uf", "git log --author -fred", "git commit -fm x", "git checkout worktree-a -- tests/a.test.ts", "git checkout main", "git checkout -b x", "git restore --staged a.ts", "git restore ./a.ts", "git stash list", "git stash", "git branch -m x", "if true; then git merge --no-ff a; fi"];
  for (const command of allowed) expect([command, await bash("v", command)]).toEqual([command, null]);
  // Only the Reviewer's: a specialist rebases its own branch.
  for (const command of ["git rebase main", "git reset --hard", "git pull", "git clean -fd", "git branch -D x", "git checkout -f main"]) expect([command, await bash("d", command)]).toEqual([command, null]);
});

test("the hire and push refusals are logged with the rule and never the command", async () => {
  const bash = await gateOffice();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await bash("d", "git push SECRET-REMOTE");
    await bash("v", "git reset --hard SECRET-REF");
    await bash("p", "f1rm hire designer SECRET-NAME a b");
    await bash("l", "f1rm hire lead SECRET-LEAD a b");
    await bash("v", "git merge --ff-only SECRET-BRANCH");
  } finally {
    console.log = log;
  }
  expect(lines).toEqual(["refused designer d-title Bash push", "refused reviewer v-title Bash history", "refused pm p-title Bash hire", "refused lead lead-checkout Bash hire"]);
});

test("a refusal is logged with the role, title, tool and rule, and never the command or the file", async () => {
  await delegationOffice();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await hook(preToolUse("p", "Bash", { command: "git push SECRET-REMOTE" }));
    await hook(preToolUse("l", "Write", { file_path: "/code/shop/SECRET-FILE.ts", content: "SECRET-BODY" }));
    await hook(preToolUse("p", "Agent", { description: "x", prompt: "SECRET-PROMPT", subagent_type: "f1rm:designer" }));
    await hook(preToolUse("d", "Bash", { command: "f1rm hire designer SECRET-NAME" }));
    await hook(preToolUse("p", "Bash", { command: "git log" }));
  } finally {
    console.log = log;
  }
  expect(lines).toEqual(["refused pm p-title Bash landing", "refused lead l-title Write write", "refused pm p-title Agent intern-role", "refused designer d-title Bash hire"]);
});

test("a company employee runs at most 2 interns at once, counting calls not started yet; a freelancer is never held", async () => {
  start();
  await hook({ ...common("d", "UserPromptSubmit"), prompt: "go", agent_type: "f1rm:designer" });
  await hook({ ...common("f", "UserPromptSubmit"), prompt: "go" });
  await office((s) => Object.keys(s.employees).length === 2);
  const agent = (id: string) => hook(preToolUse(id, "Agent", { description: "look", prompt: "look around", subagent_type: "Explore" }));
  expect(await held(await agent("d"))).toBeNull();
  expect(await held(await agent("d"))).toBeNull();
  const third = await held(await agent("d"));
  expect(third?.permissionDecision).toBe("deny");
  expect(third.permissionDecisionReason).toContain("2 interns working");
  for (let i = 0; i < 4; i++) expect(await held(await agent("f"))).toBeNull();

  // Both start, then one stops: a slot frees.
  const sub = (event: string, agent_id: string) => hook({ ...common("d", event), agent_id, agent_type: "Explore" });
  await sub("SubagentStart", "a1");
  await sub("SubagentStart", "a2");
  expect((await held(await agent("d")))?.permissionDecision).toBe("deny");
  await sub("SubagentStop", "a1");
  await office((s) => Object.keys(s.interns).length === 1);
  expect(await held(await agent("d"))).toBeNull();
});

test("a Founder project lists and hires the founder roles; a Work project, or one with no edition, refuses them", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  const ids = async () => ((await (await ui(`roles?room=${encodeURIComponent(ROOM)}`)).json()) as { roles: { id: string }[] }).roles.map((r) => r.id);
  const founder = ["marketer", "seo-specialist", "social-media", "sales", "strategist"];
  expect((await ids()).some((r) => founder.includes(r))).toBe(false);
  const marketer = { ...ASSIGN, role: "marketer" };
  const refused = await hireOf(marketer);
  expect([refused.status, (await refused.json()).error]).toEqual([400, "marketer is a Founder role and this is a Work project. Switch it with `f1rm edition founder` to hire one."]);

  const setEdition = (edition: string) => ui("edition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: ROOM, edition }) });
  expect((await setEdition("founder")).status).toBe(200);
  expect(await ids()).toEqual(["designer", "frontend-dev", "backend-dev", "reviewer", "researcher", ...founder, "lead"]);
  expect((await hireOf(marketer)).status).toBe(200);
  expect(spawned.at(-1)!.argv.slice(2, 4)).toEqual(["--agent", "f1rm:marketer"]);
  expect((await setEdition("work")).status).toBe(200);
  expect((await hireOf(marketer)).status).toBe(400);
});

test("a Founder role's connector tools that send, publish, post or schedule are denied; its drafts, Work roles and freelancers are not", async () => {
  start();
  for (const [id, type] of [["m", "f1rm:marketer"], ["d", "f1rm:designer"], ["f", undefined]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 3);
  const call = (id: string, tool: string) => hook(preToolUse(id, tool, {}));
  for (const tool of ["mcp__claude_ai_Gmail__send_email", "mcp__x__createPost", "mcp__claude_ai_Higgsfield__tiktok_publish_status", "mcp__buffer__schedule-post"]) {
    const out = await held(await call("m", tool));
    expect([tool, out?.permissionDecision]).toEqual([tool, "deny"]);
    expect(out.permissionDecisionReason).toContain("Drafts only");
  }
  for (const tool of ["mcp__claude_ai_Gmail__create_draft", "mcp__db__postgres_query", "mcp__garden__compost", "mcp__claude_ai_Canva__generate_design", "Write"]) {
    expect([tool, await held(await call("m", tool))]).toEqual([tool, null]);
  }
  for (const id of ["d", "f"]) expect(await held(await call(id, "mcp__claude_ai_Gmail__send_email"))).toBeNull();
});

test("show moves the open office pages to a project and says how many there were; an unknown project or token is refused", async () => {
  start(SHOP);
  await hook(sessionStart("s1", "/code/shop"));
  await office((s) => ROOM in s.rooms);
  // Only the page below may be connected: the helper's socket would count, and choke on a show message.
  for (const ws of sockets.splice(0)) ws.close();
  await Bun.sleep(50);
  const show = (room: string, token = TOKEN) => ui("show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room }) }, token);
  const page = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base() } } as any);
  sockets.push(page);
  const shown = new Promise<unknown>((resolve) => (page.onmessage = (m) => { const msg = JSON.parse(String(m.data)); if ("show" in msg) resolve(msg); }));
  await new Promise((r) => (page.onopen = r));
  const r = await show(ROOM);
  expect([r.status, await r.json()]).toEqual([200, { pages: 1 }]);
  expect(await shown).toEqual({ show: ROOM });
  page.close();
  await Bun.sleep(50);
  expect(await (await show(ROOM)).json()).toEqual({ pages: 0 });
  expect((await show("/code/nope")).status).toBe(404);
  expect((await show(ROOM, "wrong")).status).toBe(401);
});

test("the safety net lets go a hire that has been done 15 minutes with its branch merged, and nothing else", async () => {
  const repo = "/code/shop", tree = (task: string) => `${repo}/.claude/worktrees/${task}`;
  const s = (id: string, name: string, cwd: string, state = "done", kind = "background") => ({ id, name, kind, state, cwd });
  sessionList = [
    s("d1", "designer-done", tree("done")),
    s("t1", "checkout.backend-dev-teamdone", tree("teamdone")),
    s("r1", "reviewer-review-done", repo),
    s("u1", "designer-open", tree("open")),
    s("w1", "frontend-dev-busy", tree("busy"), "working"),
    s("l1", "lead-checkout", repo),
    s("n1", "my-own-task", tree("done")),
    s("i1", "designer-inter", tree("inter"), "done", "interactive"),
  ];
  mergedBranches = new Set(["worktree-done", "worktree-teamdone", "worktree-busy", "worktree-inter"]);
  let now = 1_000_000;
  const quiet = (ms: number) => Bun.sleep(ms);
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir, clock: () => now, letGoAfterMs: 400 });
  await quiet(250);
  expect(calls).toEqual([]); // just seen done
  now += 399;
  await quiet(250);
  expect(calls).toEqual([]); // not yet the whole wait
  now += 2;
  for (let i = 0; i < 20 && calls.length < 5; i++) await quiet(50);
  await quiet(250); // the unmerged, working, lead, other-name and interactive sessions stay however long it waits
  expect(calls.sort()).toEqual([`letgo d1`, `letgo r1`, `letgo t1`, `remove ${repo} done`, `remove ${repo} teamdone`].sort());
});

test("the office answers while the safety net's first look at `claude agents` is still hanging", async () => {
  sessionsGate = new Promise(() => {});
  start();
  const answer = await Promise.race([hook({ ...common("s1", "UserPromptSubmit"), prompt: "go" }).then(() => "answered"), Bun.sleep(1500).then(() => "held")]);
  expect(answer).toBe("answered");
});

test("the safety net starts the wait over when a hire works again, and keeps what it couldn't let go", async () => {
  const repo = "/code/shop";
  const hire = { id: "d1", name: "designer-done", kind: "background", state: "done", cwd: `${repo}/.claude/worktrees/done` };
  sessionList = [hire];
  mergedBranches = new Set(["worktree-done"]);
  let now = 1_000_000;
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir, clock: () => now, letGoAfterMs: 400 });
  await Bun.sleep(250);
  now += 300;
  sessionList = [{ ...hire, state: "working" }];
  await Bun.sleep(250);
  sessionList = [hire];
  await Bun.sleep(250); // done again: counted from here
  now += 300;
  await Bun.sleep(250);
  expect(calls).toEqual([]);
  letGoFails = "rm refused: uncommitted work";
  now += 200;
  await Bun.sleep(400);
  expect(calls).toEqual(["letgo d1"]); // tried once; it threw, so no worktree or branch was removed
  await Bun.sleep(400);
  expect(calls).toEqual(["letgo d1"]); // and not again every tick
});

// The skill gate: a hire is held until it loads the skills its first prompt names.
const hired = (id: string, prompt: string, agent_type = "f1rm:backend-dev") => hook({ ...common(id, "UserPromptSubmit"), prompt, agent_type, session_title: `${id}-title` });
const skillLoaded = (id: string, skill: string, hook_event_name = "PostToolUse") => hook({ ...common(id, hook_event_name), tool_name: "Skill", tool_input: { skill }, tool_use_id: "toolu_2" });
const tryTool = async (id: string, tool: string, input: object = {}) => (await held(await hook(preToolUse(id, tool, input))))?.permissionDecision ?? null;

test("a hire whose prompt names skills is refused every tool but the reading ones until each Skill call succeeds", async () => {
  start();
  await hired("h", `/tdd${LOAD_FIRST}mattpocock-skills:code-review, impeccable.\n\nbrief`);
  const out = await held(await hook(preToolUse("h", "Bash", { command: "ls" })));
  expect(out.permissionDecision).toBe("deny");
  expect(out.permissionDecisionReason).toBe("Load these first with the Skill tool: mattpocock-skills:code-review, impeccable. If one isn't installed, send `BLOCKED <task>` with its name to the session in your Report to.");
  expect(await tryTool("h", "Edit", { file_path: "/a" })).toBe("deny");
  for (const tool of ["Read", "Grep", "Glob", "Skill", "ToolSearch", "SendMessage"]) expect([tool, await tryTool("h", tool)]).toEqual([tool, null]);
  // The first slash command's own sub-agent (a forked /code-review) works at once; only the hire itself is held.
  const fork = await held(await hook({ ...preToolUse("h", "Bash", { command: "git diff main...x" }), agent_id: "fork-1", agent_type: "general-purpose" }));
  expect(fork?.permissionDecision ?? null).toBeNull();

  await skillLoaded("h", "code-review"); // another skill that shares the part after the ":" does not count
  await skillLoaded("h", "impeccable:impeccable"); // nor does a prefixed name for an unprefixed one
  expect((await held(await hook(preToolUse("h", "Bash", { command: "ls" }))))?.permissionDecisionReason).toContain("Load these first with the Skill tool: mattpocock-skills:code-review, impeccable. If");
  await skillLoaded("h", "mattpocock-skills:code-review");
  await skillLoaded("h", "impeccable");
  expect(await tryTool("h", "Bash", { command: "ls" })).toBeNull();
  expect(await tryTool("h", "Edit", { file_path: "/a" })).toBeNull();
});

test("a failed Skill call does not count as loaded", async () => {
  start();
  await hired("h", `/tdd${LOAD_FIRST}impeccable.`);
  await skillLoaded("h", "impeccable", "PostToolUseFailure");
  expect(await tryTool("h", "Bash", { command: "ls" })).toBe("deny");
  await skillLoaded("h", "impeccable");
  expect(await tryTool("h", "Bash", { command: "ls" })).toBeNull();
});

test("a --level high Reviewer's APPROVED message is held until security-review has loaded; its other messages and tools are not", async () => {
  start();
  await hired("r", `/code-review high${LOAD_FIRST}ponytail:ponytail-review.${SECURITY} Report to: lead-a\n\nbrief`, "f1rm:reviewer");
  await skillLoaded("r", "ponytail:ponytail-review");
  const send = async (message: string) => held(await hook(preToolUse("r", "SendMessage", { to: "lead-a", message })));
  const out = await send("APPROVED shop-1");
  expect(out.permissionDecision).toBe("deny");
  expect(out.permissionDecisionReason).toBe("Run security-review with the Skill tool on the merge before you send APPROVED.");
  expect(await send("CHANGES shop-1: fix x")).toBeNull();
  expect(await tryTool("r", "Bash", { command: "git merge --no-ff x" })).toBeNull();
  await skillLoaded("r", "security-review", "PostToolUseFailure");
  expect((await send("APPROVED shop-1"))?.permissionDecision).toBe("deny");
  await skillLoaded("r", "security-review");
  expect(await send("APPROVED shop-1")).toBeNull();
});

test("a session with no such sentence, the PM and a freelancer included, is never held", async () => {
  start();
  await hired("p", "Plan the work. Before you start, nothing.", "f1rm:pm");
  await hook({ ...common("f", "UserPromptSubmit"), prompt: `${LOAD_FIRST}impeccable.` }); // the sentence, from a session that is not a company employee
  await hired("m", "/code-review medium", "f1rm:reviewer");
  for (const id of ["p", "f", "m"]) {
    expect(await tryTool(id, "Bash", { command: "ls" })).toBeNull();
    expect(await tryTool(id, "SendMessage", { message: "APPROVED x" })).toBeNull();
  }
});

test("the prompt text never reaches the events table", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "f1rm-db-")), "events.db");
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir, dbPath });
  await hired("h", `/tdd${LOAD_FIRST}impeccable. SECRET-BRIEF`);
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  const rows = (db.query("SELECT event FROM events").all() as { event: string }[]).map((r) => r.event).join("\n");
  db.close();
  expect(rows).toContain("UserPromptSubmit");
  expect(rows).not.toContain("SECRET-BRIEF");
  expect(rows).not.toContain("Before you start");
});
