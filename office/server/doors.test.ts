// Seam: the lobby the page is pushed (rooms and employees over the WebSocket) after hooks reach /ingest, and POST /<token>/remove/<room>.
// Fake machine: the repos below are git repos; every other folder is not. The folders the office never gives a door are injected.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { junkRoots, writeForgotten } from "./doors.ts";
import { machine } from "./machine.ts";
import { changeEdition, projectFile, writeEdition } from "./editions.ts";
import { boardFile } from "./board.ts";
import type { OfficeState } from "./office.ts";
import { startServer } from "./server.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const HOME = "/home/me";
const JUNK = ["/tmp", "/private/tmp", "/var/folders/xx", `${HOME}/.f1rm`, `${HOME}/.claude`];
const REAL = ["/code/f1rm", "/code/feit", "/code/OmnisCraft", "/code/am-palma", "/code/youtube-made-viral"];
const GIT_REPOS = [...REAL, "/private/tmp/scratch/gitproj", `${HOME}/.f1rm/repo`];
const STRAYS = [
  `${HOME}/.f1rm`, "/private/tmp/xs-runs", `${HOME}/Documents/dev`, `${HOME}/.claude/agent-memory/f1rm-pm`, "/private/tmp/scratch/gitproj",
  `${HOME}/.f1rm/evidence/out`, `${HOME}/Documents/dev/feit-test-runs/runs-sc`, "/private/tmp", `${HOME}/.f1rm/scratch/y-screens`,
];

const dir = mkdtempSync(join(tmpdir(), "f1rm-doors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeMachine = (repos = GIT_REPOS) => ({
  // Git answers only for a folder that exists: a worktree removed after its hire was let go has no answer, so only the repo itself does.
  gitCommonDir: (cwd: string) => (repos.includes(cwd) ? cwd + "/.git" : null),
  isRepo: (folder: string) => repos.includes(folder),
  liveSessions: async () => new Map<string, { pid?: number }>(),
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

let now = 1_000_000;
let servers: ReturnType<typeof startServer>[] = [];
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  servers.forEach((s) => s.stop(true));
  servers = [];
});

let n = 0;
/** A fresh office; `files` reuses a previous office's db and settings folder, to restart it. */
function start(files = { dbPath: join(dir, `events-${n}.db`), root: join(dir, `office-${n++}`) }, extra: object = {}) {
  mkdirSync(files.root, { recursive: true });
  const server = startServer({
    port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(), clientDir: dir, clock: () => now,
    dbPath: files.dbPath, projectsDir: join(files.root, "projects"), boardsDir: join(files.root, "boards"), junkRoots: JUNK, ...extra,
  });
  servers.push(server);
  return { server, ...files, forgotten: join(files.root, "forgotten-doors.json") };
}
/** What `f1rm pm` leaves: the project's settings file, keyed by room id. The office only ever reads it. */
const register = (root: string, room: string, edition: "work" | "founder" = "work") => writeEdition(projectFile(join(root, "projects"), room), edition);
const base = (s: { port?: number }) => `http://127.0.0.1:${s.port}`;

const hook = (s: { port?: number }, session_id: string, cwd: string, hook_event_name = "SessionStart") =>
  fetch(`${base(s)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id, hook_event_name, cwd }),
  });

function office(s: { port?: number }, until: (o: OfficeState) => boolean = () => true, timeout = 2000) {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/${TOKEN}/ws`, { headers: { origin: base(s) } } as any);
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
const names = (o: OfficeState) => Object.values(o.rooms).map((r) => r.name).sort();
const remove = (s: { port?: number }, room: string, init: RequestInit & { token?: string } = {}) =>
  fetch(`${base(s)}/${init.token ?? TOKEN}/remove/${encodeURIComponent(room)}`, { method: "POST", ...init });

