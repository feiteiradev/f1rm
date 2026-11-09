// Seam 1: the f1rm server, in-process, with the machine module faked.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectFile } from "./editions.ts";
import { GATE_LISTING_MS, startServer } from "./server.ts";
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
// How many times the server asked git for a common dir, so a test can say a request asked at most once, or not at all.
let gitCalls = 0;
const fakeMachine = (repos: Record<string, string> = {}) => ({
  // cwd -> git common dir, canned
  gitCommonDir: (cwd: string) => {
    gitCalls++;
    return repos[cwd] ?? null;
  },
  isRepo: (folder: string) => Object.values(repos).includes(folder + "/.git"),
  liveSessions: async () => new Map([...listing].map(([id, pid]) => [id, { pid }])),
  backgroundId: async (sessionId: string) => backgroundIds[sessionId] ?? null,
  letGo: async (id: string, o?: { afterStop?: () => void }) => {
    calls.push(`letgo ${id}`);
    o?.afterStop?.();
    if (letGoFails) throw new Error(letGoFails);
  },
  stop: async () => true,
  sessions: async () => (sessionsAsked++, await sessionsGate, sessionList),
  mergedBranch: (_repo: string, branch: string) => mergedBranches.has(branch),
  removeWorktree: (repo: string, task: string) => void calls.push(`remove ${repo} ${task}`),
  focusIterm: async (id: string) => (calls.push(`iterm ${id}`), openTabs.has(id)),
  attachInIterm: async (id: string) => void calls.push(`attach ${id}`),
  openVsCode: async (folder: string) => void calls.push(`code ${folder}`),
  tell: async (socket: string, sessionId: string, message: string) => {
    calls.push(`tell ${socket} ${sessionId} ${message}`);
    if (tellFails || socket.includes("dead")) throw new Error(tellFails || "its inbox socket is gone, so the session has ended");
  },
  workingHires: async () => working,
  backgroundSessions: async () => (working === null ? null : [...Array.from({ length: working }, (_, i) => ({ name: `hire-${i}`, state: "working", cwd: "/elsewhere" })), ...liveToo]),
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
let sessionList: { id: string; name: string; kind: string; state: string; cwd: string; sessionId?: string; pid?: number }[] = [];
let mergedBranches = new Set<string>();
let sessionsAsked = 0; // how many times the server asked `claude agents --json --all`
let sessionsGate: Promise<void> | undefined; // a test sets one that never settles: `claude agents` hanging
let working: number | null = 0;
let liveToo: { name: string; state: string; cwd: string }[] = [];
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
  sessionsAsked = 0;
  working = 0;
  liveToo = [];
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

function start(repos?: Record<string, string>, approvalTimeoutMs?: number, boardsDir?: string, extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  // A door needs a registration, which only `f1rm pm` writes: these repos have one, as if it had run.
  const projectsDir = mkdtempSync(join(tmpdir(), "f1rm-projects-"));
  for (const common of new Set(Object.values(repos ?? {}))) writeFileSync(projectFile(projectsDir, common), "{}\n");
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(repos), clientDir, approvalTimeoutMs, boardsDir, projectsDir, isAlive: (pid) => !deadPids.has(pid), ...extra });
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

test("a session in a worktree sits in its main repo's room; a non-git folder with no settings is behind Elsewhere", async () => {
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
  expect(Object.values(state.rooms).map((r) => r.name).sort()).toEqual(["Elsewhere", "blog", "shop"]);
  expect(state.employees.loose).toMatchObject({ room: "elsewhere", cwd: "/Users/me/Downloads" });
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
  expect(busy.employees.parent.status).toBe("idle"); // its own Stop ended its work, and a sub-agent's start does not begin it again

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

test("a Stop or idle notification from inside a sub-agent leaves its parent's status and activity as they were", async () => {
  start();
  await hook(sessionStart("parent", "/code/shop"));
  await hook(preToolUse("parent", "Bash", { command: "make build" }));
  const inside = { agent_id: "agent-1", agent_type: "Explore" };
  await hook({ ...common("parent", "Stop"), ...inside });
  await hook({ ...common("parent", "Notification"), notification_type: "idle_prompt", ...inside });
  expect((await office(() => true)).employees.parent).toMatchObject({ status: "working", activity: "Bash: make build", tool: "Bash" });

  // The parent's own Stop still ends its work.
  await hook({ ...common("parent", "Stop") });
  expect((await office((s) => s.employees.parent?.status === "idle")).employees.parent.activity).toBe("");
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
// Hire reads `~/.f1rm/usage.json` through HOME: an empty HOME keeps this machine's weekly pace and holds out of the tests; `holdHome` holds the 5-hour window at 95%.
const emptyHome = mkdtempSync(join(tmpdir(), "f1rm-home-"));
const holdHome = mkdtempSync(join(tmpdir(), "f1rm-home-"));
mkdirSync(join(holdHome, ".f1rm"));
writeFileSync(join(holdHome, ".f1rm", "usage.json"), JSON.stringify({ fiveHour: { usedPct: 95, resetsAt: Date.now() / 1000 + 86400 }, readAt: 0 }));
const hireOf = async (body: unknown, init: RequestInit = {}, token = TOKEN, homeDir = emptyHome) => {
  const home = process.env.HOME;
  process.env.HOME = homeDir; // shortcut: two hireOf calls in flight at once would race on HOME; none overlap, so await each
  try {
    return await ui("hire", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
};
const FULL_SETTINGS = JSON.stringify({ env: { PONYTAIL_DEFAULT_MODE: "full" }, statusLine: { type: "command", command: `'${process.execPath}' '${join(import.meta.dir, "..", "cli", "f1rm.ts")}' usage-tap` } });
const ASSIGN = { room: ROOM, role: "designer", task: "login-page", brief: "Design the login page. Reply OK and stop." };
const inRoom = (id: string, extra: object) => hook({ ...common(id, "UserPromptSubmit"), cwd: "/code/shop", prompt: "go", ...extra });

const pmPost = (path: "decide" | "start-pm", body: unknown, init: RequestInit = {}, token = TOKEN) =>
  ui(path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init }, token);
const PM_SOCKET = { "x-f1rm-messaging-socket": "/tmp/cc-socks/pm.sock" };

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

test("Start PM needs the UI token, a POST and the browser's own origin", async () => {
  start(SHOP);
  await hook({ ...common("pm1", "UserPromptSubmit"), cwd: "/code/shop", prompt: "plan", agent_type: "f1rm:pm" }, PM_SOCKET);
  await office((s) => ROOM in s.rooms);
  const json = { "content-type": "application/json" };
  for (const path of ["start-pm"] as const) {
    const body = { room: ROOM };
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

/** What Claude Code offers for an allow rule in `permission_suggestions`. */
const suggest = (ruleContent: string, destination = "localSettings") => [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent }], behavior: "allow", destination }];
const permissionRequest = (id: string, command: string, permission_suggestions?: object[]) => ({ ...preToolUse(id, "Bash", { command }), hook_event_name: "PermissionRequest", ...(permission_suggestions && { permission_suggestions }) });
const decide = (verb: "approve" | "deny" | "always", id: string, token = TOKEN, init: RequestInit = {}) =>
  fetch(`${base()}/${token}/${verb}/${id}`, { method: "POST", ...init });
/** Sends a PermissionRequest and returns its still-held response with the approval the office lists for it. */
async function raiseHand(session = "s1", command = "rm -rf build", suggestions?: object[]) {
  const held = hook(permissionRequest(session, command, suggestions));
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

test("a sub-agent's events do not drop the session's pending hand, its own next event still does", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held: pending, approval } = await raiseHand();
  const sub = (event: string, extra: object = {}) => hook({ ...common("s1", event), agent_id: "agent-1", agent_type: "Explore", ...extra });
  await sub("SubagentStart");
  await sub("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/code/shop/a.ts" }, tool_use_id: "toolu_9" });
  await sub("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/code/shop/a.ts" }, tool_response: {} });
  await sub("SubagentStop", { agent_transcript_path: "/t", last_assistant_message: "done" });
  await hook({ ...common("s1", "SubagentStop"), agent_id: "agent-2", agent_type: "Explore" }); // a stop whose start the office never saw
  expect(await settled(pending)).toBe(false);
  expect((await office(() => true)).approvals!.map((a) => a.id)).toEqual([approval.id]);
  await hook({ ...common("s1", "PostToolUse"), tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: {} }); // answered in the terminal
  const answer = await pending;
  expect([answer.status, await answer.text()]).toEqual([200, ""]);
});

test("a sub-agent's own pending hand is released by that sub-agent's next event, and by nothing else", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held: parent, approval: parentHand } = await raiseHand("s1", "make build");
  const subRequest = (agent: string, command: string) => hook({ ...permissionRequest("s1", command), agent_id: agent, agent_type: "Explore" });
  const sub = (agent: string, event: string, extra: object = {}) => hook({ ...common("s1", event), agent_id: agent, agent_type: "Explore", ...extra });
  const mine = subRequest("agent-1", "ls docs");
  const other = subRequest("agent-2", "ls src");
  const hands = (await office((s) => (s.approvals ?? []).length === 3)).approvals!;
  expect(hands.map((a) => (a.input as any).command).sort()).toEqual(["ls docs", "ls src", "make build"]);
  // the parent's own event, a third sub-agent's and agent-2's do not release agent-1's request
  await hook({ ...common("s1", "Notification"), message: "m", notification_type: "idle_prompt" });
  await sub("agent-3", "PreToolUse", { tool_name: "Read", tool_input: { file_path: "/code/shop/a.ts" }, tool_use_id: "toolu_3" });
  await sub("agent-2", "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls src" }, tool_response: {} }); // agent-2 answered in the terminal
  const answer2 = await other;
  expect([answer2.status, await answer2.text()]).toEqual([200, ""]);
  expect(await settled(mine)).toBe(false);
  expect((await office((s) => s.approvals!.length === 2)).approvals!.map((a) => (a.input as any).command).sort()).toEqual(["ls docs", "make build"]);
  // agent-1's next event releases agent-1's request only, and the parent keeps its own
  await sub("agent-1", "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls docs" }, tool_response: {} });
  const answer1 = await mine;
  expect([answer1.status, await answer1.text()]).toEqual([200, ""]);
  expect((await office((s) => s.approvals!.length === 1)).approvals!.map((a) => a.id)).toEqual([parentHand.id]);
  expect(await settled(parent)).toBe(false);
  // a sub-agent that stops lets go of its hand; the parent's own next event lets go of the parent's
  const stopping = subRequest("agent-4", "ls lib");
  await office((s) => s.approvals!.length === 2);
  await sub("agent-4", "SubagentStop", { last_assistant_message: "done" });
  expect((await stopping).status).toBe(200);
  await hook({ ...common("s1", "PostToolUse"), tool_name: "Bash", tool_input: { command: "make build" }, tool_response: {} });
  expect(await (await parent).text()).toBe("");
  expect((await office((s) => s.approvals!.length === 0)).approvals).toEqual([]);
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

test("a permission request lists why the hire asks (its last words, cut to 300), whether Always can be offered, and the rule it would add", async () => {
  start(undefined, undefined, undefined, { transcriptsDir: transcripts });
  await hook(sessionStart("s1", "/code/shop"));
  // Claude Code writes the call's line a moment after the hook fires: the words are there, the call is not, so the card has no why until the office reads again.
  const words = { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Clearing the build folder so the next build is clean. " + "z".repeat(400) }] } };
  const path = transcript("s1", [{ type: "assistant", message: { id: "m0", content: [{ type: "text", text: "An earlier step." }] } }, words]);
  const held1 = hook({ ...permissionRequest("s1", "rm -rf build", suggest("rm -rf build", "session")), transcript_path: path });
  expect((await office((s) => (s.approvals ?? []).length === 1)).approvals![0].why).toBe("");
  appendFileSync(path, JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -rf build" } }] } }) + "\n");
  const [first] = (await office((s) => (s.approvals ?? []).some((a) => a.why !== ""), 2500)).approvals!;
  expect(first.why).toStartWith("Clearing the build folder so the next build is clean. zzz");
  expect([first.why.length, first.canAlways, first.rule]).toEqual([300, true, "Bash(rm -rf build)"]);
  await decide("deny", first.id);
  await held1;
  // Claude Code suggested nothing: the office makes no rule of its own.
  const plain = hook({ ...permissionRequest("s1", "npm run proofa"), transcript_path: "/not/the/session's/file.jsonl" });
  const [second] = (await office((s) => (s.approvals ?? []).length === 1)).approvals!;
  expect([second.why, second.canAlways, second.rule]).toEqual(["", false, ""]);
  await decide("deny", second.id);
  await plain;
});

test("Always for this project allows the request and returns exactly the rule Claude Code suggested, for the repo's local settings", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held: pending, approval } = await raiseHand("s1", "npm run proofa", suggest("npm run proofa", "session"));
  const res = await decide("always", approval.id);
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(await (await pending).json()).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run proofa" }], behavior: "allow", destination: "localSettings" }] },
    },
  });
  expect((await office(() => true)).approvals).toEqual([]);
  expect((await decide("always", approval.id)).status).toBe(404); // answered once
});

test("Always is refused for a request Claude Code suggested no rule for, and the request stays held", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held: pending, approval } = await raiseHand("s1", "git config core.sshCommand x");
  expect([approval.canAlways, approval.rule]).toEqual([false, ""]);
  expect((await decide("always", approval.id)).status).toBe(409);
  expect(await settled(pending)).toBe(false);
  expect((await decide("approve", approval.id)).status).toBe(200);
});

