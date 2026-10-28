// Seam: `f1rm pause` and `f1rm resume`. The command against an injected office, and the real CLI against a stand-in office on a temp HOME.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseCall, USAGE, type PauseDeps } from "./pause.ts";

const made: string[] = [];
const tmp = (prefix: string) => (made.push(realpathSync(mkdtempSync(join(tmpdir(), prefix)))), made[made.length - 1]);
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** An office that records the posts it gets and answers `reply`. */
function office(reply: { status?: number; body?: object } = {}, room: string | null = "/code/shop/.git") {
  const posts: [string, object][] = [];
  const deps: PauseDeps = {
    room: () => room,
    post: async (verb, body) => (posts.push([verb, body]), { status: reply.status ?? 200, body: { ok: true, rooms: ["shop"], waking: 0, ...reply.body } }),
  };
  return { posts, deps };
}

test("pause asks the office to pause the project of the folder, with the reason the words give", async () => {
  const o = office();
  expect(await pauseCall("pause", [], o.deps)).toContain("paused shop");
  expect(await pauseCall("pause", ["going", "to", "lunch"], o.deps)).toContain("paused shop");
  expect(o.posts).toEqual([["pause", { room: "/code/shop/.git" }], ["pause", { room: "/code/shop/.git", why: "going to lunch" }]]);
  expect(await pauseCall("pause", [], office({ body: { rooms: [] } }).deps)).toBe("this project is already paused");
});

test("--all asks for every project and sends no folder, so it works anywhere", async () => {
  const o = office({ body: { rooms: ["shop", "blog"] } }, null);
  expect(await pauseCall("pause", ["--all"], o.deps)).toContain("paused shop, blog");
  expect(await pauseCall("resume", ["--all"], o.deps)).toContain("resumed shop, blog");
  expect(o.posts).toEqual([["pause", { all: true }], ["resume", { all: true }]]);
});

test("resume says how many stopped hires it is waking, and that a project that was not paused is not", async () => {
  expect(await pauseCall("resume", [], office({ body: { waking: 3 } }).deps)).toContain("continuing 3 hires one at a time");
  expect(await pauseCall("resume", [], office({ body: { waking: 1 } }).deps)).toContain("continuing 1 hire one at a time");
  expect(await pauseCall("resume", [], office().deps)).toBe("resumed shop");
  expect(await pauseCall("resume", [], office({ body: { rooms: [] } }).deps)).toBe("this project is not paused");
});

test("a usage mistake, a folder outside git and an office that refuses are errors that reach nothing or say why", async () => {
  const o = office();
  for (const [verb, words] of [["resume", ["why"]], ["pause", ["--bogus"]], ["resume", ["-x"]]] as const) expect(await pauseCall(verb, [...words], o.deps).catch((e) => e.message)).toBe(USAGE);
  expect(await pauseCall("pause", [], office({}, null).deps).catch((e) => e.message)).toBe("not in a git repo");
  expect(await pauseCall("pause", [], office({ status: 404, body: { ok: false, error: "No such project." } }).deps).catch((e) => e.message)).toBe("No such project.");
  expect(o.posts).toEqual([]);
});

test("the real command posts to the running office's pause route with the folder's project, and prints what the office says", async () => {
  const home = tmp("f1rm-pause-home-");
  const repo = tmp("f1rm-pause-repo-");
  Bun.spawnSync(["git", "init", "-q", repo]);
  const seen: { path: string; body: any }[] = [];
  const stand = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") return new Response("ok"); // the check that the office is up
      seen.push({ path, body: await req.json() });
      return Response.json({ ok: true, rooms: ["thing"], waking: 2 });
    },
  });
  try {
    mkdirSync(join(home, ".f1rm"));
    writeFileSync(join(home, ".f1rm", "office-url"), `http://127.0.0.1:${stand.port}/tok/`);
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "f1rm.ts"), ...args], { cwd: repo, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
      return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
    };
    const paused = await run("pause", "lunch");
    expect([paused.code, paused.out]).toEqual([0, expect.stringContaining("paused thing")]);
    const resumed = await run("resume");
    expect([resumed.code, resumed.out]).toEqual([0, expect.stringContaining("continuing 2 hires")]);
    expect(seen).toEqual([
      { path: "/tok/pause", body: { room: join(repo, ".git"), why: "lunch" } },
      { path: "/tok/resume", body: { room: join(repo, ".git") } },
    ]);
  } finally {
    stand.stop(true);
  }
  const down = Bun.spawnSync(["bun", join(import.meta.dir, "f1rm.ts"), "pause"], { cwd: repo, env: { ...process.env, HOME: tmp("f1rm-pause-home-") } });
  expect([down.exitCode, down.stderr.toString()]).toEqual([1, expect.stringContaining("the office isn't running")]);
});

const result = (extra: object = {}) => ({ room: "shop", stopped: ["lead-checkout", "checkout.backend-dev-x"], killed: [{ pid: 322, command: "sleep 600", cwd: "/code/shop/.claude/worktrees/x", signal: "SIGTERM" }], remaining: [], checkpoint: "cp-20261028-153012", verified: true, saved: [{ task: "x", ref: "refs/f1rm/checkpoint/x", sha: "abc1234def", dirty: true }], ...extra });

test("pause says All N stopped only once the office has checked that nothing of the project runs, and names what it killed and the checkpoint", async () => {
  const out = await pauseCall("pause", [], office({ body: { results: [result()] } }).deps);
  expect(out).toContain("paused shop");
  expect(out).toContain("All 3 stopped (2 sessions, 1 background process)");
  expect(out).toContain("nothing of the project still runs");
  expect(out).toContain("killed pid 322 `sleep 600`");
  expect(out).toContain("checkpoint cp-20261028-153012");
  expect(out).toContain("refs/f1rm/checkpoint/x");
});

test("a pause that cannot verify fails, names what still runs and says not to close", async () => {
  const bad = result({ verified: false, remaining: [{ pid: 322, command: "sleep 600", cwd: "/code/shop/.claude/worktrees/x" }] });
  const message = await pauseCall("pause", [], office({ body: { results: [bad] } }).deps).catch((e) => e.message);
  expect(message).toContain("shop is NOT stopped");
  expect(message).toContain("pid 322 `sleep 600`");
  expect(message).toContain("cp-20261028-153012");
  expect(message).not.toContain("All ");
  expect(message).toContain("f1rm pause");
});

test("a pause set already, with nothing running, says so and quotes the checkpoint it has", async () => {
  const quiet = result({ stopped: [], killed: [], saved: [] });
  expect(await pauseCall("pause", [], office({ body: { rooms: [], results: [quiet] } }).deps)).toBe("this project is already paused; nothing of it runs (checkpoint cp-20261028-153012)");
});