test("the lobby has a door for each registered project and one Elsewhere door while a stray session is alive", async () => {
  const { server, root } = start();
  for (const repo of REAL) register(root, repo + "/.git");
  for (const [i, cwd] of REAL.entries()) await hook(server, `real${i}`, cwd);
  await hook(server, "wt", "/code/f1rm/.claude/worktrees/task-1"); // a worktree rolls up to its repo
  await hook(server, "sub", "/code/feit/office/server"); // so does a subfolder
  for (const [i, cwd] of STRAYS.entries()) await hook(server, `stray${i}`, cwd);

  const state = await office(server);
  expect(names(state)).toEqual(["Elsewhere", "OmnisCraft", "am-palma", "feit", "f1rm", "youtube-made-viral"].sort());
  expect(state.rooms.elsewhere).toEqual({ id: "elsewhere", name: "Elsewhere" });
  expect(state.employees.wt.room).toBe(state.employees.real0.room);
  expect(state.employees.sub.room).toBe(state.employees.real1.room);
  // Jump needs the employee's own folder and terminal: only the room changes.
  expect(state.employees.stray2).toMatchObject({ room: "elsewhere", cwd: `${HOME}/Documents/dev` });
  expect(Object.values(state.employees).filter((e) => e.room === "elsewhere")).toHaveLength(STRAYS.length);

  for (const i of STRAYS.keys()) await hook(server, `stray${i}`, STRAYS[i], "SessionEnd");
  expect(names(await office(server))).toEqual(["OmnisCraft", "am-palma", "feit", "f1rm", "youtube-made-viral"].sort());
});

test("nothing under ~/.f1rm, ~/.claude or a temp folder gets a door, even a git repo or a folder with a projects json; any other project folder does", async () => {
  const { server, root } = start();
  const projects = join(root, "projects");
  for (const folder of ["/private/tmp/scratch/gitproj/.git", "/private/tmp", `${HOME}/.f1rm/scratch`, `${HOME}/.claude/agent-memory`, "/var/folders/xx/T/job", "/work/notes"]) writeEdition(projectFile(projects, folder), "work");
  for (const [i, cwd] of ["/private/tmp/scratch/gitproj", `${HOME}/.f1rm/repo`, "/private/tmp", `${HOME}/.f1rm/scratch`, `${HOME}/.claude/agent-memory`, "/var/folders/xx/T/job", "/work/notes", "/work/no-json"].entries()) {
    await hook(server, `s${i}`, cwd);
  }

  const state = await office(server);
  expect(Object.keys(state.rooms).sort()).toEqual(["/work/notes", "elsewhere"]);
  expect(state.employees.s6.room).toBe("/work/notes");
  expect(state.employees.s7.room).toBe("elsewhere");
  expect(state.employees.s0.room).toBe("elsewhere");
});

test("a session inside a junk folder gets no door even when its git repo is the home folder", async () => {
  const { server, root } = start(undefined, { machine: fakeMachine([HOME]) });
  register(root, HOME + "/.git");
  await hook(server, "in-junk", `${HOME}/.f1rm/evidence/out`);
  await hook(server, "at-home", `${HOME}/Documents`);

  const state = await office(server);
  expect(state.employees["in-junk"].room).toBe("elsewhere");
  expect(state.employees["at-home"].room).toBe(HOME + "/.git");
});

test("the folders never given a door are the temp folders and the office's own, past symlinks", () => {
  const roots = junkRoots("/Users/me", "/Users/me/Library/Caches/T/");
  expect(roots).toEqual(expect.arrayContaining(["/Users/me/.f1rm", "/Users/me/.claude", "/Users/me/Library/Caches/T", realpathSync("/tmp"), "/private/tmp"]));
  expect(junkRoots("/Users/me", "")).toHaveLength(roots.length - 1);
});