test("Always takes the UI token, a POST and the browser's own origin, like Approve and Deny", async () => {
  start();
  await hook(sessionStart("s1", "/code/shop"));
  const { held: pending, approval } = await raiseHand("s1", "git status", suggest("git status"));
  expect((await decide("always", approval.id, "wrong")).status).toBe(401);
  expect((await fetch(`${base()}/always/${approval.id}`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base()}/${TOKEN}/always/${approval.id}`)).status).toBe(405);
  expect((await decide("always", approval.id, TOKEN, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await decide("always", "no-such-id")).status).toBe(404);
  expect(await settled(pending)).toBe(false);
});

const seatAt = (id: string, title: string, agent_type: string) => hook({ ...common(id, "UserPromptSubmit"), cwd: "/code/shop", prompt: "go", session_title: title, agent_type });
const needing = async (until: (s: OfficeState) => boolean) => Object.values((await office(until)).employees).filter((e) => e.needsYou).map((e) => e.title);

test("a lead whose own permission request waits on the user is tagged needsYou until it is answered; a hire's request tags nobody", async () => {
  start({ "/code/shop": "/code/shop/.git" });
  await seatAt("l1", "lead-checkout", "f1rm:lead");
  await seatAt("m1", "checkout.backend-dev-a", "f1rm:backend-dev");
  await seatAt("p1", "pm-shop", "f1rm:pm");
  const hire = hook({ ...permissionRequest("m1", "ls"), cwd: "/code/shop" });
  await office((s) => (s.approvals ?? []).length === 1);
  expect(await needing(() => true)).toEqual([]);
  const lead = hook({ ...permissionRequest("l1", "ls"), cwd: "/code/shop" });
  const state = await office((s) => (s.approvals ?? []).length === 2);
  expect(await needing(() => true)).toEqual(["lead-checkout"]);
  await decide("approve", state.approvals!.find((a) => a.sessionId === "l1")!.id);
  await lead;
  expect(await needing((s) => s.approvals!.length === 1)).toEqual([]);
  await decide("deny", state.approvals!.find((a) => a.sessionId === "m1")!.id);
  await hire;
});

// The PreToolUse reply: a deny holds the call, an empty 200 lets it run.
async function held(r: Response) {
  const body = await r.text();
  return body ? JSON.parse(body).hookSpecificOutput : null;
}

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

test("`f1rm report` is no hire, wake, push or session start: a specialist and a Reviewer run it, even with those words in the note", async () => {
  await delegationOffice();
  const run = async (id: string, command: string) => (await held(await hook(preToolUse(id, "Bash", { command }))))?.permissionDecision ?? null;
  for (const id of ["d", "v"]) {
    for (const command of ["f1rm report DONE checkout --commit abc1234", 'f1rm report BLOCKED checkout --note "f1rm hire a lead; git push; claude --bg"', "cd /code/shop && bun office/cli/f1rm.ts report CHANGES review-checkout --commit abc1234"]) {
      expect([id, command, await run(id, command)]).toEqual([id, command, null]);
    }
  }
});

test("`f1rm letgo` follows the wake rules: the PM lets go leads and its simple hires and runs --leftovers, a lead the members of its own team, a specialist, an intern and a Reviewer nobody", async () => {
  await talkOffice();
  const run = async (id: string, command: string, extra = {}) => held(await hook({ ...preToolUse(id, "Bash", { command }), cwd: "/code/shop", ...extra }));
  const decision = async (id: string, command: string, extra = {}) => (await run(id, command, extra))?.permissionDecision ?? null;
  for (const id of ["c1", "rv"]) {
    for (const command of ["f1rm letgo checkout.backend-dev-old", "bun office/cli/f1rm.ts letgo lead-checkout", "f1rm letgo --leftovers", "ls && f1rm letgo designer-landing"]) {
      const out = await run(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the PM and team leads let go");
    }
  }
  for (const command of ["f1rm letgo checkout.backend-dev-old", "f1rm letgo checkout.reviewer-review-old checkout.designer-a", "ls && f1rm letgo checkout.backend-dev-b"]) {
    expect([command, await decision("l1", command)]).toEqual([command, null]);
  }
  for (const command of ["f1rm letgo search.backend-dev-x", "f1rm letgo lead-search", "f1rm letgo lead-checkout", "f1rm letgo designer-landing", "f1rm letgo checkout.backend-dev-old search.backend-dev-x", "f1rm letgo --leftovers", "f1rm letgo ghost", "f1rm letgo my-own-session"]) {
    const out = await run("l1", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toMatch(/A lead lets go only the members of its own team|PM lets go leads|Only the PM runs/);
  }
  for (const command of ["f1rm letgo lead-old", "f1rm letgo lead-search lead-checkout", "f1rm letgo designer-landing", "f1rm letgo --leftovers"]) {
    expect([command, await decision("pm", command)]).toEqual([command, null]);
  }
  for (const command of ["f1rm letgo checkout.backend-dev-old", "f1rm letgo lead-old checkout.reviewer-review-old", "f1rm letgo ghost"]) { // a name that is no hire's too
    const out = await run("pm", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("The PM lets go leads and its simple tasks' devs");
  }
  for (const id of ["pm", "l1"]) expect([id, await decision(id, "f1rm letgo lead-old", { agent_id: "agent-1", agent_type: "Explore" })]).toEqual([id, "deny"]); // an intern
  expect(await decision("free", "f1rm letgo checkout.backend-dev-old")).toBeNull(); // the user's own session
  expect(await decision("free", "f1rm letgo --leftovers")).toBeNull();
  for (const command of ['git log --grep "mentions f1rm letgo x"', 'grep "f1rm letgo" README.md', "f1rm letgone", "f1rm archives"]) expect([command, await decision("c1", command)]).toEqual([command, null]);
  // pruning deletes archives: the PM's alone, in any spelling
  const prunes = ["f1rm archives --prune", "f1rm archives --prune=1", "bun office/cli/f1rm.ts archives --prune", "ls && f1rm archives --list --prune", "f1rm archives -- --prune"];
  for (const id of ["c1", "rv", "l1"]) {
    for (const command of prunes) {
      const out = await run(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the PM prunes");
    }
  }
  for (const command of prunes) expect([command, await decision("pm", command)]).toEqual([command, null]);
  expect(await decision("pm", "f1rm archives --prune", { agent_id: "agent-1", agent_type: "Explore" })).toBe("deny");
  expect(await decision("free", "f1rm archives --prune")).toBeNull();
});

test("only the PM runs `f1rm pause` and `f1rm resume`; a lead, a specialist, a Reviewer and a PM's intern are refused, no session runs --all, and the user's own session runs the rest", async () => {
  await delegationOffice();
  await hook({ ...common("v", "UserPromptSubmit"), prompt: "go", session_title: "checkout.reviewer-review-a", agent_type: "f1rm:reviewer" });
  const run = async (id: string, command: string, extra = {}) => held(await hook({ ...preToolUse(id, "Bash", { command }), ...extra }));
  const decision = async (id: string, command: string, extra = {}) => (await run(id, command, extra))?.permissionDecision ?? null;
  const mine = ["f1rm pause", "f1rm resume", "f1rm pause going to lunch", "cd /code/shop && bun office/cli/f1rm.ts resume", "ls && f1rm pause 'back at two'"];
  for (const command of mine) expect([command, await decision("p", command)]).toEqual([command, null]);
  for (const id of ["l", "d", "v"]) {
    for (const command of mine) {
      const out = await run(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the PM pauses and resumes");
    }
  }
  expect(await decision("p", "f1rm pause", { agent_id: "agent-1", agent_type: "Explore" })).toBe("deny"); // the PM's intern is not the PM
  for (const id of ["p", "l", "d", "v"]) {
    for (const command of ["f1rm pause --all", "f1rm resume --all", "f1rm pause why --all", "bun office/cli/f1rm.ts resume --all"]) {
      const out = await run(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      if (id === "p") expect(out.permissionDecisionReason).toContain("`--all` is the user's alone");
    }
  }
  // A session with no company role runs its own project's pause and resume, but not --all: no session does. A plain terminal fires no hook at all, and so still may.
  for (const command of mine) expect([command, await decision("f", command)]).toEqual([command, null]);
  for (const command of ["f1rm pause --all", "f1rm resume --all", "bun office/cli/f1rm.ts pause why --all"]) expect([command, await decision("f", command)]).toEqual([command, "deny"]);
  for (const command of ['git log --grep "f1rm pause"', 'grep "f1rm resume" README.md', "echo 'ls; f1rm pause'", "f1rm paused", "f1rm status"]) {
    expect([command, await decision("l", command)]).toEqual([command, null]);
  }
});

test("a session does not call the office's pause or resume route itself: a command that names the route and the office's token or port is refused, whoever runs it, a session of no role too", async () => {
  await delegationOffice();
  const run = async (id: string, command: string) => (await held(await hook(preToolUse(id, "Bash", { command }))))?.permissionDecision ?? null;
  for (const id of ["p", "l", "d"]) {
    for (const route of ["pause", "resume"]) {
      expect(await run(id, `curl -s -X POST ${base()}/${TOKEN}/${route} -d '{"all":true}'`)).toBe("deny");
      expect(await run(id, `curl -s -X POST "$(cat ~/.f1rm/office-url)${route}" -d '{"all":true}'`)).toBe("deny");
    }
  }
  expect(await run("l", "curl -s https://example.com/pause")).toBeNull();
  expect(await run("f", `curl -s -X POST ${base()}/${TOKEN}/pause -d '{"all":true}'`)).toBe("deny"); // a session of no role is a session too
});

// A PM, a lead, a designer and a freelancer, to see which of the delegation rules reach whom.
async function delegationOffice(boardsDir?: string) {
  start(undefined, undefined, boardsDir);
  for (const [id, type] of [["p", "f1rm:pm"], ["l", "f1rm:lead"], ["d", "f1rm:designer"], ["f", undefined]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", session_title: `${id}-title`, ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 4);
}

test("a PM's or lead's Write, Edit and NotebookEdit land only in boards, milestones, kept, memory, evidence and scratch; others write anywhere", async () => {
  await delegationOffice("/home/me/.f1rm/boards");
  const home = process.env.HOME;
  process.env.HOME = "/home/me";
  afterEachRestore = () => (process.env.HOME = home);
  const write = async (id: string, tool: string, file_path: string) => held(await hook(preToolUse(id, tool, tool === "NotebookEdit" ? { notebook_path: file_path } : { file_path })));
  const allowed = ["/home/me/.f1rm/boards/shop.md", "/home/me/.f1rm/milestones/-code-shop.md", "/home/me/.claude/agent-memory/pm/notes.md", "/home/me/.f1rm/evidence/a/shot.png", "/home/me/.f1rm/kept/shop/notes.md", "/private/tmp/claude-501/x/scratchpad/n.md", "/tmp/claude-501/n.md"];
  const refused = ["/home/me/.f1rm/kept", "/home/me/.f1rm/kept-evil/x.md", "/home/me/.f1rm/kept/../events.db", "/home/me/.f1rm/other/x.md", "/home/me/kept/x.md","/code/shop/src/login.ts", "/home/me/.f1rm/boards/../events.db", "/home/me/.f1rm/milestones/../../x", "/home/me/.f1rm/milestones-evil/x.md", "/home/me/.claude/agent-memory-evil/x.md", "src/login.ts"];
  for (const id of ["p", "l"]) {
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      for (const file of allowed) expect([id, tool, file, await write(id, tool, file)]).toEqual([id, tool, file, null]);
      for (const file of refused) {
        const out = await write(id, tool, file);
        expect([id, tool, file, out?.permissionDecision]).toEqual([id, tool, file, "deny"]);
        expect(out.permissionDecisionReason).toBe("The PM writes only its scratch files and its repo's tracker setup (CLAUDE.md, AGENTS.md, docs/agents/), and the office's steps only scratch files: code is built by the implement step's interns, in their worktrees.");
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
    for (const file of [".f1rm/milestones/x.md", ".f1rm/kept/x.md", ".f1rm/evidence/x.md", ".claude/agent-memory/x.md"]) {
      const out = await write(id, join(process.cwd(), file));
      expect([id, file, out?.permissionDecision]).toEqual([id, file, "deny"]);
    }
    expect(await write(id, "/home/me/.f1rm/boards/shop.md")).toBeNull();
  }
});

test("a PM's or lead's landing git commands are refused, past global options; read-only git and everyone else's are not", async () => {
  await delegationOffice();
  const bash = async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
  const landing = ["git merge agent-comms", "git -C x push", "git commit -m 'a; b'", "cd x && git -C '/my repo' -c core.editor=true rebase main", "git --no-pager reset --hard", "git cherry-pick abc", "FOO=1 git push origin main | cat", "echo $(git commit -am x)", "git pull origin main", "git -C x am fix.patch", "git revert abc", "gh pr merge 3 --squash", "cd x && gh pr merge 3", "if true; then git merge x; fi", "time git commit -am x", "! git revert abc", "env gh pr merge 3", "gh api -X PUT repos/o/r/pulls/3/merge", "timeout 5 git commit -am x"];
  const readOnly = ["gh api --method POST repos/o/r/issues/3/dependencies/blocked_by -F issue_id=9", "gh api --method POST repos/o/r/issues/3/sub_issues -F sub_issue_id=9", "git log --oneline", "git status", "git diff HEAD", "git show abc", "git rev-parse HEAD", "git worktree list", "git -C x log", "git log --grep 'git push; git merge'", "echo git push", "gh pr view 3"];
  for (const id of ["p", "l"]) {
    for (const command of landing) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
    for (const command of readOnly) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  // A specialist lands on its own branch, but never pushes (see the push test); a freelancer is held by nothing.
  for (const command of landing) expect(await bash("f", command)).toBeNull();
  for (const command of landing.filter((c) => !/push|pr merge|gh api/.test(c))) expect(await bash("d", command)).toBeNull();
});

test("a company employee's Agent or Task call for an f1rm role is refused; an ordinary intern, and a freelancer's call, are not", async () => {
  await delegationOffice();
  const call = async (id: string, tool: string, subagent_type: string) => held(await hook(preToolUse(id, tool, { description: "x", prompt: "x", subagent_type })));
  for (const id of ["p", "l", "d"]) {
    for (const tool of ["Agent", "Task"]) {
      const out = await call(id, tool, "f1rm:backend-dev");
      expect([id, tool, out?.permissionDecision]).toEqual([id, tool, "deny"]);
      expect(out.permissionDecisionReason).toBe("A role is hired with `f1rm hire`, never started as an intern.");
    }
  }
  expect(await call("p", "Agent", "Explore")).toBeNull();
  expect(await call("l", "Task", "general-purpose")).toBeNull();
  expect(await call("d", "Agent", "Explore")).toBeNull();
  expect(await call("f", "Agent", "f1rm:backend-dev")).toBeNull();
});

test("/loop is refused for every company employee, as the Skill call and as the tools it schedules with; a freelancer is not held", async () => {
  await delegationOffice();
  const run = async (id: string, tool: string, input: object) => held(await hook(preToolUse(id, tool, input)));
  for (const id of ["p", "l", "d"]) {
    for (const [tool, input] of [["Skill", { skill: "loop", args: "5m /foo" }], ["Skill", { skill: "pstack:loop" }], ["ScheduleWakeup", { delaySeconds: 60, prompt: "x", reason: "x" }], ["CronCreate", { cron: "*/5 * * * *", prompt: "x" }], ["Skill", { skill: "schedule" }], ["Skill", { skill: "/schedule", args: "daily" }], ["Skill", { skill: "x:schedule" }], ["RemoteTrigger", { action: "create" }]] as const) {
      const out = await run(id, tool, input);
      expect([id, tool, out?.permissionDecision]).toEqual([id, tool, "deny"]);
      expect(out.permissionDecisionReason).toContain("/loop");
    }
    for (const skill of ["tdd", "loops", "scheduler", "schedules", "mattpocock-skills:tdd"]) expect([id, skill, await run(id, "Skill", { skill })]).toEqual([id, skill, null]);
  }
  expect(await run("f", "Skill", { skill: "loop" })).toBeNull();
});

// What a raw `claude` session start may be: nothing, except the PM's and a lead's `--bg --resume`, and a second-office proof that sets its own HOME.
test("a company employee starts no session with claude --bg or claude -p; the PM's and a lead's --bg --resume and a command with its own HOME pass", async () => {
  await delegationOffice();
  const bash = async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
  const real = userInfo().homedir;
  const refused = ["claude --bg 'do x'", "claude --background x", "claude -p 'x'", "claude --print x", "claude -p --resume abc", "claude --bg --name x", "cd /code/shop && claude --bg x", "nohup claude -p x &", "ls; /usr/local/bin/claude --bg x", "FOO=1 claude -p x", `HOME=${real} claude -p x`, "HOME=$HOME claude -p x", "HOME=~ claude -p x", "HOME= claude -p x", 'HOME="$HOME" claude -p x', "claude --model opus -p x", "env -u FOO claude --bg x", "HOME=$(echo ~) claude -p x", `HOME=${real.toLowerCase()} claude -p x`, `HOME=${real.toUpperCase()} claude -p x`, `HOME=/System/Volumes/Data${real} claude -p x`, `HOME=${real}/ claude -p x`, `HOME=${real}/. claude -p x`, "HOME=/ claude -p x", "echo HOME=/x; claude -p 'work'", "export HOME=/tmp/h-2; claude -p x", "HOME=/tmp/h true; claude -p x", "HOME=/tmp/h-6 true && claude --bg x", "HOME=relative/h claude -p x", "HOME=~/h claude -p x", "HOME=$TMPDIR/h claude -p x", "HOME=`pwd` claude -p x", "HOME=$(mktemp -d)/x claude -p x", "HOME=$(pwd) claude -p x", "FOO=HOME=/tmp/h claude -p x", "claude -p 'HOME=/tmp/h'", "npx @anthropic-ai/claude-code -p x", "npx -y @anthropic-ai/claude-code --bg x", "npx @anthropic-ai/claude-code@latest -p x", "bunx claude --bg x", "bun x claude -p x", "pnpm dlx @anthropic-ai/claude-code -p x", "yarn dlx claude --print x", "claude -cp 'x'", "claude -pc x", "npx claude -c -p x", "npm exec @anthropic-ai/claude-code -p x", "pnpx @anthropic-ai/claude-code -p x", "npx @anthropic-ai/claude-code@^2 -p x", "npx @anthropic-ai/claude-code@~2.1 -p x", "npx @anthropic-ai/claude-code@>=2 --bg x", "\\claude -p x", "claude --bg --resume abc --fork-session", "claude --bg --resume=abc --fork-session", "claude -p -- x", "npm exec @anthropic-ai/claude-code -- -p x", "npm exec claude -- --bg x", "npm exec -y @anthropic-ai/claude-code -- -cp x", "Claude -p x", "CLAUDE --bg x", "HOME=/tmp/x env -u 'HOME' claude -p x", "HOME=/tmp/x env -u \"HOME\" claude -p x", "HOME=/tmp/x env - claude -p x", "HOME=/tmp/x env -u FOO -i claude -p x", "HOME=/tmp/x env -S -i claude -p x", "HOME=/tmp/x env F1RM_PORT=4999 env -u HOME claude -p x", "HOME=/tmp/x env FOO=1 env -i claude -p x"];
  const allowed = ["claude agents --json", "claude --version", "claude mcp list", "claude", "echo claude --bg", "git log --grep 'run claude -p later'", "grep 'claude -p' README.md", "claude --resume abc", "HOME=/tmp/h-1 claude -p 'x'", `HOME=${real}/Library/Caches/h-1 claude --bg x`, "env HOME=/tmp/h-3 claude -p x", "HOME=$(mktemp -d) claude -p x", "HOME=/tmp/h-5 F1RM_PORT=4999 nohup claude --bg x", "cd /code/shop && HOME='/tmp/h-7' claude -p x", "HOME=\"/tmp/h-8\" timeout 60 claude -p x", "npx @anthropic-ai/claude-code --version", "claude mcp add x -- npx -y srv -sp 1", "npm exec @anthropic-ai/claude-code --version", "npm exec -- @anthropic-ai/claude-code mcp add x -- npx srv -sp 1", "HOME=/tmp/x env F1RM_PORT=4999 stdbuf -i 0 claude -p x", "HOME=/tmp/x stdbuf -i 0 claude -p x", "HOME=/tmp/x nice -n 5 claude -p x", "npx tsc -p .", "bun x tsc -p .", "bunx prettier -p x", "claude -c", "npx HOME=/tmp/h-9 claude", "HOME=/tmp/h-9 npx @anthropic-ai/claude-code -p x", "HOME=/tmp/h-4 F1RM_PORT=4999 bun office/cli/f1rm.ts serve"];
  const wake = ["claude --bg --resume abc-123", "cd x && claude --resume abc --bg", "claude --bg -r abc", "npx @anthropic-ai/claude-code --bg --resume abc"];
  for (const id of ["p", "l", "d"]) {
    for (const command of refused) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Sessions start only from the office");
    }
    for (const command of allowed) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  for (const id of ["p", "l"]) for (const command of wake) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  for (const command of wake) expect([command, (await bash("d", command))?.permissionDecision]).toEqual([command, "deny"]);
  for (const command of [...refused, ...wake]) expect([command, await bash("f", command)]).toEqual([command, null]);
});

// The user's /f1rm:stop-all and /f1rm:resume-all run `f1rm pause --all` in a `!` block, which fires no hook; a session that starts or resumes another claude with that command as its prompt would run it too.
test("no session starts or resumes a claude with /f1rm:stop-all or /f1rm:resume-all as its prompt, in any spelling, a second office's HOME and a plain session included; nor with a prompt the office cannot read; an ordinary resume and a written-out prompt pass", async () => {
  await delegationOffice();
  const bash = async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
  // Plain spellings of the command, a HOME prefix, and prompts the gate cannot read (a pipe, a redirect, a variable) are refused for every session.
  const refused = [
    'claude --bg --resume abc "/f1rm:stop-all"', "claude --bg --resume abc '/f1rm:resume-all'", 'claude --bg -r abc "  /stop-all"', 'claude -p "/f1rm:stop-all"', 'claude --bg x "/f1rm:resume-all now"', 'cd x && claude --resume abc --bg "/resume-all"',
    "claude --bg --resume abc -- /f1rm:stop-all", "claude -p -- '/f1rm:resume-all'",
    'claude -p "/f1rm:stop-"all', "claude -p $'/f1rm:stop-all'", "claude -p /f1rm:stop\\-all", "claude -p '/f1rm:stop'-all", 'claude --bg --resume abc ""/f1rm:resume-all',
    'HOME=/tmp/h-1 claude -p "/f1rm:stop-all"', 'HOME=$(mktemp -d) claude --bg "/f1rm:resume-all"', 'env HOME=/tmp/h-1 claude -p /resume-all',
    'claude -p "$(cat /tmp/x)"', "claude --bg --resume abc $PROMPT", 'claude -p "$PROMPT"', 'claude -p "a `cat f`"', 'HOME=/tmp/h-1 claude -p "${PROMPT}"',
    "echo /f1rm:stop-all | claude -p", "cat f | claude --bg --name x", "cat f | HOME=/tmp/h-1 claude -p", "claude -p < prompt.txt", "claude --bg --name x <prompt.txt", 'claude -p <<< "/f1rm:stop-all"', "HOME=/tmp/h-1 claude --bg --name x < prompt.txt",
  ];
  const everywhere = ['HOME=/tmp/h-1 claude -p "x"', 'cat f | HOME=/tmp/h-1 claude -p "review it"', 'HOME=/tmp/h-1 claude -p "x" || echo failed', 'HOME=/tmp/h-1 claude --bg --name x "continue; /f1rm:stop-all is the user\'s"', 'echo "/f1rm:stop-all"', 'echo x | grep y; echo claude'];
  const wake = ['claude --bg --resume abc "continue; /f1rm:stop-all is the user\'s"', "claude --bg --resume abc 'resumed; continue your task'", 'false || claude --bg --resume abc "go on"'];
  const plain = ['claude -p "/code-review"', 'cat f | claude -p "review it"'];
  for (const id of ["p", "l", "d", "f"]) {
    for (const command of refused) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("slash command");
    }
    for (const command of everywhere) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  for (const id of ["p", "l"]) for (const command of wake) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  for (const command of [...wake, ...plain]) expect([command, await bash("f", command)]).toEqual([command, null]);
  // The session's own `--all` stays refused whoever it is: the slash command is the user's, typed.
  for (const id of ["p", "l", "d", "f"]) expect([id, (await bash(id, "f1rm pause --all"))?.permissionDecision]).toEqual([id, "deny"]);
});

test("in a second office, whose own HOME is a temp folder, the user's real home still counts as the real one for claude starts", async () => {
  await delegationOffice();
  const second = "/tmp/f1rm-second-office-home"; // only a HOME string: nothing is created
  const real = userInfo().homedir;
  const home = process.env.HOME;
  process.env.HOME = second;
  afterEachRestore = () => void (home === undefined ? delete process.env.HOME : (process.env.HOME = home));
  const bash = async (id: string, command: string) => (await held(await hook(preToolUse(id, "Bash", { command }))))?.permissionDecision ?? null;
  for (const command of [`HOME=${real} claude -p x`, `HOME=${real.toUpperCase()} claude -p x`, `HOME=/System/Volumes/Data${real} claude -p x`, `HOME=${second} claude -p x`]) expect([command, await bash("p", command)]).toEqual([command, "deny"]);
  for (const command of [`HOME=${second}/h claude -p x`, "HOME=/tmp/x env -i HOME=/tmp/y claude -p x"]) expect([command, await bash("p", command)]).toEqual([command, null]);
  // A later `env` option that clears HOME undoes the prefix; one before it does not.
  const cleared = ["HOME=/tmp/x env -u HOME claude -p x", "HOME=/tmp/x env -i claude -p x", "HOME=/tmp/x env --ignore-environment claude -p x", "HOME=/tmp/x env --unset=HOME claude -p x", "HOME=/tmp/x env --unset HOME claude -p x", "HOME=/tmp/x env -uHOME claude -p x"];
  for (const command of cleared) expect([command, await bash("p", command)]).toEqual([command, "deny"]);
  for (const command of ["env -i HOME=/tmp/x claude -p x", "env -u FOO HOME=/tmp/x claude -p x", "HOME=/tmp/x env -u FOO claude -p x"]) expect([command, await bash("p", command)]).toEqual([command, null]);
  const out = await held(await hook(preToolUse("p", "Bash", { command: "claude -p x" })));
  expect(out.permissionDecisionReason).toContain("a literal absolute path or exactly `$(mktemp -d)`");
  // An office with an empty HOME has none to refuse: the folder it runs in is not it.
  process.env.HOME = "";
  expect(await bash("p", `HOME=${process.cwd()} claude -p x`)).toBeNull();
});

test("a background shell watcher (Bash with run_in_background) is not held for the PM, a lead or anyone else", async () => {
  await delegationOffice();
  for (const id of ["p", "l", "d", "f"]) {
    expect([id, await held(await hook(preToolUse(id, "Bash", { command: "while :; do sleep 60; done", run_in_background: true })))]).toEqual([id, null]);
  }
});

// The refusals of landing and of a raw push name the company's own paths: `f1rm merge` for the PM and the leads, `f1rm push` for the PM.
const LANDING_REFUSAL = "Land with `f1rm merge spec-<n>`, which the close step runs in the main working directory; `git push` and merging pull requests stay refused for everyone, and `f1rm push` is the close step's once a spec landed.";
const PUSH_REFUSAL = "The company pushes only with `f1rm push`, which a close step runs once a spec landed";

// A PM, the checkout lead, a designer, a Reviewer and a freelancer, for the hire and push rules.
async function gateOffice() {
  start();
  for (const [id, type, title] of [["p", "f1rm:pm", "p-title"], ["l", "f1rm:lead", "lead-checkout"], ["d", "f1rm:designer", "d-title"], ["v", "f1rm:reviewer", "v-title"], ["f", undefined, "f-title"]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", session_title: title, ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 5);
  return async (id: string, command: string) => held(await hook(preToolUse(id, "Bash", { command })));
}

test("no session answers a permission request through the office's approve, deny and always routes; the user's browser does", async () => {
  const bash = await gateOffice();
  const at = `http://127.0.0.1:${server.port}`;
  const refused = [
    `curl -s -X POST ${at}/${TOKEN}/approve/abc`,
    `curl -s -X POST "http://localhost:${server.port}/anything/deny/abc"`,
    `curl -s -X POST ${at}/${TOKEN}/always/abc`,
    `cd /code/shop && curl -s -X POST -m 5 http://[::1]:${server.port}/x/approve/abc || true`,
    `curl -X POST "$(cat ~/.f1rm/office-url)approve/abc"`,
    `bun -e "fetch('${at}/' + process.env.T + '/always/abc', {method:'POST'})"`,
    `curl -X POST http://example.test/${TOKEN}/approve/abc`,
    `curl -s -X POST ${at}/${TOKEN}/leftovers/remove`,
    `curl -s -X POST ${at}/${TOKEN}/leftovers/keep`,
    `curl -X POST "$(cat ~/.f1rm/office-url)leftovers/remove"`,
    `bun -e "fetch('${at}/' + process.env.T + '/leftovers/remove', {method:'POST'})"`,
  ];
  for (const id of ["d", "l", "p", "v"]) {
    for (const command of refused) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the user answers a permission request, in the office");
    }
  }
  // Other calls to the office, other apps' routes and a mention of the words pass; a session with no role is the user's own and is never held.
  for (const command of [`curl -s ${at}/ingest`, "curl -s -X POST http://localhost:3000/approve/12", "git log --grep=approve/ -n 1", "grep -rn 'deny/' README.md", `curl -s ${at}/${TOKEN}/jump/abc`]) expect([command, await bash("d", command)]).toEqual([command, null]);
  expect(await bash("f", refused[0])).toBeNull();
});

test("a lead whose name carries no team can hire into none", async () => {
  start();
  await hook({ ...common("l", "UserPromptSubmit"), prompt: "go", session_title: "plain", agent_type: "f1rm:lead" });
  await office((s) => Object.keys(s.employees).length === 1);
  expect((await held(await hook(preToolUse("l", "Bash", { command: "f1rm hire --team plain backend-dev plain.backend-dev-a a b" }))))?.permissionDecision).toBe("deny");
});

const PUSHES = ["git push", "git push origin main", "git -C . push", "git -C '/my repo' -c core.editor=true push --tags", "cd x && git push", "FOO=1 git push | cat", "git 'push'", "gh pr merge 3", "gh pr merge 3 --squash", "cd x && gh pr merge 3", "if git diff --quiet; then echo ok; else git push; fi", "then git push", "! git push", "{ git push; }", "env git push", "env -i FOO=1 git push", "command git push", "exec git push", "time git push", "nohup git push &", "xargs git push", "sudo git push", "while true; do git push; done", "git --config-env x=Y push", "'gh' pr merge 3", "gh pr -R o/r merge 3", "gh --repo o/r pr merge 3", "gh -R o/r pr merge 3", "timeout 60 git push", "timeout 1e3 git push", "timeout .5 git push", "timeout infinity git push", "timeout -s KILL infinity git push", "timeout -k 5 60 git push", "timeout --signal KILL 1.5m git push", "timeout 60 gh pr merge 3", "env -u FOO git push", "env --unset FOO git push", "env --unset=FOO git push","env -u FOO -u BAR git push", "sudo -u x git push", "sudo -u x gh pr merge 3","gh api -X PUT repos/o/r/pulls/3/merge", "gh api --method PUT repos/o/r/pulls/3/merge", "gh api -XPUT repos/o/r/pulls/3/merge", "gh api --method=PUT repos/o/r/pulls/3/merge", "gh api repos/o/r/pulls/3/merge -X put -f merge_method=squash", "gh api -H 'Accept: x' --method PUT /repos/o/r/pulls/12/merge", "gh -R o/r api -X PUT repos/o/r/pulls/3/merge", "gh api -X PUT https://api.github.com/repos/o/r/pulls/3/merge", "timeout 5 gh api -X PUT repos/o/r/pulls/3/merge", "gh api -X=PUT repos/o/r/pulls/3/merge", "gh api -iXPUT repos/o/r/pulls/3/merge", "gh api -iX PUT repos/o/r/pulls/3/merge", "gh api -X PUT /repos/o/r/pulls/3/merge#", "gh api -X PUT repos/o/r/pulls/3/merge/", "gh api -X PUT repos/o/r/pulls/3/update-branch", "gh api repos/o/r/pulls/3/update-branch -f expected_head_sha=x", "gh api graphql -f query='mutation{updatePullRequestBranch(input:{pullRequestId:\"x\"}){pullRequest{id}}}'", "gh api repos/o/r/git/refs -if ref=refs/heads/x -if sha=y", "gh api repos/o/r/git/refs -iF sha=y", "gh api -X PUT repos/o/r/pulls/3/merge -p graphql", "gh api -X PUT -iq graphql repos/o/r/pulls/3/merge", "gh api -X PUT -ip graphql repos/o/r/pulls/3/merge", "gh api /graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", "gh api https://api.github.com/graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'","gh api -X PUT repos/o/r/pulls/3/merge --jq graphql", "gh api --method PUT -H graphql repos/o/r/pulls/3/merge","gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", "gh api graphql -f query='mutation{createRef(input:{repositoryId:\"x\",name:\"refs/heads/y\",oid:\"z\"}){ref{id}}}'", "gh api graphql -f query='mutation{updateRef(input:{}){ref{id}}}'", "gh api graphql -f query='mutation{createCommitOnBranch(input:{}){commit{oid}}}'", "gh api graphql -f query='mutation{mergeBranch(input:{}){mergeCommit{oid}}}'", "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}'", "gh api -X POST repos/o/r/git/commits -f message=x", "gh api -X POST repos/o/r/git/trees --input t.json", "gh api -X POST repos/o/r/git/blobs -f content=x", "gh api -X POST repos/o/r/git/refs -f ref=refs/heads/x -f sha=y", "gh api -X PUT repos/o/r/contents/dir/f.txt -f message=x", "gh api -X POST repos/o/r/branches/main/merge-upstream -f branch=main", "gh api repos/o/r/merges -f base=main -f head=x", "gh api repos/o/r/merges -F base=main", "gh api repos/o/r/merges --field base=main", "gh api repos/o/r/merges --raw-field=base=main", "gh api repos/o/r/merges --input body.json", "gh api -fbase=main repos/o/r/merges", "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x", "gh api -X PUT repos/o/r/contents/f", "gh api -X DELETE repos/o/r/git/refs/heads/x","nice git push", "nice -n 10 git push", "nice -10 git push", "stdbuf -oL git push", "stdbuf -o L -e0 git push", "nohup timeout 60 nice -n 5 git push", "timeout 60 sudo git push"];

test("nobody pushes or merges a PR: a specialist's and a Reviewer's git push and gh pr merge are refused, every form", async () => {
  const bash = await gateOffice();
  for (const id of ["d", "v"]) {
    for (const command of PUSHES) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain(PUSH_REFUSAL);
    }
    for (const command of ["git log --oneline", "git status", "echo git push", "git log --grep 'git push'", "gh pr view 3", "gh pr list", "gh pr checkout 3", "gh api repos/o/r/pulls/3/merge", "gh api -X GET repos/o/r/pulls/3/merge", "gh api --method GET repos/o/r/pulls/3/merge", "gh api --method=get repos/o/r/pulls/3", "gh api -XGET repos/o/r/pulls/3", "gh api -i repos/o/r/pulls/3", "gh api -H 'Accept: application/vnd.github+json' repos/o/r/pulls/3", "gh api repos/o/r/pulls --jq '.[].number'", "gh api --method POST repos/o/r/issues/3/dependencies/blocked_by -F issue_id=9", "gh api --method POST repos/o/r/issues/3/sub_issues -F sub_issue_id=9", "gh api --method POST repos/o/r/issues/3/comments -f body=x", "gh api -X POST repos/o/r/issues/3/labels -f 'labels[]=bug'", "gh api -X PATCH repos/o/r/issues/3 -f state=closed", "gh api --method POST repos/o/r/issues -f title=x", "gh api -X PUT repos/o/r/issues/3/lock", "gh api -X", "gh api -X GET repos/o/r/git/refs/heads/main", "gh api repos/o/r/contents/f", "gh api repos/o/r/merges", "gh api graphql -F query=@q.graphql", "gh api graphql --input q.json", "gh api graphql -f query='mutation{addSubIssue(input:{issueId:\"a\",subIssueId:\"b\"}){clientMutationId}}'", "gh api graphql -f query='{viewer{login}}'", "gh api graphql -F owner=o -f query='query($owner:String!){repository(owner:$owner,name:\"r\"){id}}'", "gh api repos/o/r/pulls/3", "gh api repos/o/r/pulls/3/merge -qfiles", "gh api -HIf-None-Match:x repos/o/r/contents/f", "gh api -HIf-None-Match:x repos/o/r/git/refs/heads/main", "gh api -iq .sha repos/o/r/contents/f", "timeout 60 git log --oneline", "nice -n 10 git status", "stdbuf -oL git diff", "echo timeout 60 git push", "gh -R o/r pr view 3", "git diff -m 'git push later'", "if git diff --quiet; then echo ok; fi"]) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
  for (const command of PUSHES) expect([command, await bash("f", command)]).toEqual([command, null]);
  expect(await bash("d", "git commit -m 'git push later'")).toBeNull();
});

test("a Reviewer's git is read-only plus its own scratch worktrees: every writing command is refused, reading and adding or removing a scratch worktree are not", async () => {
  const bash = await gateOffice();
  const refused = ["git reset --hard HEAD~1", "git -C x rebase main", "git cherry-pick abc", "git revert abc", "git am fix.patch", "git pull origin main", "git clean -fd", "git branch -D worktree-a", "git branch -Df worktree-a", "git merge --force x", "git checkout -f main", "git worktree remove --force .claude/worktrees/review-a", "git worktree remove -f ../x", "git worktree remove --force .claude/worktrees/red-a ../x", "git worktree remove --force .claude/worktrees/red-a/../../..", "git worktree add -f x", "git fetch origin -f", "cd x && git reset --hard", "then git reset --hard", "git branch -fD x", "git branch -M x", "git checkout -B x", "git switch -C x", "git update-ref -d refs/heads/x", "git stash drop", "git stash clear", "git stash", "git stash list", "git stash push -m x", "git stash pop", "git stash apply", "git -C x stash", "git commit --amend", "git commit --amend --no-edit", "git commit -m x --amend", "git commit --am", "git commit -mtest --amend", "git commit -mfmt --amend", "git commit -mwip --amend", "timeout 5 git commit --amend", "git restore .", "git checkout -- .", "git checkout -- src/a.ts", "git checkout -q -- a.ts b.ts", "git checkout .", "git restore a.ts", "git restore ./a.ts", "git restore --worktree a.ts", "git restore --source=HEAD a.ts", "git restore --staged --worktree a.ts", "git restore -s HEAD~1 a.ts", "git -C x restore a.ts", "git checkout --ours a.ts", "git checkout --theirs a.ts", "git checkout --theirs -- a.ts", "git -C /other/repo worktree remove --force .claude/worktrees/red-a", "git --git-dir=/x/.git worktree remove --force .claude/worktrees/red-a", "git worktree remove --force /code/shop/.claude/worktrees/red-a", "git worktree remove --force ./.claude/worktrees/red-a", "git clean -fdX", "git tag -f v1", "git merge --no-ff worktree-a -m 'Merge a'", "git merge --ff-only main", "git merge --abort", "git commit -m 'conflict fix'", "git commit -m 'amend the docs'", "git commit -fm x", "git add .", "git rm a.ts", "git mv a b", "git apply fix.patch", "git tag v1", "git worktree move a b", "git worktree lock x", "git worktree unlock x", "git worktree repair", "git worktree add -B x .claude/worktrees/review-a", "git worktree", "git branch -d worktree-a", "git branch -m x", "git branch x", "git checkout main", "git checkout -b x", "git checkout worktree-a -- tests/a.test.ts", "git checkout HEAD -- a.ts", "git switch main", "git restore --staged a.ts", "git fetch origin", "git config user.name x", "git remote add o x", "git worktree add --force x", "if true; then git merge --no-ff a; fi"];  for (const command of refused) {
    const out = await bash("v", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Reviewer");
  }
  const allowed = ["git worktree remove --force .claude/worktrees/red-a", "git worktree remove -f .claude/worktrees/red-add-login/", "git worktree add .claude/worktrees/red-a -b red-a main", "git worktree add .claude/worktrees/review-a worktree-a", "git worktree remove .claude/worktrees/review-a", "git worktree list", "git worktree prune", "git -C x worktree list",
    "git status", "git log --oneline", "git log --format=%h", "git log --grep 'git reset'", "git log -Sfoo", "git log -Gfix", "git log --author -fred", "git diff main...worktree-a", "git diff -Uf", "git show HEAD", "git rev-parse HEAD", "git merge-base main worktree-a", "git ls-files", "git cat-file -p HEAD", "git blame a.ts", "git grep amend", "git branch --list", "git branch -a", "git branch -vv", "git branch --show-current", "git branch --contains abc1234", "git log --grep amend"];
  for (const command of allowed) expect([command, await bash("v", command)]).toEqual([command, null]);
  // Only the Reviewer's: a specialist rebases its own branch.
  for (const command of ["git commit --amend", "git stash", "git checkout -- a.ts", "git rebase main", "git reset --hard", "git pull", "git clean -fd", "git branch -D x", "git checkout -f main"]) expect([command, await bash("d", command)]).toEqual([command, null]);
});

// The gate reads a heredoc body as data, as the shell does: a brief or a note written with `cat <<EOF` may mention any command, and the command after the terminator is still read.
test("a heredoc body is data, not commands: its lines pass the push, landing and hire rules, in every form of the heredoc", async () => {
  const bash = await gateOffice();
  const body = "run git push when done\ngit push origin main\ngit commit -m x\nf1rm hire designer checkout.designer-a a b\ngit merge worktree-a\nf1rm pause back at two\nf1rm resume\nf1rm merge worktree-a";
  const data = [
    `cat > brief.md <<EOF\n${body}\nEOF`,
    `cat > brief.md <<EOF\n${body}\nEOF\n`,
    `cat <<'EOF'\n${body}\nEOF`,
    `cat <<"EOF"\n${body}\nEOF`,
    `cat <<\\EOF\n${body}\nEOF`,
    `cat <<-EOF\n\t${body.replaceAll("\n", "\n\t")}\n\tEOF`,
    `cat <<-'EOF' > brief.md\n\t${body.replaceAll("\n", "\n\t")}\n\tEOF`,
    `cat<<EOF\n${body}\nEOF`,
    `cat << EOF\n${body}\nEOF`,
    `cat <<EOF >> notes.md\n${body}\nEOF\necho done`,
    `cat <<A <<B\ngit push\nA\ngit commit -m x\nB`,
    `cat <<EOF\ngit push\nEOF2\n EOF\ngit commit -m x\nEOF`,
    `cat <<EOF2\nx\nEOF\ngit push\nEOF2\n`,
    `cat <<EOF\n${body}`,
    `cat <<EOF\n$(echo plain) and \${HOME} text\nEOF`,
    `cat <<'EOF'\n$( ( (git push) ) )\nEOF`,
    "x=$(cat <<'EOF'\nfix: git push is the user's\ngit commit -m y\nEOF\n)",
    "echo \"$(cat <<'EOF'\nfix git push\nEOF\n)\"",
    `cat <<< "git push"`,
    `cat <<< 'git push; git commit -m x'`,
    `cat <<< "git push\ngit commit -m x"`,
    `cat <<EOF # note\n${body}\nEOF`,
  ];
  for (const id of ["p", "l", "d", "v"]) {
    for (const command of data) expect([id, command, (await bash(id, command))?.permissionDecision ?? null]).toEqual([id, command, null]);
  }
});

test("a command after a heredoc's terminator, on its opening line, or in an unquoted command substitution is still read; so is a line after a here-string", async () => {
  const bash = await gateOffice();
  const read = [
    "cat <<EOF\nnote\nEOF\ngit push",
    "cat <<'EOF'\nnote\nEOF\ngit push origin main",
    "cat <<-EOF\n\tnote\n\tEOF\ngit push",
    "cat <<EOF | git push\nnote\nEOF",
    "cat <<EOF && git push\nnote\nEOF",
    "cat <<A <<B\nx\nA\ny\nB\ngit push",
    "cat <<EOF\n$(git push)\nEOF",
    "cat <<EOF\nstamp `git push`\nEOF",
    "cat <<< x\ngit push",
    "cat <<<EOF\ngit push\nEOF",
    "cat <<< \"x\"; git push",
    "cat <<<EOF\nx\ngit push",
    'echo "a <<EOF"\ngit push\nEOF',
    "echo 'a <<EOF'\ngit push\nEOF",
    "echo hi # <<EOF\ngit push\nEOF",
    "echo $((1 << 2))\ngit push\n2",
    // The scan fails closed: what is no heredoc to the shell, or a body the shell runs, stays readable.
    "true;# <<EOF\ngit push origin main\nEOF",
    "true&&# <<EOF\ngit push origin main\nEOF",
    "true | # <<EOF\ngit push origin main\nEOF",
    "(# <<EOF\ngit push origin main\nEOF",
    "echo ${x:-<<EOF}\ngit push origin main\nEOF}",
    "cat <<EOF\n$( ( (git push) ) )\nEOF",
    'cat <<EOF\n$(echo ")"; git push)\nEOF',
    "cat <<EOF\n`echo x; git push`\nEOF",
    "bash <<EOF\ngit push\nEOF",
    "sh <<'EOF'\ngit push\nEOF",
    "zsh -s <<EOF\ngit push\nEOF",
    "sudo bash <<'EOF'\ngit push\nEOF",
    "env FOO=1 dash <<EOF\ngit push\nEOF",
    "cat x | ksh <<-EOF\n\tgit push\n\tEOF",
    // A shell on the opener's line anywhere (the heredoc is its stdin), and a `${` that may hold the opener.
    "cat <<EOF | bash\ngit push origin main\nEOF",
    "cat <<'EOF' | sh -s\ngit push origin main\nEOF",
    "<<EOF bash\ngit push\nEOF",
    "bash -s < /dev/null <<EOF\ngit push\nEOF",
    "cat <<EOF | . /dev/stdin\ngit push\nEOF",
    "echo ${a:-${b}<<EOF}\ngit push\nEOF}",
    "echo ${a:-<<EOF} ${b}\ngit push\nEOF}",
  ];
  const passed: string[] = [];
  for (const command of read) {
    const out = await bash("d", command);
    if (out?.permissionDecision !== "deny") passed.push(command);
    else expect(out.permissionDecisionReason).toContain(PUSH_REFUSAL);
  }
  expect(passed).toEqual([]);
  // The same lines are read by the PM and lead rules too.
  expect((await bash("l", "cat <<EOF\nnote\nEOF\ngit commit -m x"))?.permissionDecision).toBe("deny");
  expect((await bash("p", "cat <<EOF\nnote\nEOF\nf1rm hire designer checkout.designer-a a b"))?.permissionDecision).toBe("deny");
});

const WORKTREE = "/code/shop/.claude/worktrees/add-a";
// A PM, a lead and a Reviewer in the main checkout, a dev in its own worktree and another in the main checkout, a designer and a researcher in the main checkout, a freelancer, in a registered repo.
async function mainOffice() {
  start({ "/code/shop": "/code/shop/.git" });
  const sessions = [
    ["p", "f1rm:pm", "p-title", "/code/shop"], ["l", "f1rm:lead", "lead-checkout", "/code/shop"], ["v", "f1rm:reviewer", "v-title", "/code/shop"],
    ["b", "f1rm:backend-dev", "checkout.backend-dev-add-a", WORKTREE], ["bm", "f1rm:backend-dev", "checkout.backend-dev-add-b", "/code/shop"],
    ["d", "f1rm:designer", "d-title", "/code/shop"], ["r", "f1rm:researcher", "r-title", "/code/shop"], ["f", undefined, "f-title", "/code/shop"],
    ["c", "f1rm:step", "close-7", "/code/shop"], ["i", "f1rm:step", "implement-7", "/code/shop"],
  ] as const;
  const cwds = Object.fromEntries(sessions.map(([id, , , cwd]) => [id, cwd]));
  for (const [id, type, session_title, cwd] of sessions) await hook({ ...common(id, "UserPromptSubmit"), cwd, prompt: "go", session_title, ...(type && { agent_type: type }) });
  await office((s) => Object.keys(s.employees).length === sessions.length && sessions.every(([id]) => s.employees[id].room === "/code/shop/.git"));
  return async (id: string, command: string, extra: object = {}) => held(await hook({ ...preToolUse(id, "Bash", { command }), cwd: cwds[id], ...extra }));
}

test("only the PM, a lead and the user's own session run `f1rm merge`: a dev, a designer, a researcher, a Reviewer and an intern are refused", async () => {
  const bash = await mainOffice();
  const forms = ["f1rm merge add-a", "f1rm merge add-a --check 'bun run check'", "cd /code/shop && f1rm merge add-a", "bun office/cli/f1rm.ts merge add-a", "npx f1rm merge add-a", "timeout 900 f1rm merge add-a"];
  for (const id of ["p", "l", "f"]) for (const command of forms) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  for (const id of ["b", "bm", "d", "r", "v"]) {
    for (const command of forms) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the PM and the office's steps run `f1rm merge`");
    }
  }
  for (const id of ["p", "l"]) expect([id, (await bash(id, "f1rm merge add-a", { agent_id: "intern-1" }))?.permissionDecision]).toEqual([id, "deny"]); // an intern is not its parent
  for (const id of ["b", "d", "v"]) for (const command of ["git log --grep 'f1rm merge'", "echo 'f1rm merge add-a'", "f1rm status", "f1rm report DONE add-a --commit abc1234"]) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
});

test("only the PM runs `f1rm push`: a lead, a dev, a designer, a researcher, a Reviewer and any intern are refused, the PM's raw `git push`, a forced one, one of another branch and `gh pr merge` stay refused, and none of those messages sends anyone to the user", async () => {
  const bash = await mainOffice();
  const forms = ["f1rm push", "f1rm push --check 'bun run check'", "cd /code/shop && f1rm push", "bun office/cli/f1rm.ts push", "npx f1rm push", "timeout 900 f1rm push"];
  // An office close step pushes its landed spec too; the other steps do not.
  for (const id of ["p", "f", "c"]) for (const command of forms) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  for (const id of ["l", "i", "b", "bm", "d", "r", "v"]) {
    for (const command of forms) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the PM and a close step push, with `f1rm push`");
    }
  }
  for (const id of ["p", "l", "c"]) expect([id, (await bash(id, "f1rm push", { agent_id: "intern-1" }))?.permissionDecision]).toEqual([id, "deny"]); // an intern is not its parent
  for (const id of ["l", "b", "d", "v"]) for (const command of ["git log --grep 'f1rm push'", "echo 'f1rm push'", "f1rm status", "f1rm report DONE add-a --note ready"]) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  const raw = ["git push", "git push --force", "git push -f origin main", "git push origin other-branch", "git push origin main:other", "git push --force-with-lease", "git push --tags", "git push origin +main", "timeout 60 git push", "env git push", "gh pr merge 3", "gh api -X PUT repos/o/r/pulls/3/merge"];
  for (const id of ["p", "l"]) {
    for (const command of raw) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
  }
  for (const id of ["b", "d", "r", "v"]) {
    for (const command of raw) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain(PUSH_REFUSAL);
    }
  }
  for (const reason of [LANDING_REFUSAL, PUSH_REFUSAL]) expect(reason).not.toMatch(/ask the user|with `!`/i);
});

