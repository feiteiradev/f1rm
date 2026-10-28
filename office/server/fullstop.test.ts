// Seam: the full stop's process rule and its verified emptiness, with the machine's process table and kill injected.
import { expect, test } from "bun:test";
import { clearProject, claim, procsFrom, type Proc } from "./fullstop.ts";

const REPO = "/code/shop";
const WT = `${REPO}/.claude/worktrees`;
const p = (pid: number, ppid: number, command: string, cwd: string | null): Proc => ({ pid, ppid, command, cwd });

// launchd (1) -> the user's terminal and shell, an interactive claude; the office; two background hires and what they started; a stray from another project.
const table = (): Proc[] => [
  p(1, 0, "/sbin/launchd", "/"),
  p(100, 1, "/Applications/iTerm.app/iTerm2", "/"),
  p(101, 100, "-zsh", REPO),
  p(102, 101, "claude", `${WT}/mine`), // the user's own interactive session sitting in a worktree
  p(103, 102, "sleep 5", `${WT}/mine`), // something the user's session runs: not the project's helpers
  p(200, 1, "bun office/cli/f1rm.ts serve", REPO), // the office
  p(300, 1, "claude daemon", "/"),
  p(310, 300, "claude --bg hire-a", `${WT}/a`), // a hire's session
  p(311, 310, "zsh -c sleep 600", `${WT}/a`),
  p(312, 311, "sleep 600", `${WT}/a`),
  p(313, 310, "node dev-server.js", "/tmp/elsewhere"), // a helper whose cwd is not in the repo
  p(320, 300, "claude --bg hire-b", `${WT}/b`), // another hire
  p(400, 1, "sleep 900", `${WT}/a`), // a strayed process of the project: orphan in a worktree
  p(401, 400, "node child.js", "/tmp/elsewhere"), // its child
  p(402, 1, "sleep 900", "/code/other/.claude/worktrees/x"), // another project's orphan
  p(403, 1, "-zsh", `${WT}/a`), // a login shell, even in a worktree
  p(404, 1, "claude", `${WT}/a`), // an interactive claude that lost its terminal: never ours
];

test("the claim is the hires' process trees plus orphans in the project's worktrees, never the office, a shell, a terminal or another project", () => {
  const got = claim(table(), { roots: [310, 320], worktrees: WT, protect: [200, 102] });
  expect(got.map((c) => c.pid).sort((a, b) => a - b)).toEqual([310, 311, 312, 313, 320, 400, 401]);
  expect(got.find((c) => c.pid === 400)?.why).toBe("orphan");
  expect(got.find((c) => c.pid === 313)?.why).toBe("child");
  expect(got.find((c) => c.pid === 310)?.why).toBe("session");
});

test("a protected process and its ancestors are never claimed, even when a hire's tree runs through them", () => {
  const t = [...table(), p(500, 310, "bun f1rm.ts serve", REPO), p(501, 500, "bun child", REPO)];
  const got = claim(t, { roots: [310], worktrees: WT, protect: [501] });
  expect(got.map((c) => c.pid)).not.toContain(500);
  expect(got.map((c) => c.pid)).not.toContain(501);
  expect(got.map((c) => c.pid)).not.toContain(310); // an ancestor of a protected process: the session that runs the pause itself
});

test("a zombie is not running", () => {
  const t = [...table(), { ...p(314, 310, "sleep 1", `${WT}/a`), zombie: true }];
  expect(claim(t, { roots: [310], worktrees: WT, protect: [] }).map((c) => c.pid)).not.toContain(314);
});

/** A process table that kill() edits; `immune` pids survive SIGTERM, `stuck` survive everything. */
function world(procs: Proc[], { immune = [] as number[], stuck = [] as number[] } = {}) {
  let live = procs;
  const sent: [number, string][] = [];
  return {
    sent,
    stopped: false,
    deps: {
      procs: async () => live,
      kill: (pid: number, sig: "SIGTERM" | "SIGKILL") => {
        sent.push([pid, sig]);
        if (stuck.includes(pid) || (sig === "SIGTERM" && immune.includes(pid))) return;
        live = live.filter((q) => q.pid !== pid);
      },
      sleep: async () => {},
    },
    drop: (pids: number[]) => (live = live.filter((q) => !pids.includes(q.pid))),
  };
}

test("a stop kills the claimed processes, SIGTERM first and SIGKILL for the ones that ignore it, and then finds nothing left", async () => {
  const w = world(table(), { immune: [312] });
  const r = await clearProject({ roots: [310, 320], worktrees: WT, protect: [200, 102], stopSessions: async () => void w.drop([310, 320]), ...w.deps });
  expect(r.remaining).toEqual([]);
  expect(w.sent.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid)).toEqual([312]);
  const gone = r.killed.map((k) => k.pid).sort((a, b) => a - b);
  expect(gone).toEqual([311, 312, 313, 400, 401]); // the sessions went by `claude stop`
  expect(r.killed.find((k) => k.pid === 312)).toMatchObject({ signal: "SIGKILL", command: "sleep 600", cwd: `${WT}/a` });
  const spared = [1, 100, 101, 102, 103, 200, 300, 402, 403, 404];
  expect(w.sent.map(([pid]) => pid).filter((pid) => spared.includes(pid))).toEqual([]);
});