test("a lobby that an older office filled with junk doors is clean after a restart, with the same log", async () => {
  const files = { dbPath: join(dir, "old.db"), root: join(dir, "old-office") };
  const db = new Database(files.dbPath, { create: true });
  db.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  // What the old office logged: every cwd was its own room.
  for (const [i, cwd] of [...REAL, ...STRAYS].entries()) {
    const room = GIT_REPOS.includes(cwd) ? { id: cwd + "/.git", name: cwd.split("/").at(-1) } : { id: cwd, name: cwd.split("/").at(-1) };
    db.run("INSERT INTO events (at, event) VALUES (?, ?)", [now, JSON.stringify({ sessionId: `s${i}`, kind: "SessionStart", cwd, room, terminal: {}, at: now })]);
  }
  db.close();

  mkdirSync(files.root, { recursive: true });
  for (const repo of REAL) register(files.root, repo + "/.git");
  const { server } = start(files);
  const state = await office(server);
  expect(names(state)).toEqual(["Elsewhere", "OmnisCraft", "am-palma", "feit", "f1rm", "youtube-made-viral"].sort());
});

const settle = async (server: { port?: number }, id: string, cwd: string) => {
  await hook(server, id, cwd);
  await hook(server, id, cwd, "SessionEnd");
};
test("an empty door can be removed: its edition goes, boards, evidence and the repo stay, and a new session does not bring it back until the folder is registered again", async () => {
  const repo = mkdtempSync(join(dir, "shop-"));
  const room = repo + "/.git";
  const files = { dbPath: join(dir, "remove.db"), root: join(dir, "remove-office") };
  const { server, root, forgotten } = start(files, { machine: { ...fakeMachine([repo]) } });
  const edition = projectFile(join(root, "projects"), room), board = boardFile(join(root, "boards"), room);
  writeEdition(edition, "founder");
  await settle(server, "gone", repo);
  mkdirSync(join(root, "boards"), { recursive: true });
  writeFileSync(board, "| id | owner | status | branch | task |\n");
  writeFileSync(join(repo, "keep.txt"), "x");
  expect(room in (await office(server)).rooms).toBe(true);

  now += 10;
  const res = await remove(server, room);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(existsSync(edition)).toBe(false);
  expect(existsSync(board)).toBe(true);
  expect(existsSync(join(repo, "keep.txt"))).toBe(true);
  expect(JSON.parse(readFileSync(forgotten, "utf8"))).toEqual({ [room]: now });
  expect(statSync(forgotten).mode & 0o777).toBe(0o600);
  expect(Object.keys((await office(server)).rooms)).not.toContain(room);

  // Restarted, the old events do not bring it back.
  server.stop(true);
  const again = start(files, { machine: { ...fakeMachine([repo]) } });
  expect(Object.keys((await office(again.server)).rooms)).not.toContain(room);

  // A new session there does not: the registration went with the door, and the office never writes one.
  now += 10;
  await hook(again.server, "stray", repo);
  expect(Object.keys((await office(again.server)).rooms)).toEqual(["elsewhere"]);
  expect(existsSync(edition)).toBe(false);
  await hook(again.server, "stray", repo, "SessionEnd");
  // Registered again, the next event brings the door back and it holds across a restart.
  now += 10;
  writeEdition(edition, "work");
  await hook(again.server, "back", repo);
  expect(Object.keys((await office(again.server)).rooms)).toEqual([room]);
  again.server.stop(true);
  const third = start(files, { machine: { ...fakeMachine([repo]) } });
  expect(Object.keys((await office(third.server)).rooms)).toContain(room);
});

test("a forgotten-doors file of the wrong shape counts as empty and is mended by the next removal", async () => {
  for (const bad of ["null", "[1]", '"x"', '{"/code/feit/.git":"later","/code/shop/.git":null}', "{"]) {
    const files = { dbPath: join(dir, `bad-${n}.db`), root: join(dir, `bad-office-${n++}`) };
    mkdirSync(files.root);
    writeFileSync(join(files.root, "forgotten-doors.json"), bad);
    const { server, root, forgotten } = start(files);
    register(root, "/code/feit/.git");
    await settle(server, "gone", "/code/feit");
    expect(Object.keys((await office(server)).rooms), bad).toEqual(["/code/feit/.git"]);
    expect((await remove(server, "/code/feit/.git")).status, bad).toBe(200);
    expect(JSON.parse(readFileSync(forgotten, "utf8")), bad).toEqual({ "/code/feit/.git": now });
  }
});