test("a `--check` command of `f1rm push` and `f1rm merge` runs the project's suite: it may not push, merge or run `f1rm push`", async () => {
  const bash = await mainOffice();
  const refused = ["git push -f origin other", "bun test && git push origin main", "gh pr merge 1", "gh api -X PUT repos/o/r/pulls/3/merge", "git -C x push", "f1rm push", "bun run check; f1rm push --check true"];
  for (const verb of ["f1rm push", "f1rm merge add-a"]) {
    for (const check of refused) {
      for (const command of [`${verb} --check '${check}'`, `${verb} --check "${check}"`]) {
        const out = await bash("p", command);
        expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
        expect(out.permissionDecisionReason).toContain("A --check command runs the project's suite; it may not push or merge. The PM pushes with plain `f1rm push` at the end of a milestone.");
      }
    }
    for (const check of ["scripts/test.sh fast", "bun run check", "git status && bun test", "git log --grep=push"]) expect([verb, check, await bash("p", `${verb} --check '${check}'`)]).toEqual([verb, check, null]);
  }
});

const LANDS = [
  "git merge worktree-add-a", "git merge --no-ff worktree-add-a -m x", "git merge --ff-only abc1234", "git cherry-pick abc1234", "git rebase main", "git reset --hard HEAD~1", "git reset --soft main", "git commit -m x", "git commit --amend --no-edit", "git am fix.patch",
  "git pull", "git pull origin main", "git revert abc1234", "git checkout worktree-add-a -- src/a.ts", "git checkout abc1234 -- .", "git checkout -q main -- a.ts b.ts", "git checkout -B main abc1234", "git switch -C main abc1234", "git restore --source=worktree-add-a src/a.ts",
  "git restore -s abc1234 .", "timeout 60 git merge x", "env GIT_EDITOR=true git merge x", "git -c core.editor=true merge x", "if true; then git commit -m x; fi", "echo hi && git merge x",
];
// Ref moves land on main from any folder.
const MOVES = ["git update-ref refs/heads/main abc1234", "git update-ref -m x refs/heads/main abc1234 def5678", "git update-ref main abc1234", "git branch -f main abc1234", "git branch --force main abc1234", "git branch -fq main abc1234", "git branch -M other main", "git fetch . worktree-add-a:main", "git fetch . +worktree-add-a:refs/heads/main", "git fetch --update-head-ok . x:main", "git -C /code/shop fetch . x:main"];

