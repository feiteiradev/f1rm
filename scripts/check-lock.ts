// One suite per repo at a time: `bun scripts/check-lock.ts <command...>` takes a lock in the repo's git common
// dir (so every worktree shares it), runs the command with its exit code passed through, and releases on exit.
// A second caller waits and says who holds the lock; a lock whose holder process is gone is taken over.
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

type Holder = { pid: number; since: number; cwd: string; commit: string };

const POLL_MS = Number(process.env.F1RM_CHECK_POLL_MS) || 2000;
const WAIT_MS = Number(process.env.F1RM_CHECK_WAIT_MS) || 20 * 60_000;
const NOTE_MS = 60_000;

const say = (s: string) => console.error(`check: ${s}`);
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const who = (h: Holder) => `${basename(h.cwd)} (pid ${h.pid}, ${h.cwd}${h.commit ? `, commit ${h.commit}` : ""}) since ${new Date(h.since).toLocaleTimeString("en-GB")}`;

const command = process.argv.slice(2);
if (!command.length) {
  say("usage: bun scripts/check-lock.ts <command...>");
  process.exit(2);
}

// The command runs with F1RM_CHECK_LOCKED set: `f1rm merge` holds the lock around the repo's whole check, which is this script again, and the inner call must not wait for its own caller.
if (process.env.F1RM_CHECK_LOCKED) process.exit((await Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] }).exited) ?? 1);

const common = git("rev-parse", "--git-common-dir");
if (!common) {
  say("not a git repo, so there is no lock: running the check unlocked.");
  process.exit((await Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] }).exited) ?? 1);
}
const LOCK = resolve(common, "f1rm-check.lock");
const me: Holder = { pid: process.pid, since: Date.now(), cwd: process.cwd(), commit: git("rev-parse", "--short", "HEAD") };

const read = () => {
  try {
    return readFileSync(LOCK, "utf8");
  } catch {
    return null;
  }
};
const release = () => {
  try {
    if (JSON.parse(read() ?? "").pid === me.pid) unlinkSync(LOCK);
  } catch {} // not ours, gone, or half-written by someone else
};

/** Takes the lock and returns null, or returns the live holder. A stale lock is removed and the take retried at once. */
function take(): Holder | { text: string } | null {
  for (;;) {
    try {
      writeFileSync(LOCK, JSON.stringify(me), { flag: "wx" });
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const text = read();
    if (text === null) continue; // released between our write and our read
    let holder: Holder | null = null;
    try {
      holder = JSON.parse(text);
    } catch {} // half-written by a taker, or garbage
    // shortcut: a pid reused by an unrelated process keeps a stale lock alive; upgrade to storing the process start time
    if (holder ? alive(holder.pid) : Date.now() - statSync(LOCK).mtimeMs < 10_000) return holder ?? { text };
    say(`the holder${holder ? ` (pid ${holder.pid}, ${basename(holder.cwd)})` : ""} is gone; taking it over.`);
    if (read() === text) unlinkSync(LOCK); // re-read: do not remove a lock another taker has just written
  }
}

let signal = 0;
let child: ReturnType<typeof Bun.spawn> | null = null;
for (const [name, n] of [["SIGINT", 2], ["SIGHUP", 1], ["SIGTERM", 15]] as const) {
  process.on(name, () => {
    signal = 128 + n;
    if (child) child.kill(name);
    else process.exit(signal);
  });
}
process.on("exit", release);

const started = Date.now();
let noted = 0;
let lastHolder = "";
for (let held = take(); held; held = take()) {
  if (Date.now() - started >= WAIT_MS) {
    say(`gave up waiting for the lock after ${Math.round(WAIT_MS / 60_000)} min${"pid" in held ? `, held by ${who(held)}` : ""}.`);
    process.exit(1);
  }
  const text = "pid" in held ? who(held) : "a caller that has not written its name yet";
  if (text !== lastHolder || Date.now() - noted >= NOTE_MS) {
    say(`waiting: another suite of this repo is running, held by ${text}. One suite per repo at a time; I start when it ends.`);
    lastHolder = text;
    noted = Date.now();
  }
  await Bun.sleep(POLL_MS);
}

child = Bun.spawn(command, { env: { ...process.env, F1RM_CHECK_LOCKED: "1" }, stdio: ["inherit", "inherit", "inherit"] });
const code = await child.exited;
process.exit(signal || code);