test("a door with someone in it, an unknown door and Elsewhere are not removed", async () => {
  const { server, root, forgotten } = start();
  register(root, "/code/feit/.git");
  await hook(server, "in", "/code/feit");
  await hook(server, "out", "/private/tmp/x");
  const feit = "/code/feit/.git";
  const occupied = await remove(server, feit);
  expect(occupied.status).toBe(409);
  expect(await occupied.json()).toEqual({ error: "That door isn't empty." });
  const unknown = await remove(server, "/code/nowhere/.git");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "No such door." });
  expect((await remove(server, "elsewhere")).status).toBe(409);
  await hook(server, "out", "/private/tmp/x", "SessionEnd");
  expect((await remove(server, "elsewhere")).status).toBe(409);
  expect(existsSync(forgotten)).toBe(false);
  expect(Object.keys((await office(server)).rooms)).toEqual([feit]);
});

test("remove needs the UI token, a local Origin and a POST", async () => {
  const { server, root, forgotten } = start();
  register(root, "/code/feit/.git");
  await settle(server, "gone", "/code/feit");
  const room = "/code/feit/.git";
  expect((await remove(server, room, { token: "wrong" })).status).toBe(401);
  expect((await remove(server, room, { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect((await remove(server, room, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await remove(server, room, { method: "GET" })).status).toBe(405);
  expect(existsSync(forgotten)).toBe(false);
  expect(room in (await office(server)).rooms).toBe(true);
});

test("the Elsewhere door has no edition, no board and no PM to start", async () => {
  const { server } = start();
  await hook(server, "stray", "/private/tmp/x");
  for (const path of ["edition", "hire", "start-pm", "decide"]) {
    const res = await fetch(`${base(server)}/${TOKEN}/${path}`, { method: "POST", body: JSON.stringify({ room: "elsewhere", edition: "work", role: "backend", task: "t", brief: "b", need: "n" }) });
    expect(res.status).toBe(404);
  }
});

test("the forgotten-doors file is private even when a stale .tmp with open permissions is left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-doors-"));
  const file = join(dir, "forgotten.json");
  writeFileSync(file + ".tmp", "stale");
  chmodSync(file + ".tmp", 0o644);
  writeForgotten(file, { room: 1 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ room: 1 });
});

test("a link left at the forgotten-doors .tmp is not followed: the file it points at is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-doors-"));
  const victim = join(dir, "victim");
  writeFileSync(victim, "victim");
  chmodSync(victim, 0o644);
  const file = join(dir, "forgotten.json");
  symlinkSync(victim, file + ".tmp");
  writeForgotten(file, { room: 1 });
  expect(readFileSync(victim, "utf8")).toBe("victim");
  expect(lstatSync(file).isSymbolicLink()).toBe(false);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a git repo with no registration has no door: its sessions show under Elsewhere while alive, and nothing remains after they end", async () => {
  const { server } = start();
  await hook(server, "a", "/code/feit");
  await hook(server, "b", "/code/feit/office/server");
  const state = await office(server);
  expect(Object.keys(state.rooms)).toEqual(["elsewhere"]);
  expect([state.employees.a.room, state.employees.b.room]).toEqual(["elsewhere", "elsewhere"]);
  expect(state.employees.a.cwd).toBe("/code/feit");

  await hook(server, "a", "/code/feit", "SessionEnd");
  await hook(server, "b", "/code/feit/office/server", "SessionEnd");
  expect((await office(server)).rooms).toEqual({});
});