test("nothing lands on the base branch in the main checkout except through `f1rm merge`: every git shape that lands there is refused for a dev, a designer, a researcher and a Reviewer, in the main checkout or with -C, cd or --work-tree pointing at it", async () => {
  const bash = await mainOffice();
  for (const id of ["bm", "d", "r", "v"]) {
    for (const command of [...LANDS, ...MOVES]) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Nothing lands on the base branch");
    }
  }
  // From a dev's own worktree, the same shapes aimed at the main checkout.
  const aimed = ["git -C /code/shop merge x", "git -C /code/shop commit -m x", "git -C ../../.. merge x", "git -C ../.. -C .. rebase main", "cd /code/shop && git merge x", "cd ../../.. && git reset --hard origin/main", "git --work-tree=/code/shop commit -m x", "git --work-tree /code/shop merge x", "git -C /code/shop checkout worktree-add-a -- src/a.ts", "pushd /code/shop; git pull", "git -C /code/shop/src merge x", "cd /code/shop/src && git merge x"];
  for (const command of [...aimed, ...MOVES]) {
    const out = await bash("b", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Nothing lands on the base branch");
  }
  // A heredoc body that mentions them lands nothing.
  expect(await bash("bm", "cat > brief.md <<'EOF'\ngit merge x\ngit commit -m y\nEOF")).toBeNull();
});

