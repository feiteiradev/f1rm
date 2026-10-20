// Seam: the lobby the page is pushed (rooms and employees over the WebSocket) after hooks reach /ingest, and POST /<token>/remove/<room>.
// Fake machine: the repos below are git repos; every other folder is not. The folders the office never gives a door are injected.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { junkRoots } from "./doors.ts";
import { projectFile, writeEdition } from "./editions.ts";
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
  gitCommonDir: (cwd: string) => {
    const repo = repos.find((r) => cwd === r || cwd.startsWith(r + "/"));
    return repo ? repo + "/.git" : null;
  },
  liveSessions: async () => new Map<string, number | undefined>(),
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

test("the lobby has a door for each real project and one Elsewhere door while a stray session is alive", async () => {
  const { server } = start();
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
  const { server } = start(undefined, { machine: fakeMachine([HOME]) });
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

  const { server } = start(files);
  const state = await office(server);
  expect(names(state)).toEqual(["Elsewhere", "OmnisCraft", "am-palma", "feit", "f1rm", "youtube-made-viral"].sort());
});

const settle = async (server: { port?: number }, id: string, cwd: string) => {
  await hook(server, id, cwd);
  await hook(server, id, cwd, "SessionEnd");
};
test("an empty door can be removed: its edition goes, boards, evidence and the repo stay, and a new session brings it back", async () => {
  const repo = mkdtempSync(join(dir, "shop-"));
  const room = repo + "/.git";
  const files = { dbPath: join(dir, "remove.db"), root: join(dir, "remove-office") };
  const { server, root, forgotten } = start(files, { machine: { ...fakeMachine([repo]) } });
  await settle(server, "gone", repo);
  const edition = projectFile(join(root, "projects"), room), board = boardFile(join(root, "boards"), room);
  writeEdition(edition, "founder");
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

  // A new session there does.
  now += 10;
  await hook(again.server, "back", repo);
  expect(Object.keys((await office(again.server)).rooms)).toContain(room);
  again.server.stop(true);
  const third = start(files, { machine: { ...fakeMachine([repo]) } });
  expect(Object.keys((await office(third.server)).rooms)).toContain(room);
});

test("a forgotten-doors file of the wrong shape counts as empty and is mended by the next removal", async () => {
  for (const bad of ["null", "[1]", '"x"', '{"/code/feit/.git":"later","/code/shop/.git":null}', "{"]) {
    const files = { dbPath: join(dir, `bad-${n}.db`), root: join(dir, `bad-office-${n++}`) };
    mkdirSync(files.root);
    writeFileSync(join(files.root, "forgotten-doors.json"), bad);
    const { server, forgotten } = start(files);
    await settle(server, "gone", "/code/feit");
    expect(Object.keys((await office(server)).rooms), bad).toEqual(["/code/feit/.git"]);
    expect((await remove(server, "/code/feit/.git")).status, bad).toBe(200);
    expect(JSON.parse(readFileSync(forgotten, "utf8")), bad).toEqual({ "/code/feit/.git": now });
  }
});

test("a door with someone in it, an unknown door and Elsewhere are not removed", async () => {
  const { server, forgotten } = start();
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
  const { server, forgotten } = start();
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