test("a folder registered after the office started gets its door on its next event, with no restart", async () => {
  const { server, root } = start();
  await settle(server, "early", "/code/feit");
  await settle(server, "early-plain", "/work/notes");
  expect((await office(server)).rooms).toEqual({});

  register(root, "/code/feit/.git");
  register(root, "/work/notes");
  await hook(server, "late", "/code/feit/office");
  await hook(server, "late-plain", "/work/notes");
  const state = await office(server);
  expect(state.employees.late.room).toBe("/code/feit/.git");
  expect(state.employees["late-plain"].room).toBe("/work/notes");
  expect(Object.keys(state.rooms).sort()).toEqual(["/code/feit/.git", "/work/notes"]);
});

test("a session that came before the registration moves to the new door on its next event, and Elsewhere goes with its last stray", async () => {
  const { server, root } = start();
  await hook(server, "one", "/code/feit");
  await hook(server, "two", "/code/feit/office");
  await hook(server, "other", "/private/tmp/x");
  expect(Object.values((await office(server)).employees).every((e) => e.room === "elsewhere")).toBe(true);

  register(root, "/code/feit/.git");
  await hook(server, "one", "/code/feit", "PreToolUse");
  let state = await office(server);
  expect([state.employees.one.room, state.employees.two.room]).toEqual(["/code/feit/.git", "elsewhere"]);
  await hook(server, "two", "/code/feit/office", "Stop");
  await hook(server, "other", "/private/tmp/x", "SessionEnd");
  state = await office(server);
  expect(Object.keys(state.rooms)).toEqual(["/code/feit/.git"]);
  expect(Object.values(state.employees).map((e) => e.room)).toEqual(["/code/feit/.git", "/code/feit/.git"]);
});