test("the main checkout is also reached by --git-dir and GIT_DIR, a local fetch into the base, and checkout <ref> <path> without --; moving a ref other than the base is not landing", async () => {
  const bash = await mainOffice();
  const refused = [
    "git --git-dir=/code/shop/.git merge x", "git --git-dir /code/shop/.git/ commit -m x", "GIT_DIR=/code/shop/.git git merge x", "GIT_DIR=/code/shop/.git GIT_WORK_TREE=/code/shop git commit -m x", "env GIT_DIR=/code/shop/.git git rebase main", "GIT_WORK_TREE=/code/shop git merge x",
    "git fetch ./ x:main", "git fetch . +x:main", "git fetch /code/shop x:main", "git fetch ../../.. x:refs/heads/main", "git fetch ../../../ x:main", "git fetch .. x:main",
    "git update-ref -m 'moved' refs/heads/main abc1234", "git branch -M other main", "git branch -f main other", "git branch -m -f feature main", "git branch -fm feature main",
    // --git-dir is main's whatever the work tree is, and it resolves against the folder -C moved to.
    "git --git-dir=/code/shop/.git --work-tree=. merge x", "GIT_DIR=/code/shop/.git GIT_WORK_TREE=. git commit -m x", "git -C .. --git-dir=../../.git commit -m x",
  ];
  for (const command of refused) {
    const out = await bash("b", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Nothing lands on the base branch");
  }
  for (const command of ["git checkout worktree-add-a src/a.ts", "git checkout abc1234 a.ts b.ts", "git checkout -q worktree-add-a ."]) {
    const out = await bash("bm", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
  }
  for (const command of ["git update-ref refs/heads/worktree-add-a main", "git update-ref -m 'main moved' refs/heads/other abc1234", "git branch -f other main", "git branch -f worktree-add-a main", "git branch -M worktree-add-a other", "git branch -m -f feature other", "git branch -c main backup", "git --git-dir=/code/shop/.git/worktrees/add-a log", "GIT_DIR=/code/shop/.git/worktrees/add-a git status", "git fetch origin x:main", "git fetch origin", "git fetch . main:other", "git fetch ./ main:other"]) {
    expect([command, await bash("b", command)]).toEqual([command, null]);
  }
  for (const command of ["git checkout -b feature main", "git checkout main", "git checkout -q worktree-add-a", "git checkout -- a.ts", "git checkout main -- a.ts"]) {
    // in the main checkout: a new branch and a switch are not landing; the last shape (a ref before `--`) is
    expect([command, (await bash("bm", command))?.permissionDecision ?? null]).toEqual([command, command === "git checkout main -- a.ts" ? "deny" : null]);
  }
});

test("a dev keeps its normal git inside its own worktree: merge main into its branch, rebase, amend, reset, cherry-pick, pull, commit and move its own refs; and it can read the main checkout", async () => {
  const bash = await mainOffice();
  const own = ["git merge main", "git merge --no-ff main", "git rebase main", "git rebase --continue", "git reset --hard HEAD~1", "git reset --soft main", "git commit -m x", "git commit --amend", "git cherry-pick abc1234", "git pull", "git pull --rebase origin main", "git revert abc1234", "git am fix.patch", "git checkout main -- src/a.ts", "git checkout abc1234 -- .", "git checkout -B scratch abc1234", "git switch -C scratch", "git restore --source=main src/a.ts",
    "git update-ref refs/heads/worktree-add-a abc1234", "git branch -f other abc1234", "git branch -M worktree-add-a", "git fetch origin", "git fetch origin main:other", "git fetch . main:other", "git merge main && git commit -m x", "cd /code/shop/.claude/worktrees/add-a && git merge main", "git -C . merge main", "git -C /code/shop/.claude/worktrees/add-a rebase main",
    "git -C /code/shop log --oneline", "git -C /code/shop status", "git -C /code/shop diff main...worktree-add-a", "cd /code/shop && git log -1", "cd /code/shop && git worktree list", "git -C /code/shop show HEAD", "git -C /code/shop rev-parse HEAD"];
  for (const command of own) expect([command, await bash("b", command)]).toEqual([command, null]);
  // In the main checkout, reading is free for everyone.
  for (const command of ["git status", "git log --oneline", "git diff", "git worktree list", "git show HEAD", "git branch --list", "git checkout main", "git checkout -b scratch", "git checkout -- a.ts", "git fetch origin", "git stash list", "git branch -d worktree-add-a", "git worktree add .claude/worktrees/x -b worktree-x"]) {
    for (const id of ["bm", "d", "r"]) expect([id, command, await bash(id, command)]).toEqual([id, command, null]);
  }
});

test("the user's own session lands anything; the Reviewer has no exception left (its old --no-ff and --ff-only steps are refused as landing); the PM and a lead stay refused every landing", async () => {
  const bash = await mainOffice();
  for (const command of [...LANDS, ...MOVES]) expect([command, await bash("f", command)]).toEqual([command, null]);
  for (const command of ["git merge --no-ff worktree-add-a -m x", "git merge --ff-only abc1234", "git merge --abort", "git commit -m 'conflict fix'", "git checkout worktree-add-a -- tests/a.test.ts", "git reset --hard HEAD~1", "git rebase main", "git cherry-pick abc1234", "git commit --amend"]) {
    const out = await bash("v", command);
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Nothing lands on the base branch");
  }
  // What a Reviewer may run in the main checkout is reading and its own scratch worktrees.
  for (const command of ["git status", "git log --oneline", "git diff main...worktree-add-a", "git worktree add .claude/worktrees/review-add-a worktree-add-a", "git worktree remove .claude/worktrees/review-add-a"]) expect([command, await bash("v", command)]).toEqual([command, null]);
  for (const id of ["p", "l"]) {
    for (const command of ["git merge worktree-add-a", "git commit -m x", "git rebase main", "git cherry-pick abc1234"]) {
      const out = await bash(id, command);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
  }
  // Everyone's `git push` stays refused, `push .` included.
  for (const id of ["b", "bm", "d", "v", "p", "l"]) expect([id, (await bash(id, "git push . HEAD:main"))?.permissionDecision]).toEqual([id, "deny"]);
});

test("the base branch is the one the main checkout has checked out: a repo on develop refuses moving develop, not main", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-base-")));
  Bun.spawnSync(["/usr/bin/git", "init", "-q", "-b", "develop", repo]);
  start({ [repo]: join(repo, ".git") }, undefined, undefined, { junkRoots: [] });
  await hook({ ...common("b", "UserPromptSubmit"), cwd: `${repo}/.claude/worktrees/add-a`, prompt: "go", session_title: "checkout.backend-dev-add-a", agent_type: "f1rm:backend-dev" });
  await office((s) => s.employees.b?.room === join(repo, ".git"));
  const bash = async (command: string) => (await held(await hook({ ...preToolUse("b", "Bash", { command }), cwd: `${repo}/.claude/worktrees/add-a` })))?.permissionDecision ?? null;
  for (const command of ["git branch -f develop abc1234", "git update-ref refs/heads/develop abc1234", "git fetch . x:develop", `git -C ${repo} merge x`]) expect([command, await bash(command)]).toEqual([command, "deny"]);
  for (const command of ["git branch -f main abc1234", "git update-ref refs/heads/main abc1234", "git fetch . x:main"]) expect([command, await bash(command)]).toEqual([command, null]);
  rmSync(repo, { recursive: true, force: true });
});

// The PM, a lead, a dev and a designer in a real repo (the gate reads real paths) with two worktrees; a folder beside it; and links out of a worktree.
// The worktree add-a is behind main by one commit and add-b holds a commit main does not.
async function ownerOffice() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-owner-")));
  const beside = `${repo}-beside`;
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["/usr/bin/git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
    if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("worktree", "add", "-q", ".claude/worktrees/add-a", "-b", "worktree-add-a");
  git("worktree", "add", "-q", ".claude/worktrees/add-b", "-b", "worktree-add-b");
  const [a, b] = [`${repo}/.claude/worktrees/add-a`, `${repo}/.claude/worktrees/add-b`];
  git("-C", b, "commit", "-q", "--allow-empty", "-m", "b only");
  git("commit", "-q", "--allow-empty", "-m", "main moves on");
  mkdirSync(join(repo, "src"));
  mkdirSync(beside);
  mkdirSync(join(a, "src"));
  symlinkSync(join(repo, "src"), join(a, "out"));
  symlinkSync(join(repo, "later.ts"), join(a, "dangling.ts"));
  symlinkSync(repo, join(beside, "to-main"));
  // Folders under worktrees/ that are no linked worktree of this repo: a plain one, one whose .git file points at main's git dir, and a worktree with main checked out.
  mkdirSync(`${repo}/.claude/worktrees/plain`);
  mkdirSync(`${repo}/.claude/worktrees/hijack`);
  writeFileSync(`${repo}/.claude/worktrees/hijack/.git`, `gitdir: ${repo}/.git\n`);
  git("worktree", "add", "-q", "--force", ".claude/worktrees/on-main", "main");
  // A folder whose .git file points at ANOTHER worktree's git dir (a rewritten pointer).
  mkdirSync(`${repo}/.claude/worktrees/swap`);
  writeFileSync(`${repo}/.claude/worktrees/swap/.git`, `gitdir: ${repo}/.git/worktrees/add-b\n`);
  afterEachRestore = () => (rmSync(repo, { recursive: true, force: true }), rmSync(beside, { recursive: true, force: true }));
  start({ [repo]: join(repo, ".git") }, undefined, undefined, { junkRoots: [] });
  for (const [id, type, session_title] of [["p", "f1rm:pm", "p-title"], ["l", "f1rm:lead", "lead-checkout"], ["b", "f1rm:backend-dev", "checkout.backend-dev-add-a"], ["d", "f1rm:designer", "d-title"]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), cwd: repo, prompt: "go", session_title, agent_type: type });
  }
  await office((s) => Object.keys(s.employees).length === 4 && Object.values(s.employees).every((e) => e.room === join(repo, ".git")));
  // The sub-agent's calls carry its parent's session id, an agent_id and the folder it works in.
  const call = async (id: string, tool: string, input: object, cwd: string, sub = true) =>
    held(await hook({ ...preToolUse(id, tool, input), cwd, ...(sub && { agent_id: "impl-1", agent_type: "general-purpose" }) }));
  const bash = async (id: string, command: string, cwd: string, sub = true) => call(id, "Bash", { command }, cwd, sub);
  return { repo, beside, a, b, main: git("rev-parse", "main"), behind: git("rev-parse", "worktree-add-a"), diverged: git("rev-parse", "worktree-add-b"), call, bash };
}
const WRITE_REFUSAL = "The PM writes only its scratch files and its repo's tracker setup (CLAUDE.md, AGENTS.md, docs/agents/), and the office's steps only scratch files: code is built by the implement step's interns, in their worktrees.";