test("a process that survives SIGKILL is reported as still running, so the stop cannot say it is done", async () => {
  const w = world(table(), { stuck: [312] });
  const r = await clearProject({ roots: [310, 320], worktrees: WT, protect: [200, 102], stopSessions: async () => void w.drop([310, 320]), ...w.deps });
  expect(r.remaining.map((q) => q.pid)).toEqual([312]);
});

test("a session that `claude stop` left running is killed too, and one that cannot be killed is reported", async () => {
  const w = world(table(), { stuck: [320] });
  const r = await clearProject({ roots: [310, 320], worktrees: WT, protect: [200, 102], stopSessions: async () => {}, ...w.deps });
  expect(r.killed.map((k) => k.pid)).toContain(310);
  expect(r.remaining.map((q) => q.pid)).toEqual([320]);
});

test("a tmux server started in a worktree hands over none of the user's panes: an orphan whose tree holds a terminal is not claimed, nor anything under it", () => {
  const tty = (q: Proc): Proc => ({ ...q, tty: true });
  const t = [
    ...table(),
    p(600, 1, "tmux -L work new-session -d", `${WT}/a`), // the tmux server: parent launchd, cwd in a worktree, no terminal of its own
    tty(p(601, 600, "-zsh", `${WT}/a`)), // a pane's login shell
    tty(p(602, 601, "claude", "/code/other")), // the user's interactive session in the pane
    tty(p(603, 601, "npm test", "/code/other")), // and what runs in the pane
    p(604, 600, "node watcher.js", `${WT}/a`), // a no-terminal child of the tmux server
  ];
  const got = claim(t, { roots: [310, 320], worktrees: WT, protect: [200] }).map((c) => c.pid);
  for (const pid of [600, 601, 602, 603, 604]) expect(got).not.toContain(pid);
  expect(got).toContain(400); // the plain orphan is still the project's
});

test("an orphan's walk stops at a login shell or a claude, even without a terminal", () => {
  const t = [p(1, 0, "launchd", "/"), p(700, 1, "sleep-wrapper", `${WT}/a`), p(701, 700, "sleep 5", `${WT}/a`), p(702, 700, "-zsh", `${WT}/a`), p(703, 702, "vim notes", "/code/other"), p(704, 700, "claude", "/code/other")];
  const got = claim(t, { roots: [], worktrees: WT, protect: [] }).map((c) => c.pid).sort();
  expect(got).toEqual([700, 701]);
});

test("the real process table parses the terminal of each process, and a ps or lsof that fails or times out is an error, not an empty table", async () => {
  const ok = (out: string) => ({ out, code: 0, timedOut: false });
  const ps = " 10 1 Ss ?? /sbin/launchd\n 11 10 S+ ttys004 -zsh\n 12 10 Z ?? defunct\n";
  const table = await procsFrom(async (argv) => (argv[0] === "ps" ? ok(ps) : ok("p11\nn/code/shop\n")));
  expect(table).toEqual([
    { pid: 10, ppid: 1, command: "/sbin/launchd", cwd: null },
    { pid: 11, ppid: 10, command: "-zsh", cwd: "/code/shop", tty: true },
    { pid: 12, ppid: 10, command: "defunct", cwd: null, zombie: true },
  ]);
  const reason = (run: Parameters<typeof procsFrom>[0]) => procsFrom(run).then(() => "no error", (e) => e.message);
  expect(await reason(async (argv) => (argv[0] === "ps" ? { out: "", code: 1, timedOut: false } : ok("")))).toContain("ps");
  expect(await reason(async (argv) => (argv[0] === "ps" ? ok(ps) : { out: "p11\n", code: null, timedOut: true }))).toContain("lsof");
  expect(await reason(async (argv) => (argv[0] === "ps" ? ok(ps) : { out: "", code: 1, timedOut: false }))).toContain("lsof");
});

test("a child that moved its cwd out of the worktrees and lost its parent is still found by the tree seen before the stop", async () => {
  const w = world(table());
  // The stop reparents 313 (cwd /tmp/elsewhere) to launchd: only the tree read before the stop still knows it was the hire's.
  const r = await clearProject({ roots: [310], worktrees: WT, protect: [200], stopSessions: async () => void w.drop([310, 311]), ...w.deps });
  expect(r.killed.map((k) => k.pid)).toContain(313);
  expect(r.remaining).toEqual([]);
});
