import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-lock.ts");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-lock-")));
  made.push(dir);
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

const lockOf = (dir: string) => join(realpathSync(dir), git(dir, "rev-parse", "--git-common-dir"), "f1rm-check.lock");

/** Runs the lock script around `cmd` in `cwd`; the poll and the wait are short so a test does not idle. */
function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", SCRIPT, ...cmd], { cwd, env: { ...process.env, F1RM_CHECK_POLL_MS: "50", F1RM_CHECK_LOCKED: "", ...env }, stdout: "pipe", stderr: "pipe" });
  const done = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([code, out, err]) => ({ code, out: out + err }));
  return { proc, done };
}

const sh = (script: string) => ["sh", "-c", script];
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25);
  expect(ok()).toBe(true);
}

test("the exit code of the real check is the exit code of the lock, and the lock is released after it", async () => {
  const dir = repo();
  expect((await run(dir, sh("exit 0")).done).code).toBe(0);
  expect((await run(dir, sh("exit 3")).done).code).toBe(3);
  expect(existsSync(lockOf(dir))).toBe(false);
}, 15_000);

test("a second caller in the same repo waits, says who holds the lock and since when, then runs after the first has finished", async () => {
  const dir = repo();
  const log = join(dir, "log");
  const a = run(dir, sh(`echo A-start >> ${log}; sleep 1; echo A-end >> ${log}`));
  await until(() => lines(log).includes("A-start"));
  const b = run(dir, sh(`echo B-start >> ${log}`));
  const [ra, rb] = await Promise.all([a.done, b.done]);
  expect([ra.code, rb.code]).toEqual([0, 0]);
  expect(lines(log)).toEqual(["A-start", "A-end", "B-start"]);
  expect(rb.out).toContain("waiting");
  expect(rb.out).toContain(`pid ${a.proc.pid}`);
  expect(rb.out).toMatch(/since \d{2}:\d{2}:\d{2}/);
  expect(rb.out).toContain(dir.split("/").at(-1)!);
  expect(ra.out).not.toContain("waiting");
}, 15_000);

test("every worktree of a repo shares one lock, and another repo has its own", async () => {
  const dir = repo();
  const tree = join(dir, "..", `${dir.split("/").at(-1)}-tree`);
  git(dir, "worktree", "add", "-q", "--detach", tree);
  made.push(tree);
  const other = repo();
  const log = join(dir, "log");
  const a = run(dir, sh(`echo A-start >> ${log}; sleep 1; echo A-end >> ${log}`));
  await until(() => lines(log).includes("A-start"));
  const elsewhere = await run(other, sh(`echo other >> ${log}`)).done;
  expect(elsewhere.out).not.toContain("waiting");
  expect(lines(log)).toEqual(["A-start", "other"]);
  const b = await run(tree, sh(`echo B-start >> ${log}`)).done;
  await a.done;
  expect(b.out).toContain("waiting");
  expect(lines(log)).toEqual(["A-start", "other", "A-end", "B-start"]);
}, 15_000);

test("a lock whose holder process is gone is taken over", async () => {
  const dir = repo();
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(lockOf(dir), JSON.stringify({ pid: dead, since: Date.now() - 60_000, cwd: "/gone", commit: "abc1234" }));
  const log = join(dir, "log");
  const r = await run(dir, sh(`echo ran >> ${log}`)).done;
  expect(r.code).toBe(0);
  expect(lines(log)).toEqual(["ran"]);
  expect(r.out).toContain("taking it over");
  expect(existsSync(lockOf(dir))).toBe(false);
}, 15_000);

test("a lock held by a live process makes the caller give up after the wait, without running the check", async () => {
  const dir = repo();
  writeFileSync(lockOf(dir), JSON.stringify({ pid: process.pid, since: Date.now(), cwd: dir, commit: "abc1234" }));
  const log = join(dir, "log");
  const r = await run(dir, sh(`echo ran >> ${log}`), { F1RM_CHECK_WAIT_MS: "300" }).done;
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("gave up");
  expect(lines(log)).toEqual([]);
  expect(existsSync(lockOf(dir))).toBe(true); // not ours: left alone
}, 15_000);

test("Ctrl-C stops the check and releases the lock", async () => {
  const dir = repo();
  const pids = join(dir, "pids");
  const a = run(dir, sh(`echo $$ >> ${pids}; exec sleep 30`));
  await until(() => lines(pids).length === 1);
  a.proc.kill("SIGINT");
  const r = await a.done;
  expect(r.code).toBe(130);
  expect(existsSync(lockOf(dir))).toBe(false);
  const child = Number(lines(pids)[0]);
  await until(() => {
    try {
      process.kill(child, 0);
      return false;
    } catch {
      return true;
    }
  });
}, 15_000);

test("bun run check goes through the lock and the suite itself is the unlocked script it wraps", () => {
  const { scripts } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(scripts.check).toBe("bun scripts/check-lock.ts bun run suite");
  expect(scripts.suite).toBe("bun test && bun run typecheck && bun run build");
});

test("a command started by a caller that already holds the lock (F1RM_CHECK_LOCKED) runs at once and neither takes nor waits for the lock", async () => {
  const dir = repo();
  writeFileSync(lockOf(dir), JSON.stringify({ pid: process.pid, since: Date.now(), cwd: dir, commit: "abc1234" }));
  const log = join(dir, "log");
  const r = await run(dir, sh(`echo ran >> ${log}; exit 4`), { F1RM_CHECK_LOCKED: "1", F1RM_CHECK_WAIT_MS: "300" }).done;
  expect(r.code).toBe(4);
  expect(r.out).not.toContain("waiting");
  expect(lines(log)).toEqual(["ran"]);
  expect(existsSync(lockOf(dir))).toBe(true); // the holder's, left alone
}, 15_000);

test("the command a lock holder runs sees F1RM_CHECK_LOCKED, so a check script that is this script again does not wait for it", async () => {
  const dir = repo();
  const r = await run(dir, sh(`bun ${SCRIPT} sh -c 'echo inner-ran'`), { F1RM_CHECK_WAIT_MS: "300" }).done;
  expect(r.code).toBe(0);
  expect(r.out).toContain("inner-ran");
  expect(r.out).not.toContain("waiting");
}, 15_000);