test("a PM's or lead's sub-agent writes inside its own worktree; the same writes from the parent, in the main checkout, another worktree, a folder beside it, through a link or `..` are refused", async () => {
  const { repo, beside, a, b, call } = await ownerOffice();
  const write = (id: string, tool: string, file: string, cwd: string, sub = true) => call(id, tool, tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file }, cwd, sub);
  for (const id of ["p", "l"]) {
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      const allowed: [string, string][] = [[`${a}/src/x.ts`, a], [`${a}/new/deeper/x.ts`, a], ["src/x.ts", a], [`${a}/x.ts`, `${a}/src`], ["../x.ts", `${a}/src`], [`${a}/src/../x.ts`, a], ["x.ts", `${a}/not/made/yet`]];
      for (const [file, cwd] of allowed) expect([id, tool, file, cwd, await write(id, tool, file, cwd)]).toEqual([id, tool, file, cwd, null]);
      const refused: [string, string][] = [
        [`${repo}/src/x.ts`, a], [`${repo}/src/x.ts`, repo], ["src/x.ts", repo], [`${repo}/x.ts`, `${repo}/.claude`], // the main checkout, as the file and as the folder
        [`${b}/x.ts`, a], [`${a}/x.ts`, b], [`${a}/../add-b/x.ts`, a], ["../add-b/x.ts", a], // another worktree
        [`${beside}/x.ts`, a], [`${beside}/x.ts`, beside], [`${a}/x.ts`, beside], [`${repo}-beside-not/x.ts`, a], // a folder beside the repo
        [`${a}/out/x.ts`, a], [`${a}/dangling.ts`, a], [`${beside}/to-main/x.ts`, a], ["x.ts", `${beside}/to-main`], ["x.ts", `${a}/out`], // links into the main checkout
        [`${a}/../../../src/x.ts`, a], ["../../../src/x.ts", a], [`${a}/../x.ts`, a], [`${a}/x.ts`, `${repo}/.claude/worktrees`], // `..` out of the worktree; no worktree at all
        [`${repo}/.claude/worktrees-evil/x.ts`, a], [`${a}-evil/x.ts`, a],
      ];
      for (const [file, cwd] of refused) {
        const out = await write(id, tool, file, cwd);
        expect([id, tool, file, cwd, out?.permissionDecision]).toEqual([id, tool, file, cwd, "deny"]);
        expect(out.permissionDecisionReason).toBe(WRITE_REFUSAL);
      }
      // The parent session itself is no sub-agent.
      for (const [file, cwd] of [[`${a}/src/x.ts`, a], ["src/x.ts", a], [`${a}/x.ts`, repo]]) {
        const out = await write(id, tool, file, cwd, false);
        expect([id, tool, file, cwd, out?.permissionDecision]).toEqual([id, tool, file, cwd, "deny"]);
      }
    }
  }
  // A sub-agent keeps what its parent may write anywhere.
  expect(await write("l", "Write", join(process.env.HOME!, ".f1rm", "evidence", "x", "n.md"), a)).toBeNull();
});

