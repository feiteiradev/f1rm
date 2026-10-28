// Seam: a pause through the office's route stops the project's sessions and the processes they started, checks that nothing of the project runs, and checkpoints it.
// Real temp git repo and worktree, the machine and the process table faked.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointDirOf, latestManifest, readManifest } from "./checkpoint.ts";
import { projectFile } from "./editions.ts";
import type { Proc } from "./fullstop.ts";
import { readPaused, pausedFile } from "./pause.ts";
import { startServer } from "./server.ts";
import { DEFAULTS, overrideFile, readOverride, type WorkHours } from "./workhours.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
const root = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-fullpause-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const sha = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex");

let n = 0;
/** A repo `shop` with a worktree `x`, an uncommitted edit and an untracked file in it. */
function project() {
  const repo = join(root, `shop-${n++}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const wt = join(repo, ".claude", "worktrees", "x");
  git(repo, "worktree", "add", "-q", "-b", "worktree-x", wt, "main");
  writeFileSync(join(wt, "a.txt"), "one, edited\n");
  writeFileSync(join(wt, "new.txt"), "untracked\n");
  return { repo, wt, room: join(repo, ".git") };
}

// The process table and the live sessions the faked machine and kill work on.
let table: Proc[] = [];
let stuck: number[] = [];
let sent: [number, string][] = [];
let stopped: string[] = [];
let spawned = 0;
let stopFails: string[] = []; // sessions `claude stop` refuses
let procsError: string | null = null; // a process table that cannot be read
let procsFailures = 0; // the next reads that fail, then it works again
// What `claude agents --json --all` lists after the stop: the sessions the resume can wake.
let listed: { id: string; name: string; kind: string; state: string; cwd: string; sessionId: string; pid?: number; startedAt?: number; status?: string }[] = [];
const sessionPids = new Map<string, number>();
const machine = (repo: string) => ({
  gitCommonDir: (cwd: string) => (cwd.startsWith(repo) ? join(repo, ".git") : null),
  isRepo: () => true,
  liveSessions: async () => new Map([...sessionPids].map(([id, pid]) => [id, { pid, status: "idle" as const }])),
  backgroundId: async (id: string) => (id === "interactive" ? null : `bg-${id}`),
  stop: async (id: string) => {
    stopped.push(id);
    if (stopFails.includes(id)) return false;
    table = table.filter((q) => q.pid !== sessionPids.get(id));
    sessionPids.delete(id);
    return true;
  },
  sessions: async () => listed, mergedBranch: () => false, removeWorktree: () => {}, focusIterm: async () => false, attachInIterm: async () => {}, openVsCode: async () => {},
  askFork: async function* () {}, tell: async () => {}, workingHires: async () => 0, backgroundSessions: async () => [], spawnBackground: async () => (spawned++, ""), startPmInIterm: async () => {},
});
const fullStop = () => ({
  procs: async () => {
    if (procsFailures > 0) {
      procsFailures--;
      throw new Error("lsof timed out");
    }
    if (procsError) throw new Error(procsError);
    return table;
  },
  kill: (pid: number, sig: "SIGTERM" | "SIGKILL") => {
    sent.push([pid, sig]);
    if (!stuck.includes(pid)) table = table.filter((q) => q.pid !== pid);
  },
  sleep: async () => {},
  protect: [200],
});

let servers: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  servers.forEach((s) => s.stop(true));
  servers = [];
  table = [];
  stuck = [];
  sent = [];
  stopped = [];
  spawned = 0;
  stopFails = [];
  procsError = null;
  procsFailures = 0;
  listed = [];
  sessionPids.clear();
});

function start(p: ReturnType<typeof project>, extra: object = {}, home = mkdtempSync(join(root, "home-"))) {
  const projectsDir = join(home, "projects"), pausedDir = join(home, "paused"), checkpointsDir = join(home, "checkpoints"), boardsDir = join(home, "boards");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(boardsDir, { recursive: true });
  writeFileSync(projectFile(projectsDir, p.room), "{}\n");
  writeFileSync(join(boardsDir, `${p.repo.replace(/[^A-Za-z0-9]/g, "-")}.team.checkout.md`), "# Board\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| T1 | checkout.backend-dev-x | doing | worktree-x | the checkout page |\n");
  const server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: machine(p.repo) as any, clientDir: home, projectsDir, pausedDir, checkpointsDir, boardsDir, boardPollMs: 30, junkRoots: [], dbPath: join(home, "events.db"), offlineAfterMs: 400, removeAfterMs: 1e12, isAlive: () => true, fullStop: fullStop(), ...extra } as any);
  servers.push(server);
  return { server, home, projectsDir, pausedDir, checkpointsDir, boardsDir };
}
const url = (server: { port?: number }, path = "ingest") => `http://127.0.0.1:${server.port}/${path}`;
const seat = (server: { port?: number }, session_id: string, title: string, agent_type: string, cwd: string) => {
  const transcript_path = join(root, `${session_id}.jsonl`);
  writeFileSync(transcript_path, '{"type":"user"}\n');
  return fetch(url(server), { method: "POST", headers: { "content-type": "application/json", "x-f1rm-secret": SECRET }, body: JSON.stringify({ session_id, hook_event_name: "UserPromptSubmit", prompt: "go", cwd, session_title: title, agent_type, transcript_path }) });
};
const post = (server: { port?: number }, path: string, body: object) => fetch(url(server, `${TOKEN}/${path}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const proc = (pid: number, ppid: number, command: string, cwd: string): Proc => ({ pid, ppid, command, cwd });
/** What runs: the office, the user's terminal and interactive claude, two hires and a `sleep` the dev started, and another project's orphan. */
function world(p: ReturnType<typeof project>) {
  table = [
    proc(1, 0, "/sbin/launchd", "/"), proc(200, 1, "bun f1rm.ts serve", p.repo), proc(100, 1, "iTerm2", "/"), proc(101, 100, "-zsh", p.repo), proc(102, 101, "claude", p.wt),
    proc(310, 300, "claude --bg lead", p.repo), proc(320, 300, "claude --bg dev", p.wt), proc(321, 320, "zsh -c sleep 600", p.wt), proc(322, 321, "sleep 600", p.wt),
    proc(900, 1, "sleep 600", "/code/other/.claude/worktrees/x"),
  ];
  sessionPids.set("lead", 310);
  sessionPids.set("dev", 320);
}

test("a pause stops the sessions and kills what they started, checks that nothing is left, and keeps a manifest and a snapshot of the dirty worktree", async () => {
  const p = project();
  world(p);
  const o = start(p);
  await seat(o.server, "lead", "lead-checkout", "f1rm:lead", p.repo);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await seat(o.server, "pm", "pm-shop", "f1rm:pm", p.repo);
  await settle();
  const files = { a: sha(join(p.wt, "a.txt")), mtime: statSync(join(p.wt, "a.txt")).mtimeMs, head: git(p.wt, "rev-parse", "HEAD"), index: readFileSync(join(git(p.wt, "rev-parse", "--absolute-git-dir"), "index")).toString("hex") };

  const r = await post(o.server, "pause", { room: p.room, why: "lunch" });
  const body: any = await r.json();

  expect(r.status).toBe(200);
  const res = body.results[0];
  expect(res).toMatchObject({ verified: true, remaining: [], stopped: ["lead-checkout", "checkout.backend-dev-x"] });
  expect(res.killed.map((k: any) => [k.pid, k.command])).toEqual([[321, "zsh -c sleep 600"], [322, "sleep 600"]]);
  expect(stopped.sort()).toEqual(["dev", "lead"]);
  // What is still running is not the project's: the office, the user's terminal and interactive session, the PM-less strangers.
  expect(table.map((q) => q.pid).sort((a, b) => a - b)).toEqual([1, 100, 101, 102, 200, 900]);

  const dir = checkpointDirOf(o.checkpointsDir, p.room);
  expect(readdirSync(dir).sort()).toEqual([`${res.checkpoint}.json`, "latest"]);
  const m = readManifest(dir, res.checkpoint)!;
  expect(latestManifest(dir)?.id).toBe(res.checkpoint);
  expect(m).toMatchObject({ repo: p.repo, why: "lunch", verified: true });
  const dev = m.sessions.find((s) => s.name === "checkout.backend-dev-x")!;
  expect(dev).toMatchObject({ role: "backend-dev", task: "x", sessionId: "dev", cwd: p.wt, row: { id: "T1", status: "doing", branch: "worktree-x" }, snapshot: { ref: "refs/f1rm/checkpoint/x", dirty: true } });
  expect(m.sessions.find((s) => s.name === "lead-checkout")).toMatchObject({ role: "lead", sessionId: "lead" });
  expect(m.killed.map((k) => k.pid)).toEqual([321, 322]);
  expect(git(p.repo, "show", `${dev.snapshot!.sha}:new.txt`)).toBe("untracked");
  expect(git(p.repo, "show", `${dev.snapshot!.sha}:a.txt`)).toBe("one, edited");

  // The worktree is as the dev left it.
  expect(sha(join(p.wt, "a.txt"))).toBe(files.a);
  expect(statSync(join(p.wt, "a.txt")).mtimeMs).toBe(files.mtime);
  expect(git(p.wt, "rev-parse", "HEAD")).toBe(files.head);
  expect(readFileSync(join(git(p.wt, "rev-parse", "--absolute-git-dir"), "index")).toString("hex")).toBe(files.index);

  // The flag names the checkpoint and the hires the stop took, for the resume.
  expect(readPaused(pausedFile(o.pausedDir, p.room))).toMatchObject({ by: "manual", why: "lunch", checkpoint: res.checkpoint, stopped: ["lead-checkout", "checkout.backend-dev-x"] });
});

test("a hire that has no team has its board row on the PM's board, and the manifest finds it there", async () => {
  const p = project();
  world(p);
  const o = start(p);
  writeFileSync(join(o.boardsDir, `${p.repo.replace(/[^A-Za-z0-9]/g, "-")}.md`), "# Board\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| R1 | researcher-x | review | worktree-x | the question |\n");
  await seat(o.server, "dev", "researcher-x", "f1rm:researcher", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(readManifest(checkpointDirOf(o.checkpointsDir, p.room), res.checkpoint)?.sessions[0]).toMatchObject({ name: "researcher-x", row: { id: "R1", status: "review" } });
});

test("a process that survives SIGKILL makes the pause unverified and is named, and the checkpoint is still taken", async () => {
  const p = project();
  world(p);
  stuck = [322];
  const o = start(p);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(res.verified).toBe(false);
  expect(res.remaining.map((q: any) => [q.pid, q.command])).toEqual([[322, "sleep 600"]]);
  expect(res.checkpoint).toMatch(/^cp-/);
  expect(sent.filter(([pid]) => pid === 322).map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
});

test("a hire titled like a hire but running in the user's terminal is neither stopped nor killed", async () => {
  const p = project();
  world(p);
  sessionPids.set("interactive", 102);
  const o = start(p);
  await seat(o.server, "interactive", "checkout.reviewer-review-x", "f1rm:reviewer", p.wt);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(res.stopped).toEqual(["checkout.backend-dev-x"]);
  expect(stopped).toEqual(["dev"]);
  expect(table.some((q) => q.pid === 102)).toBe(true);
});

test("pausing a paused project again does nothing when nothing runs, and stops and checkpoints again, keeping the earlier sessions, when something does", async () => {
  const p = project();
  world(p);
  const o = start(p);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  const first = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  const again = (await (await post(o.server, "pause", { room: p.room })).json()) as any;
  expect(again.rooms).toEqual([]);
  expect(again.results[0]).toMatchObject({ verified: true, checkpoint: first.checkpoint, stopped: [], killed: [] });
  expect(readdirSync(checkpointDirOf(o.checkpointsDir, p.room))).toHaveLength(2); // still one manifest and `latest`

  table.push(proc(950, 1, "node dev-server.js", p.wt)); // something started after the pause
  const third = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(third.killed.map((k: any) => k.pid)).toEqual([950]);
  expect(third.checkpoint).not.toBe(first.checkpoint);
  const m = readManifest(checkpointDirOf(o.checkpointsDir, p.room), third.checkpoint)!;
  expect(m.sessions.map((s) => s.name)).toEqual(["checkout.backend-dev-x"]); // the session stopped by the first pause is still in the newest manifest
  expect(readPaused(pausedFile(o.pausedDir, p.room))?.checkpoint).toBe(third.checkpoint);
});

/** A recovery tick's Claude Code, disk and clock, with `wake` recorded. */
function recoveryDeps() {
  const woke: { name: string; note: string }[] = [];
  const store: Record<string, any> = {};
  return {
    woke,
    recovery: {
      everyMs: 50,
      deps: {
        now: () => Date.now(), sessions: async () => listed.map((a) => ({ ...a })), tail: async () => "", mtime: async () => null, promptOf: async () => null, commitTime: async () => null,
        store: { load: (repo: string) => structuredClone(store[repo] ?? {}), save: (repo: string, e: object) => void (store[repo] = structuredClone(e)) },
        wake: async (_repo: string, name: string, note: string) => {
          woke.push({ name, note });
          listed.push({ id: `new-${name}`, name, kind: "background", state: "working", cwd: listed.find((a) => a.name === name)?.cwd ?? "/", sessionId: `new-${name}`, pid: 9, startedAt: Date.now(), status: "busy" }); // the woken session runs
        },
      },
    },
  };
}

test("a resume wakes every session of the manifest, leads first, each with a note of where it stopped, and reports one whose conversation is gone", async () => {
  const p = project();
  world(p);
  const r = recoveryDeps();
  const o = start(p, { recovery: r.recovery });
  writeFileSync(join(o.boardsDir, `${p.repo.replace(/[^A-Za-z0-9]/g, "-")}.md`), "# Board\n\n| id | owner | status | branch | task |\n| :- | :- | :- | :- | :- |\n| P1 | lead-checkout | doing | | the checkout team |\n");
  sessionPids.set("gone", 330);
  table.push(proc(330, 300, "claude --bg gone", p.wt));
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await seat(o.server, "lead", "lead-checkout", "f1rm:lead", p.repo);
  await seat(o.server, "gone", "checkout.backend-dev-gone", "f1rm:backend-dev", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  // After the stop Claude Code lists the sessions that ended; the third is not among them.
  listed = [
    { id: "lead0001", name: "lead-checkout", kind: "background", state: "stopped", cwd: p.repo, sessionId: "lead" },
    { id: "dev00001", name: "checkout.backend-dev-x", kind: "background", state: "stopped", cwd: p.repo, sessionId: "dev" },
  ];

  const resumed: any = await (await post(o.server, "resume", { room: p.room })).json();
  await settle(400);

  expect(resumed).toMatchObject({ ok: true, waking: 2, lost: [{ name: "checkout.backend-dev-gone" }] });
  expect(resumed.lost[0].why).toContain("conversation");
  expect(r.woke.map((w) => w.name)).toEqual(["lead-checkout", "checkout.backend-dev-x"]);
  const dev = r.woke[1]!.note;
  expect(dev).toContain("resumed after a pause; continue your task");
  expect(dev).toContain(`checkpoint ${res.checkpoint}`);
  expect(dev).toContain("board row T1 (doing, branch worktree-x)");
  expect(dev).toContain("refs/f1rm/checkpoint/x");
  expect(dev).toContain("uncommitted");
  expect(r.woke[0]!.note).toContain(`checkpoint ${res.checkpoint}`);
  expect(r.woke[0]!.note).not.toContain("refs/f1rm");
});

test("an office restarted while a project is paused wakes none of its doing and review rows, and wakes them after the resume", async () => {
  const p = project();
  world(p);
  const home = mkdtempSync(join(root, "home-"));
  const first = start(p, {}, home);
  await seat(first.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  await post(first.server, "pause", { room: p.room });
  first.server.stop(true);
  // The office comes back with the hire's session ended and its row still doing: the very stop the recovery tick wakes.
  listed = [{ id: "dev00001", name: "checkout.backend-dev-x", kind: "background", state: "stopped", cwd: p.repo, sessionId: "dev" }];
  const r = recoveryDeps();
  const again = start(p, { recovery: r.recovery }, home);
  await settle(600); // a dozen recovery ticks
  expect(r.woke).toEqual([]);
  expect(readPaused(pausedFile(again.pausedDir, p.room))).toMatchObject({ by: "manual" });
  await post(again.server, "resume", { room: p.room });
  await settle(400);
  expect(r.woke.map((w) => w.name)).toEqual(["checkout.backend-dev-x"]);
});

test("the Hire dialog's route refuses a hire into a paused project, with a pointer to resume, and hires again after it", async () => {
  const p = project();
  world(p);
  const o = start(p);
  await seat(o.server, "lead", "lead-checkout", "f1rm:lead", p.repo);
  await settle();
  const hire = () => post(o.server, "hire", { room: p.room, role: "lead", task: "search", brief: "plan it" });
  await post(o.server, "pause", { room: p.room, why: "lunch" });
  const refused = await hire();
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error).toMatch(/is paused \(manual: lunch\).*`f1rm resume`/);
  expect(spawned).toBe(0);
  await post(o.server, "resume", { room: p.room });
  const again = await hire();
  expect([again.status, again.status === 200 ? "" : await again.text()]).toEqual([200, ""]);
  expect(spawned).toBe(1);
});

test("a pause that cannot read the process table fails and says so, and never says All N stopped", async () => {
  const p = project();
  world(p);
  const o = start(p);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  procsError = "lsof timed out";
  const r = await post(o.server, "pause", { room: p.room });
  const body: any = await r.json();
  expect(r.status).toBe(500);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("could not check what still runs: lsof timed out");
  expect(body.error).not.toContain("All ");
  expect(stopped).toEqual([]); // the table is read before anything is stopped
  procsError = null;
  expect(((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0]).toMatchObject({ verified: true, stopped: ["checkout.backend-dev-x"] }); // the next pause does the whole stop
});

test("only the hires claude stop really stopped are counted as stopped", async () => {
  const p = project();
  world(p);
  stopFails = ["lead"];
  const o = start(p);
  await seat(o.server, "lead", "lead-checkout", "f1rm:lead", p.repo);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(res.stopped).toEqual(["checkout.backend-dev-x"]);
  expect(res.killed.map((k: any) => k.pid)).toContain(310); // the lead's session outlived the refused stop, so it was killed like the rest
  expect(res.verified).toBe(true);
});

test("a worktree with no commit to save on top of is named as not saved, in the answer and the manifest", async () => {
  const p = project();
  world(p);
  const fresh = join(p.repo, ".claude", "worktrees", "fresh");
  git(p.repo, "worktree", "add", "-q", "--orphan", "-b", "fresh-branch", fresh);
  writeFileSync(join(fresh, "wip.txt"), "unborn\n");
  const o = start(p);
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  const res = ((await (await post(o.server, "pause", { room: p.room })).json()) as any).results[0];
  expect(res.unsaved).toEqual(["fresh"]);
  expect(res.saved.map((s: any) => s.task)).toEqual(["x"]);
  expect(readManifest(checkpointDirOf(o.checkpointsDir, p.room), res.checkpoint)?.unsaved).toEqual(["fresh"]);
  expect(readFileSync(join(fresh, "wip.txt"), "utf8")).toBe("unborn\n");
});

// ── work hours ─────────────────────────────────────────────────────────────
// The schedule runs on the office's own timer and clock: `clockNow` is the fake wall clock, in UTC (Lisbon is UTC+0 from 2026-10-25 to 2027-03-28).
let clockNow = 0;
const utc = (d: string) => Date.parse(`2026-${d}Z`);
const scheduled = (p: ReturnType<typeof project>, from: number, config: WorkHours = DEFAULTS) => {
  clockNow = from;
  const home = mkdtempSync(join(root, "home-"));
  const r = recoveryDeps();
  const o = start(p, { clock: () => clockNow, recovery: r.recovery, workHours: { config: () => config, overridesDir: join(home, "overrides"), everyMs: 30 } }, home);
  return { ...o, r, flag: () => readPaused(pausedFile(o.pausedDir, p.room)), override: () => readOverride(overrideFile(join(home, "overrides"), p.room)) };
};
const stoppedListing = (p: ReturnType<typeof project>) => [
  { id: "dev00001", name: "checkout.backend-dev-x", kind: "background", state: "stopped", cwd: p.repo, sessionId: "dev" },
];

test("at 19:00 the office pauses every registered project by the schedule, with the full stop and a checkpoint; at 09:00 it resumes them", async () => {
  const p = project();
  world(p);
  const o = scheduled(p, utc("10-27T14:00:00"));
  const other = join(root, "other-shop", ".git"); // registered, no session has been in it
  writeFileSync(projectFile(o.projectsDir, other), "{}\n");
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  expect(o.flag()).toBeNull(); // in hours: nothing to do

  clockNow = utc("10-27T19:00:00");
  await settle(300);
  expect(o.flag()).toMatchObject({ by: "schedule", stopped: ["checkout.backend-dev-x"], checkpoint: expect.stringMatching(/^cp-/) });
  expect(stopped).toEqual(["dev"]);
  expect(readPaused(pausedFile(o.pausedDir, other))).toMatchObject({ by: "schedule" });
  expect(readManifest(checkpointDirOf(o.checkpointsDir, p.room), o.flag()!.checkpoint!)?.sessions.map((s) => s.name)).toEqual(["checkout.backend-dev-x"]);
  expect(git(p.wt, "rev-parse", "refs/f1rm/checkpoint/x")).toMatch(/^[0-9a-f]{40}$/);

  listed = stoppedListing(p);
  clockNow = utc("10-28T09:00:00");
  await settle(500);
  expect(o.flag()).toBeNull();
  expect(readPaused(pausedFile(o.pausedDir, other))).toBeNull();
  expect(o.r.woke.map((w) => w.name)).toEqual(["checkout.backend-dev-x"]);
  expect(o.r.woke[0]!.note).toContain("resumed after a pause");
});

test("a project paused by hand stays paused through 19:00 and the next 09:00; a manual resume in hours is just a resume", async () => {
  const p = project();
  world(p);
  const o = scheduled(p, utc("10-27T14:00:00"));
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle();
  await post(o.server, "pause", { room: p.room, why: "lunch" });
  const at = o.flag()!.at;
  for (const t of ["10-27T19:00:00", "10-28T09:00:00", "10-28T12:00:00"]) {
    clockNow = utc(t);
    await settle(200);
    expect(o.flag()).toMatchObject({ by: "manual", at, why: "lunch" });
  }
  await post(o.server, "resume", { room: p.room });
  expect([o.flag(), o.override()]).toEqual([null, null]); // in hours: no override
  clockNow = utc("10-28T19:00:00");
  await settle(300);
  expect(o.flag()).toMatchObject({ by: "schedule" }); // and the schedule pauses it at the evening boundary all the same
});

test("an office that starts out of hours with nothing paused pauses at once; a manual resume then lasts until the next 19:00 and the schedule pauses again", async () => {
  const p = project();
  world(p);
  const o = scheduled(p, utc("10-31T11:00:00")); // Saturday
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle(300);
  expect(o.flag()).toMatchObject({ by: "schedule" });
  listed = stoppedListing(p);

  clockNow = utc("10-31T11:30:00");
  await post(o.server, "resume", { room: p.room });
  expect(o.override()).toEqual({ until: utc("11-02T19:00:00") }); // Monday's 19:00, the weekend skipped
  await settle(300);
  expect(o.flag()).toBeNull(); // the schedule leaves it alone while the override holds
  clockNow = utc("11-02T09:00:00");
  await settle(200);
  expect(o.flag()).toBeNull();
  clockNow = utc("11-02T19:00:00");
  await settle(300);
  expect(o.flag()).toMatchObject({ by: "schedule" });
});

test("a manual pause out of hours stays paused after the override expires, and a schedule that is turned off leaves everything alone", async () => {
  const p = project();
  world(p);
  const o = scheduled(p, utc("10-31T11:00:00"));
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await settle(300);
  clockNow = utc("10-31T11:30:00");
  await post(o.server, "resume", { room: p.room });
  await post(o.server, "pause", { room: p.room, why: "bed" }); // by hand, with the override still live
  clockNow = utc("11-02T19:30:00"); // past the override's expiry
  await settle(300);
  expect(o.flag()).toMatchObject({ by: "manual", why: "bed" });

  const q = project();
  world(q);
  const off = scheduled(q, utc("10-31T11:00:00"), { ...DEFAULTS, enabled: false });
  await settle(300);
  expect(readPaused(pausedFile(off.pausedDir, q.room))).toBeNull();
});

test("--all goes on past a project whose process table cannot be read: the others are paused and checkpointed, the failure is named, and the state is pushed", async () => {
  const p = project();
  const q = project();
  world(p);
  sessionPids.set("dev2", 520);
  table.push(proc(520, 300, "claude --bg dev2", q.wt));
  const both = { ...machine(p.repo), gitCommonDir: (cwd: string) => (cwd.startsWith(p.repo) ? p.room : cwd.startsWith(q.repo) ? q.room : null) };
  const o = start(p, { machine: both });
  writeFileSync(projectFile(o.projectsDir, q.room), "{}\n");
  await seat(o.server, "dev", "checkout.backend-dev-x", "f1rm:backend-dev", p.wt);
  await seat(o.server, "dev2", "checkout.backend-dev-y", "f1rm:backend-dev", q.wt);
  await settle();
  procsFailures = 1; // the first project's table read fails, the second's works
  const r = await post(o.server, "pause", { all: true });
  const body: any = await r.json();
  expect(r.status).toBe(500);
  expect(body.ok).toBe(false);
  expect(body.rooms).toHaveLength(2); // both flags were set
  expect(body.error).toContain("could not check what still runs: lsof timed out");
  expect(body.results).toHaveLength(1);
  expect(body.results[0]).toMatchObject({ verified: true, stopped: ["checkout.backend-dev-y"] }); // the second project went through its whole stop
  expect(readPaused(pausedFile(o.pausedDir, p.room))).toMatchObject({ by: "manual" }); // the first one's flag is set, its hires halt at the next step
  expect(readPaused(pausedFile(o.pausedDir, q.room))).toMatchObject({ by: "manual", checkpoint: body.results[0].checkpoint });
});