test("the office never writes a registration: the edition POST for a door whose file is gone answers an error and writes nothing", async () => {
  const { server, root } = start();
  const file = projectFile(join(root, "projects"), "/code/feit/.git");
  register(root, "/code/feit/.git");
  await hook(server, "in", "/code/feit");
  rmSync(file);
  const post = (edition: string) => fetch(`${base(server)}/${TOKEN}/edition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "/code/feit/.git", edition }) });
  expect((await post("founder")).status).toBe(404);
  expect(existsSync(file)).toBe(false);

  // With the file there it still changes the edition.
  register(root, "/code/feit/.git");
  expect((await post("founder")).status).toBe(200);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ edition: "founder" });
});

test("a registration under ~/.f1rm, ~/.claude or a temp folder gives no door, and a worktree or subfolder of a registered repo rolls up to its door", async () => {
  const { server, root } = start();
  const repos = [`${HOME}/.f1rm/repo`, "/private/tmp/scratch/gitproj", "/code/f1rm"];
  for (const repo of repos) register(root, repo + "/.git");
  register(root, `${HOME}/.claude/agent-memory`);
  await hook(server, "a", `${HOME}/.f1rm/repo`);
  await hook(server, "b", "/private/tmp/scratch/gitproj");
  await hook(server, "c", `${HOME}/.claude/agent-memory`);
  await hook(server, "wt", "/code/f1rm/.claude/worktrees/task-1");
  await hook(server, "sub", "/code/f1rm/office/server");
  const state = await office(server);
  expect(Object.keys(state.rooms).sort()).toEqual(["/code/f1rm/.git", "elsewhere"]);
  expect([state.employees.a.room, state.employees.b.room, state.employees.c.room]).toEqual(["elsewhere", "elsewhere", "elsewhere"]);
  expect([state.employees.wt.room, state.employees.sub.room]).toEqual(["/code/f1rm/.git", "/code/f1rm/.git"]);
});

test("a removed worktree's old events, replayed from the log, roll up into the project's door, not a new one", async () => {
  const files = { dbPath: join(dir, `gone-wt-${n}.db`), root: join(dir, `gone-wt-office-${n++}`) };
  const db = new Database(files.dbPath, { create: true });
  db.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  for (const [i, cwd] of ["/code/f1rm/.claude/worktrees/lead-tag", "/code/f1rm/.claude/worktrees/lobby-doors-client", "/code/f1rm"].entries()) {
    const room = { id: cwd, name: cwd.split("/").at(-1) }; // what the old office logged: a door per cwd
    db.run("INSERT INTO events (at, event) VALUES (?, ?)", [now, JSON.stringify({ sessionId: `s${i}`, kind: "SessionStart", cwd, room, terminal: {}, at: now })]);
  }
  db.close();
  mkdirSync(files.root, { recursive: true });
  register(files.root, "/code/f1rm/.git");

  const { server } = start(files, { machine: fakeMachine(["/code/f1rm"]) });
  const state = await office(server);
  expect(Object.keys(state.rooms)).toEqual(["/code/f1rm/.git"]);
  expect(Object.values(state.employees).map((e) => e.room)).toEqual(["/code/f1rm/.git", "/code/f1rm/.git", "/code/f1rm/.git"]);
  expect(state.employees.s0.cwd).toBe("/code/f1rm/.claude/worktrees/lead-tag");
});

test("a session belongs to the registered folder that contains its cwd, the longest one when registered folders nest", async () => {
  const { server, root } = start(undefined, { machine: fakeMachine(["/code/mono"]) });
  register(root, "/code/mono/.git");
  register(root, "/code/mono/apps/web"); // a non-git folder registered inside the repo
  await hook(server, "api", "/code/mono/apps/api/src");
  await hook(server, "web", "/code/mono/apps/web");
  await hook(server, "web-deep", "/code/mono/apps/web/src/deep/gone");
  await hook(server, "root", "/code/mono");
  const state = await office(server);
  expect(state.employees.api.room).toBe("/code/mono/.git");
  expect(state.employees.root.room).toBe("/code/mono/.git");
  expect([state.employees.web.room, state.employees["web-deep"].room]).toEqual(["/code/mono/apps/web", "/code/mono/apps/web"]);
  expect(Object.keys(state.rooms).sort()).toEqual(["/code/mono/.git", "/code/mono/apps/web"]);
});

test("the office's own folders and the parent of registered projects get no door, even inside a registered folder", async () => {
  const { server, root } = start(undefined, { machine: fakeMachine([HOME, `${HOME}/Documents/dev/f1rm`]) });
  register(root, HOME + "/.git");
  register(root, `${HOME}/Documents/dev/f1rm/.git`);
  for (const [i, cwd] of [`${HOME}/.f1rm/boards`, `${HOME}/.f1rm/evidence/f1rm/x`, `${HOME}/.claude/projects/x`, `${HOME}/Documents/dev/f1rm/.claude/worktrees/t1`].entries()) await hook(server, `s${i}`, cwd);
  const state = await office(server);
  expect([state.employees.s0.room, state.employees.s1.room, state.employees.s2.room]).toEqual(["elsewhere", "elsewhere", "elsewhere"]);
  expect(state.employees.s3.room).toBe(`${HOME}/Documents/dev/f1rm/.git`);

  // With only the projects registered, their parent folder is no project.
  const second = start(undefined, { machine: fakeMachine([`${HOME}/Documents/dev/f1rm`]) });
  register(second.root, `${HOME}/Documents/dev/f1rm/.git`);
  await hook(second.server, "dev", `${HOME}/Documents/dev`);
  expect((await office(second.server)).employees.dev.room).toBe("elsewhere");
});

test("changing an edition never creates the file: a registration removed in between stays removed, and a longer old value is not left behind", () => {
  const folder = mkdtempSync(join(dir, "edition-"));
  const file = join(folder, "p.json");
  expect(() => changeEdition(file, "founder")).toThrow(/ENOENT/);
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, '{"edition":"founder","other":"a longer old value"}\n');
  changeEdition(file, "work");
  expect(readFileSync(file, "utf8")).toBe('{"edition":"work"}\n');
});

test("a door whose registration was removed outside the office leaves with its last session, instead of a stale empty door", async () => {
  const { server, root } = start(undefined, { machine: fakeMachine(["/code/feit"]), boardPollMs: 20 });
  register(root, "/code/feit/.git");
  await hook(server, "in", "/code/feit");
  expect(Object.keys((await office(server)).rooms)).toEqual(["/code/feit/.git"]);
  rmSync(projectFile(join(root, "projects"), "/code/feit/.git"));
  await hook(server, "in", "/code/feit", "Stop"); // it moves to Elsewhere
  const state = await office(server, (o) => !("/code/feit/.git" in o.rooms));
  expect(Object.keys(state.rooms)).toEqual(["elsewhere"]);
  expect(state.employees.in.room).toBe("elsewhere");
});

test("a door removed in the office leaves no ghost in Elsewhere when the office restarts with the same log", async () => {
  const files = { dbPath: join(dir, `ghost-${n}.db`), root: join(dir, `ghost-office-${n++}`) };
  const db = new Database(files.dbPath, { create: true });
  db.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  // A session that crashed: its SessionEnd never came. The door was removed after it, at now + 5.
  for (const [i, cwd] of ["/code/feit", "/code/feit/.claude/worktrees/gone"].entries()) {
    db.run("INSERT INTO events (at, event) VALUES (?, ?)", [now, JSON.stringify({ sessionId: `crash${i}`, kind: "SessionStart", cwd, room: { id: "/code/feit/.git", name: "feit" }, terminal: {}, at: now })]);
  }
  db.close();
  mkdirSync(files.root, { recursive: true });
  writeForgotten(join(files.root, "forgotten-doors.json"), { "/code/feit/.git": now + 5 });

  const { server } = start(files, { machine: fakeMachine(["/code/feit"]) });
  const state = await office(server);
  expect(state.rooms).toEqual({});
  expect(state.employees).toEqual({});
});

/** A log of SessionStart events, the way a crashed office left it: no SessionEnd. */
function seedLog(name: string, cwds: Record<string, string>) {
  const files = { dbPath: join(dir, `${name}-${n}.db`), root: join(dir, `${name}-office-${n++}`) };
  const db = new Database(files.dbPath, { create: true });
  db.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  for (const [sessionId, cwd] of Object.entries(cwds)) {
    db.run("INSERT INTO events (at, event) VALUES (?, ?)", [now, JSON.stringify({ sessionId, kind: "SessionStart", cwd, room: { id: cwd, name: "x" }, terminal: {}, at: now })]);
  }
  db.close();
  mkdirSync(files.root, { recursive: true });
  return files;
}

test("removing a door nested in another registered folder leaves no ghost in the outer door when the office restarts", async () => {
  const files = seedLog("nested", { outer: `${HOME}/Documents`, inner: `${HOME}/Documents/shop/src`, "inner-wt": `${HOME}/Documents/shop/.claude/worktrees/gone` });
  register(files.root, HOME + "/.git"); // the outer door: the home folder is a repo
  register(files.root, `${HOME}/Documents/shop/.git`);
  const inner = `${HOME}/Documents/shop/.git`;
  writeForgotten(join(files.root, "forgotten-doors.json"), { [inner]: now + 5 });
  rmSync(projectFile(join(files.root, "projects"), inner)); // Remove deleted the inner registration

  const { server } = start(files, { machine: fakeMachine([HOME, `${HOME}/Documents/shop`]) });
  const state = await office(server);
  expect(Object.keys(state.employees)).toEqual(["outer"]);
  expect(Object.keys(state.rooms)).toEqual([HOME + "/.git"]);
});

test("replaying a log, a door inside a removed folder keeps its own sessions", async () => {
  const files = seedLog("kept", { stale: "/code/mono/lib", kept: "/code/mono/apps/web/src" });
  register(files.root, "/code/mono/apps/web");
  writeForgotten(join(files.root, "forgotten-doors.json"), { "/code/mono/.git": now + 5 });

  const { server } = start(files, { machine: fakeMachine(["/code/mono"]) });
  const state = await office(server);
  expect(Object.keys(state.employees)).toEqual(["kept"]);
  expect(state.employees.kept.room).toBe("/code/mono/apps/web");
});

test("a cwd with a trailing slash belongs to its own registered folder", async () => {
  const { server, root } = start();
  register(root, "/code/feit/.git");
  await hook(server, "slash", "/code/feit/");
  await hook(server, "sub-slash", "/code/feit/office/");
  const state = await office(server);
  expect([state.employees.slash.room, state.employees["sub-slash"].room]).toEqual(["/code/feit/.git", "/code/feit/.git"]);
});

test("for a symlinked cwd the longest registered folder wins, whether it is found by the cwd or by its real path", async () => {
  const real = realpathSync(mkdtempSync(join(dir, "links-")));
  mkdirSync(join(real, "real", "proj", "sub"), { recursive: true });
  symlinkSync(join(real, "real"), join(real, "link"));
  const { server, root } = start();
  register(root, join(real, "link")); // shorter, found walking the cwd as given
  register(root, join(real, "real", "proj")); // longer, found through the real path
  await hook(server, "via-link", join(real, "link", "proj", "sub"));
  const state = await office(server);
  expect(state.employees["via-link"].room).toBe(join(real, "real", "proj"));
});

test("a folder is a repo when it holds a .git directory, and no git is run to tell", () => {
  const folder = mkdtempSync(join(dir, "isrepo-"));
  expect(machine.isRepo(folder)).toBe(false);
  mkdirSync(join(folder, ".git"));
  expect(machine.isRepo(folder)).toBe(true);
  const worktree = mkdtempSync(join(dir, "isrepo-wt-"));
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n"); // a linked worktree holds a .git file
  expect(machine.isRepo(worktree)).toBe(false);
  expect(machine.isRepo(join(folder, "missing"))).toBe(false);
});

test("a folder registered as plain and `git init`ed later keeps its one door: the id is decided once while the office runs", async () => {
  const repos: string[] = [];
  const { server, root } = start(undefined, { machine: fakeMachine(repos) });
  register(root, "/code/app");
  await hook(server, "a", "/code/app");
  expect(Object.keys((await office(server)).rooms)).toEqual(["/code/app"]);
  repos.push("/code/app"); // git init
  await hook(server, "a", "/code/app", "PreToolUse");
  await hook(server, "b", "/code/app/src");
  const state = await office(server);
  expect(Object.keys(state.rooms)).toEqual(["/code/app"]);
  expect([state.employees.a.room, state.employees.b.room]).toEqual(["/code/app", "/code/app"]);
});

test("through a symlink, the registered folder nearest the cwd wins, not the one with the longer path", async () => {
  const real = realpathSync(mkdtempSync(join(dir, "near-")));
  mkdirSync(join(real, "s", "p", "sub"), { recursive: true });
  mkdirSync(join(real, "people", "me"), { recursive: true });
  symlinkSync(join(real, "s"), join(real, "people", "me", "work"));
  const { server, root } = start();
  register(root, join(real, "people", "me")); // the shallow one, found walking the cwd as given: 3 folders up
  register(root, join(real, "s", "p")); // the project, found through the real path: 1 folder up
  await hook(server, "x", join(real, "people", "me", "work", "p", "sub"));
  expect((await office(server)).employees.x.room).toBe(join(real, "s", "p"));
});

test("a registered folder inside a junk folder gives no door even when a link leads the cwd there", async () => {
  const real = realpathSync(mkdtempSync(join(dir, "junklink-")));
  mkdirSync(join(real, "code", "shop", "sub"), { recursive: true });
  mkdirSync(join(real, "junk"));
  symlinkSync(join(real, "code", "shop"), join(real, "junk", "link"));
  const { server, root } = start(undefined, { junkRoots: [join(real, "junk")] });
  register(root, join(real, "junk")); // a registration inside the junk folder
  await hook(server, "x", join(real, "junk", "link", "sub")); // the cwd is really in code/shop
  expect((await office(server)).employees.x.room).toBe("elsewhere");
});