test("a PM's or lead's sub-agent commits in its own worktree; in the main checkout, another worktree, a folder beside it, or with the repo moved by an option, its parent's commit and the same line stay refused", async () => {
  const { repo, beside, a, b, bash } = await ownerOffice();
  for (const id of ["p", "l"]) {
    for (const [command, cwd] of [
      ["git add -A && git commit -m 'task: x; y'", a], ["git commit -m x", `${a}/src`], [`git -C ${a} commit -m x`, a], [`cd ${a}/src && git commit -m x`, a], ["cd src && git commit -m x", a], ["git -C . commit -m x", a], ["git -C src commit -m x", a],
      ["git add -A", a], ["git status", a], ["git diff HEAD", a], ["git log --oneline", a], ["git branch -m worktree-new", a], ["git commit --amend --no-edit", a], ["time git commit -m x", a], ["bun test && git add -A && git commit -m 'a > b'", a], ["git status && git diff --stat && git commit -am x", a],
    ] as const) expect([id, command, cwd, await bash(id, command, cwd)]).toEqual([id, command, cwd, null]);
    for (const [command, cwd] of [
      ["git commit -m x", repo], ["git commit -m x", beside], ["git commit -m x", `${repo}/.claude`], ["git commit -m x", `${repo}/.claude/worktrees`], ["git commit -m x", `${a}/out`], ["git commit -m x", `${beside}/to-main`],
      [`git -C ${a} commit -m x`, repo], [`git -C ${a} commit -m x`, beside], [`cd ${a} && git commit -m x`, repo], [`git -C ${repo} commit -m x`, a], [`git -C ${b} commit -m x`, a], [`git -C ${beside} commit -m x`, a], ["git -C .. commit -m x", a], ["git -C ../add-b commit -m x", a], ["git -C ../../.. commit -m x", a],
      [`cd ${repo} && git commit -m x`, a], [`cd ${b} && git commit -m x`, a], ["cd ../../.. && git commit -m x", a], ["cd ~ && git commit -m x", a], ["cd - && git commit -m x", a], ["cd $HOME && git commit -m x", a],
      [`git --git-dir=${repo}/.git commit -m x`, a], [`git --git-dir ${repo}/.git commit -m x`, a], [`git --work-tree=${repo} commit -m x`, a], [`GIT_DIR=${repo}/.git git commit -m x`, a], [`GIT_WORK_TREE=${repo} git commit -m x`, a], [`env GIT_DIR=${repo}/.git git commit -m x`, a], [`git --git-dir=${a}/.git commit -m x`, a],
      ["git commit -m x && git -C .. commit -m y", a],
    ] as const) {
      const out = await bash(id, command, cwd);
      expect([id, command, cwd, out?.permissionDecision]).toEqual([id, command, cwd, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
    // The parent session is no sub-agent.
    for (const [command, cwd] of [["git commit -m x", a], ["git add -A && git commit -m x", a], [`git -C ${a} commit -m x`, repo]] as const) {
      const out = await bash(id, command, cwd, false);
      expect([id, command, cwd, out?.permissionDecision]).toEqual([id, command, cwd, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
  }
});

test("a PM's or lead's sub-agent keeps the rest of its parent's limits: no push, no landing shapes, no checkout -B off main, no hire, no f1rm merge, no pause", async () => {
  const { repo, a, main, behind, diverged, bash } = await ownerOffice();
  const landing = ["git rebase main", "git reset --hard HEAD~1", "git cherry-pick abc1234", "git pull", "git am fix.patch", "git revert abc1234", "gh pr merge 3",
    `git checkout -B worktree-add-a ${behind}`, `git checkout -B worktree-add-b ${main}`, `git checkout -B scratch ${diverged}`, `git checkout -B scratch HEAD~1`, "git checkout -B worktree-add-a", "git checkout -B worktree-add-a main extra", `git checkout -q -B worktree-add-b ${main}`, `git checkout -Bworktree-add-a ${main}`, "git switch -C worktree-add-a main", `git checkout -B worktree-add-a ${main}; git merge main`];
  for (const id of ["p", "l"]) {
    // An office step's interns merge inside their own worktree, as /implement-spec does: the integration branch into a ticket's, a ticket's into the integration branch.
    for (const command of ["git merge main", "git merge --no-ff worktree-add-b", "git merge spec-81 -m 'take the integration tip'", "git add -A && git merge --no-edit worktree-add-b", "git commit -m x && git merge main"]) {
      expect([id, command, await bash(id, command, a)]).toEqual([id, command, null]);
    }
    // Never from the main checkout or into another folder, and never from the parent session itself.
    for (const [command, cwd, sub] of [[`cd ${repo} && git merge worktree-add-a`, a, true], [`git -C ${repo} merge worktree-add-a`, a, true], ["git merge worktree-add-a", repo, true], ["git merge main", a, false]] as const) {
      const out = await bash(id, command, cwd, sub);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
    }
    for (const command of landing) {
      const out = await bash(id, command, a);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
    // The one move forward it needs: its branch is behind main, so main's tip loses nothing.
    for (const command of [`git checkout -B worktree-add-a ${main}`, `git checkout -B worktree-add-a ${main.slice(0, 9)}`, "git checkout -B worktree-add-a main", `git checkout -B worktree-new ${main}`, `git checkout -q -B worktree-add-a ${main}`, `git checkout -B worktree-add-a ${main} && git status`]) {
      expect([id, command, await bash(id, command, a)]).toEqual([id, command, null]);
    }
    for (const command of ["git push", "git push origin HEAD", "git -C . push --force", "git commit -m x && git push"]) {
      const out = await bash(id, command, a);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
    }
    const hire = await bash(id, `f1rm hire --team checkout designer checkout.designer-a a 'Task: a'`, a);
    expect([id, "hire", hire?.permissionDecision]).toEqual([id, "hire", "deny"]);
    for (const [command, reason] of [["f1rm merge add-a", "Only the PM and the office's steps run `f1rm merge`"], ["f1rm pause", "Only the PM pauses and resumes"], ["f1rm resume", "Only the PM pauses and resumes"]] as const) {
      const out = await bash(id, command, a);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]);
      expect(out.permissionDecisionReason).toContain(reason);
    }
  }
  // What the parent does (hire its own team) is not changed by this.
  expect((await bash("l", `f1rm hire --team checkout designer checkout.designer-a a 'Task: a'`, a, false))?.permissionDecisionReason).toStartWith("Nobody hires"); // and nobody hires, the parent neither
});

test("a PM's or lead's sub-agent cannot turn its worktree into the main checkout: not by its .git file, a folder that is no worktree, main checked out in it, GIT_DIR set earlier, a link followed by `..`, or the base branch as the branch it resets", async () => {
  const { repo, a, main, bash, call } = await ownerOffice();
  const plain = `${repo}/.claude/worktrees/plain`, hijack = `${repo}/.claude/worktrees/hijack`, onMain = `${repo}/.claude/worktrees/on-main`;
  for (const id of ["p", "l"]) {
    for (const file of [`${a}/.git`, `${a}/.GIT`, `${a}/.Git`, `${a}/sub/.GiT/config`, `${a}/sub/.git/config`, "../.git", "../.GIT"]) {
      const out = await call(id, "Write", { file_path: file }, file.startsWith("../") ? `${a}/sub` : a);
      expect([id, file, out?.permissionDecision]).toEqual([id, file, "deny"]);
      expect(out.permissionDecisionReason).toBe(WRITE_REFUSAL);
    }
    expect([id, await call(id, "Write", { file_path: `${a}/.github/ci.yml` }, a)]).toEqual([id, null]);
    for (const [command, cwd] of [
      ["git commit -m x", plain], ["git commit -m x", hijack], ["git commit -m x", onMain], [`git checkout -B worktree-add-a ${main}`, plain],
      [`export GIT_DIR=${repo}/.git; git commit -m x`, a], [`GIT_AUTHOR_NAME=x git commit -m x`, a], ["declare -x GIT_WORK_TREE=/x; git commit -m x", a],
      ["git -C out/.. commit -m x", a], ["cd out/.. && git commit -m x", a], ["git -C src/../.. commit -m x", a],
      [`git checkout -B main ${main}`, a], [`git checkout --ignore-other-worktrees -B main ${main}`, a],
      // the pointer file names another worktree's git dir
      ["git commit -m x", `${repo}/.claude/worktrees/swap`],
      // a home, a variable or a substitution in -C is not followed
      [`git -C ~/${basename(repo)} commit -m x`, a], [`git -C '$HOME/${basename(repo)}' commit -m x`, a], [`git -C "$HOME/${basename(repo)}" commit -a -m x`, a], [`git -C "$(dirname "$(git rev-parse --git-common-dir)")" commit -m x`, a], ["git -C $REPO commit -m x", a], ["git -C ~ commit -m x", a],
      // a state change on the same line is judged before the line runs
      ["git symbolic-ref HEAD refs/heads/main && git commit --allow-empty -m x", a], ["git checkout --ignore-other-worktrees main && git commit -m x", a], ["git checkout worktree-add-b && git commit -m x", a], ["git switch main && git commit -m x", a],
      [`ln -s ${repo} m && git -C m commit -a -m x`, a], [`ln -s ${repo} m && cd m && git commit -m x`, a], [`git update-ref HEAD ${main} && git commit -m x`, a], ["mv .git .gone && git commit -m x", a], ["cp x y && git commit -m x", a], ["rm .git && git commit -m x", a],
      [`git config core.worktree ${repo} && git commit -m x`, a], ["printf 'gitdir: x' > .git && git commit -m x", a], ["echo x >.git; git commit -m x", a], [`git checkout -B worktree-add-a ${main} && git commit -m x`, a],
    ] as const) {
      const out = await bash(id, command, cwd);
      expect([id, command, cwd, out?.permissionDecision]).toEqual([id, command, cwd, "deny"]);
      expect(out.permissionDecisionReason).toBe(LANDING_REFUSAL);
    }
  }
});

test("a dev's or a designer's sub-agent is held by no more than its parent: writes anywhere, commits in its worktree, and the base branch still closed", async () => {
  const { repo, a, bash, call } = await ownerOffice();
  for (const id of ["b", "d"]) {
    expect([id, await call(id, "Write", { file_path: `${repo}/src/x.ts` }, repo)]).toEqual([id, null]);
    expect([id, await call(id, "Write", { file_path: `${a}/x.ts` }, a)]).toEqual([id, null]);
    for (const command of ["git commit -m x", "git merge main", "git rebase main", "git reset --hard HEAD~1", "git checkout -B scratch HEAD~1"]) expect([id, command, await bash(id, command, a)]).toEqual([id, command, null]);
    for (const command of ["git commit -m x", "git merge main"]) {
      const out = await bash(id, command, repo);
      expect([id, command, out?.permissionDecision]).toEqual([id, command, "deny"]); // nothing lands on the base branch, for every role
    }
  }
  const hire = await bash("b", "f1rm hire designer designer-a a b", a);
  expect(hire?.permissionDecision).toBe("deny");
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
    await bash("v", "git log SECRET-BRANCH");
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

test("an employee has no intern cap: a third and a fourth intern pass, started or not; an f1rm role as an intern is still refused", async () => {
  start();
  await hook({ ...common("d", "UserPromptSubmit"), prompt: "go", agent_type: "f1rm:designer" });
  await office((s) => Object.keys(s.employees).length === 1);
  const agent = (id: string, subagent_type = "Explore") => hook(preToolUse(id, "Agent", { description: "look", prompt: "look around", subagent_type }));
  for (let i = 0; i < 4; i++) expect([i, await held(await agent("d"))]).toEqual([i, null]);
  const sub = (agent_id: string) => hook({ ...common("d", "SubagentStart"), agent_id, agent_type: "Explore" });
  for (const id of ["a1", "a2", "a3"]) await sub(id);
  await office((s) => Object.keys(s.interns).length === 3);
  expect(await held(await agent("d"))).toBeNull();
  const role = await held(await agent("d", "f1rm:backend-dev"));
  expect(role?.permissionDecision).toBe("deny");
  expect(role.permissionDecisionReason).toContain("A role is hired with `f1rm hire`, never started as an intern.");
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
  expect(calls).toEqual(["letgo d1", `remove ${repo} done`]); // tried once; the removal of the session failed after its work was kept and its worktree removed
  await Bun.sleep(400);
  expect(calls).toEqual(["letgo d1", `remove ${repo} done`]); // and not again every tick
});

test("the safety net leaves a merged hire's worktree alone while another session of its name or in its worktree is not done", async () => {
  const repo = "/code/shop", tree = `${repo}/.claude/worktrees/done`;
  const s = (id: string, name: string, state: string) => ({ id, name, kind: "background", state, cwd: tree });
  sessionList = [s("d1", "designer-done", "done"), s("d2", "designer-done", "working"), s("a1", "frontend-dev-other", "done"), s("a2", "my-own-session", "stopped")];
  mergedBranches = new Set(["worktree-done"]);
  let now = 1_000_000;
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir, clock: () => now, letGoAfterMs: 400 });
  await Bun.sleep(250);
  now += 1000;
  await Bun.sleep(600);
  expect(calls).toEqual([]); // the stale done entries (same name, same worktree) do not take the live one's worktree
  sessionList = sessionList.filter((x) => x.state === "done" && x.id === "d1");
  await Bun.sleep(250); // done and alone: counted from here
  now += 1000;
  await Bun.sleep(600);
  expect(calls).toEqual(["letgo d1", `remove ${repo} done`]); // once nothing else works there, it goes
});

// The skill gate: a hire is held until it loads the skills its first prompt names.
const hired = (id: string, prompt: string, agent_type = "f1rm:backend-dev", session_title = `${id}-title`) => hook({ ...common(id, "UserPromptSubmit"), prompt, agent_type, session_title });
const skillLoaded = (id: string, skill: string, hook_event_name = "PostToolUse") => hook({ ...common(id, hook_event_name), tool_name: "Skill", tool_input: { skill }, tool_use_id: "toolu_2" });
const tryTool = async (id: string, tool: string, input: object = {}) => (await held(await hook(preToolUse(id, tool, input))))?.permissionDecision ?? null;

// A skill the Skill tool refuses (disable-model-invocation, or unknown) fires no hook event at all, not even PostToolUseFailure
// (measured on Claude Code 2.1.308: a validation error comes before any hook). Its only trace is the session's own transcript.
const transcripts = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-transcripts-")));
const skillUse = (skill: string, extra: object = {}) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Skill", input: { skill } }] }, ...extra });
const refused = { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "toolu_9", content: "<tool_use_error>Skill x cannot be used with Skill tool due to disable-model-invocation.</tool_use_error>" }] } };
let transcriptCount = 0;
/** Writes `<transcripts>/<project>/<id>.jsonl` and returns its path. */
function transcript(id: string, lines: object[], project = `p${++transcriptCount}`) {
  mkdirSync(join(transcripts, project), { recursive: true });
  const file = join(transcripts, project, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const tryAt = async (id: string, path: string | undefined, tool = "Bash") => (await held(await hook({ ...preToolUse(id, tool, { command: "ls" }), transcript_path: path })))?.permissionDecision ?? null;

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

// Projects are isolated: an f1rm role messages only sessions of its own project (room), "main" and its own sub-agents.
async function projectsOffice() {
  start({ "/code/shop": "/code/shop/.git", "/code/shop/.claude/worktrees/a": "/code/shop/.git", "/code/blog": "/code/blog/.git" });
  const sockets: Record<string, string> = { "lead-s": "/tmp/cc-socks/1.sock", "pm-b": "/tmp/cc-socks/2.sock", "free": "/tmp/cc-socks/3.sock" };
  const seat = (id: string, cwd: string, title: string, type?: string) => hook({ ...common(id, "UserPromptSubmit"), cwd, prompt: "go", session_title: title, ...(type && { agent_type: type }) }, sockets[id] ? { "x-f1rm-messaging-socket": sockets[id] } : {});
  await seat("b", "/code/shop/.claude/worktrees/a", "shop.backend-dev-a", "f1rm:backend-dev"); // a worktree shares its repo's room
  await seat("lead-s", "/code/shop", "lead-shop", "f1rm:lead");
  await seat("pm-s", "/code/shop", "pm-shop", "f1rm:pm");
  await seat("lead-s-mirror", "/code/shop", "lead-shop", "f1rm:lead"); // the same session seen twice (local and Remote Control)
  await seat("pm-b", "/code/blog", "pm-blog", "f1rm:pm");
  await seat("twin-s", "/code/shop", "twin");
  await seat("twin-b", "/code/blog", "twin");
  await seat("free", "/code/blog", "freelancer"); // no role
  await hook({ ...common("b", "SubagentStart"), cwd: "/code/shop/.claude/worktrees/a", agent_id: "sub-1", agent_type: "Explore" });
  await office((s) => Object.keys(s.employees).length === 8 && Object.keys(s.interns).length === 1);
  const cwds: Record<string, string> = { b: "/code/shop/.claude/worktrees/a", "pm-b": "/code/blog", free: "/code/blog" };
  return async (id: string, to: string) => held(await hook({ ...preToolUse(id, "SendMessage", { to, message: "SECRET-TEXT" }), cwd: cwds[id] ?? "/code/shop" }));
}

test("a finished sub-agent can still be resumed by its parent, by agent id and no other way", async () => {
  const send = await projectsOffice();
  await hook({ ...common("b", "SubagentStop"), cwd: "/code/shop/.claude/worktrees/a", agent_id: "sub-1", agent_type: "Explore" });
  await office((s) => Object.keys(s.interns).length === 0);
  expect((await send("b", "sub-1"))?.permissionDecision ?? null).toBeNull();
  expect((await send("pm-b", "sub-1")).permissionDecision).toBe("deny"); // another employee's sub-agent
  expect((await send("b", "Explore")).permissionDecision).toBe("deny"); // a sub-agent type is not a sub-agent
});

test("after an office restart the replayed log still knows a parent's sub-agents, so it can resume one", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "f1rm-db-")), "events.db");
  const repos = { "/code/shop": "/code/shop/.git" };
  const open = () => (server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(repos), clientDir, dbPath }));
  open();
  await hook({ ...common("b", "UserPromptSubmit"), prompt: "go", session_title: "shop.backend-dev-a", agent_type: "f1rm:backend-dev" });
  await hook({ ...common("b", "SubagentStart"), agent_id: "sub-1", agent_type: "Explore" });
  server.stop(true);
  open();
  const send = async (to: string) => (await held(await hook(preToolUse("b", "SendMessage", { to, message: "x" }))))?.permissionDecision ?? null;
  expect(await send("sub-1")).toBeNull();
  expect(await send("sub-2")).toBe("deny");
});

// Who talks to whom: in one project a PM, two leads, members of two teams (one a Reviewer) and a freelancer; in another a PM.
const WHO = { pm: "pm-shop", l1: "lead-checkout", l2: "lead-search", c1: "checkout.backend-dev-a", c2: "checkout.frontend-dev-b", rv: "checkout.reviewer-review-a", s1: "search.backend-dev-c", free: "freelancer", pmb: "pm-blog" } as const;
async function talkOffice() {
  start({ "/code/shop": "/code/shop/.git", "/code/blog": "/code/blog/.git" });
  const types: Record<string, string | undefined> = { pm: "f1rm:pm", l1: "f1rm:lead", l2: "f1rm:lead", c1: "f1rm:backend-dev", c2: "f1rm:frontend-dev", rv: "f1rm:reviewer", s1: "f1rm:backend-dev", pmb: "f1rm:pm" };
  const cwd = (id: string) => (id === "pmb" ? "/code/blog" : "/code/shop");
  for (const [id, title] of Object.entries(WHO)) {
    await hook({ ...common(id, "UserPromptSubmit"), cwd: cwd(id), prompt: "go", session_title: title, ...(types[id] && { agent_type: types[id] }) });
  }
  for (const id of ["pm", "l1", "c1", "s1", "rv"]) await hook({ ...common(id, "SubagentStart"), cwd: cwd(id), agent_id: `i-${id}`, agent_type: "Explore" });
  await office((s) => Object.keys(s.employees).length === 9 && Object.keys(s.interns).length === 5);
  return async (id: string, to: string, message = "the contract is ready", extra: object = {}) => held(await hook({ ...preToolUse(id, "SendMessage", { to, message }), cwd: cwd(id), ...extra }));
}

// The flat flow: a PM, a lead, a simple dev (backend-dev-x) and a simple designer (designer-y) with no team, a team's designer and a content Reviewer, and a freelancer, in one registered repo.
const WT = (task: string) => `/code/shop/.claude/worktrees/${task}`;
async function flatOffice() {
  start({ "/code/shop": "/code/shop/.git" });
  const seats = [
    ["p", "f1rm:pm", "pm-shop", "/code/shop"], ["l", "f1rm:lead", "lead-checkout", "/code/shop"], ["s", "f1rm:backend-dev", "backend-dev-x", WT("x")], ["d", "f1rm:designer", "designer-y", WT("y")],
    ["m", "f1rm:designer", "checkout.designer-z", WT("z")], ["rv", "f1rm:reviewer", "checkout.reviewer-review-a", "/code/shop"], ["f", undefined, "freelancer", "/code/shop"],
  ] as const;
  const cwds: Record<string, string> = Object.fromEntries(seats.map(([id, , , cwd]) => [id, cwd]));
  for (const [id, type, session_title, cwd] of seats) await hook({ ...common(id, "UserPromptSubmit"), cwd, prompt: "go", session_title, ...(type && { agent_type: type }) });
  await hook({ ...common("s", "SubagentStart"), cwd: cwds.s, agent_id: "i-s", agent_type: "Explore" });
  await office((s) => Object.keys(s.employees).length === seats.length && Object.keys(s.interns).length === 1);
  return {
    send: async (id: string, to: string, message = "the contract is ready") => held(await hook({ ...preToolUse(id, "SendMessage", { to, message }), cwd: cwds[id] })),
    bash: async (id: string, command: string, extra: object = {}) => held(await hook({ ...preToolUse(id, "Bash", { command }), cwd: cwds[id], ...extra })),
  };
}

// A hire whose process ended (done, stopped, blocked on a limit) is listed by `claude agents --json --all` with no pid; no employee answers to its name.
const ended = (name: string, cwd = "/code/shop", state = "done") => ({ id: `e_${name}`, sessionId: `sid_${name}`, name, kind: "background", state, cwd });

test("the tray lists the registered projects' decision tickets and the browser answers one; a session's call to the route is refused", async () => {
  const resolved: string[] = [];
  const kept: Record<string, any> = {};
  const deps = {
    now: Date.now, owner: async () => "owner", ready: async () => [{ number: 7, title: "Spec: slugify", author: "owner", parent: null, subIssues: 1, subDone: 0, blockedBy: 0, pr: false }], live: async () => [], labeledBy: async () => "owner", start: async () => {}, held: () => false, resting: () => false,
    store: { load: (r: string) => (kept[r] ??= {}), save: (r: string, s: any) => void (kept[r] = s) },
    decisions: async () => [{ number: 12, author: "owner", at: Date.now(), url: "https://github.com/o/shop/issues/12", body: "<!-- f1rm:decision risk=high spec=7 recommended=1 -->\nShip it?\n\n1. Yes\n2. No\n" }],
    notify: () => {},
    open: async () => {},
    drop: async () => {},
    approve: async () => {},
    stop: async () => {},
    tickets: async () => [{ number: 8, title: "slugify", state: "open" as const, blockedBy: 0, labels: [] }],
    costs: () => ({}),
    ended: async () => [],
    release: async () => {},
    resolve: async (repo: string, n: number, spec: number | null, answer: string) => void resolved.push(`${repo} #${n} ${spec} ${answer}`),
  };
  start({ "/code/shop": "/code/shop/.git" }, undefined, undefined, { scheduler: { everyMs: 20, deps } });
  await hook({ ...common("l", "UserPromptSubmit"), cwd: "/code/shop", prompt: "go", agent_type: "f1rm:lead", session_title: "lead-checkout" });
  const seen = (await office((s: any) => s.decisions?.length === 1 && !!s.boards?.["/code/shop/.git"])) as any;
  // The whiteboard reads the issues, not a board file.
  expect(seen.boards["/code/shop/.git"]).toEqual([
    { id: "#7", owner: "spec", status: "todo", branch: "spec-7", task: "Spec: slugify" },
    { id: "#8", owner: "intern", status: "todo", branch: "ticket-8", task: "slugify" },
  ]);
  const d = seen.decisions[0];
  expect(d).toMatchObject({ number: 12, question: "Ship it?", options: ["Yes", "No"], recommended: 0, risk: "high", spec: 7 });
  expect((await ui(`decide/${encodeURIComponent(d.id)}`)).status).toBe(405);
  const res = await ui(`decide/${encodeURIComponent(d.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option: 1 }) });
  expect(await res.json()).toEqual({ ok: true });
  expect(resolved).toEqual(["/code/shop #12 7 No"]);
  await office((s: any) => s.decisions?.length === 0);
  const at = `http://127.0.0.1:${server.port}`;
  for (const command of [`curl -s -X POST ${at}/${TOKEN}/decide/x -d '{"option":0}'`, `curl -X POST "$(cat ~/.f1rm/office-url)decide/x"`]) {
    const out = await held(await hook({ ...preToolUse("l", "Bash", { command }), cwd: "/code/shop" }));
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out.permissionDecisionReason).toContain("Only the user answers a decision ticket");
  }
});

test("the office warns once the installed f1rm plugin is older than its own, and says nothing when they match or no f1rm is installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-plugins-"));
  const installed = join(dir, "installed_plugins.json"), own = join(dir, "plugin.json");
  writeFileSync(own, JSON.stringify({ name: "f1rm", version: "0.6.0" }));
  const plugins = (version: string) => writeFileSync(installed, JSON.stringify({ version: 2, plugins: { "f1rm@f1rm": [{ scope: "user", version }], "other@x": [{ version: "9.0.0" }] } }));
  plugins("0.3.0");
  start({ "/code/shop": "/code/shop/.git" }, undefined, undefined, { pluginFiles: { installed, own } });
  expect(((await office((s: any) => s.plugin !== undefined)) as any).plugin).toEqual({ installed: "0.3.0", office: "0.6.0" });
  server.stop(true);
  plugins("0.6.0-rc.1");
  start({ "/code/shop": "/code/shop/.git" }, undefined, undefined, { pluginFiles: { installed, own } });
  expect(((await office((s: any) => s.plugin !== undefined)) as any).plugin).toEqual({ installed: "0.6.0-rc.1", office: "0.6.0" });
  server.stop(true);
  for (const write of [() => plugins("0.6.0"), () => plugins("0.10.0"), () => writeFileSync(installed, JSON.stringify({ version: 2, plugins: {} })), () => writeFileSync(installed, "not json")]) {
    write();
    start({ "/code/shop": "/code/shop/.git" }, undefined, undefined, { pluginFiles: { installed, own } });
    expect(((await office(() => true)) as any).plugin ?? null).toBeNull();
    server.stop(true);
  }
});

test("the PM writes its repo's tracker setup (CLAUDE.md, AGENTS.md, docs/agents/) and nothing else of the repo; a lead and the PM's intern do not", async () => {
  await mainOffice();
  const write = async (id: string, file_path: string, extra: object = {}) => held(await hook({ ...preToolUse(id, "Write", { file_path }), cwd: "/code/shop", ...extra }));
  for (const f of ["/code/shop/CLAUDE.md", "/code/shop/AGENTS.md", "/code/shop/docs/agents/issue-tracker.md"]) expect([f, await write("p", f)]).toEqual([f, null]);
  for (const [id, f, extra] of [["p", "/code/shop/src/a.ts", {}], ["p", "/code/shop/docs/agents/../../src/a.ts", {}], ["p", "/code/shop/docs/spec.md", {}], ["l", "/code/shop/CLAUDE.md", {}], ["p", "/code/shop/CLAUDE.md", { agent_id: "intern-1" }]] as const) {
    const out = await write(id, f, extra);
    expect([id, f, out?.permissionDecision]).toEqual([id, f, "deny"]);
  }
});
