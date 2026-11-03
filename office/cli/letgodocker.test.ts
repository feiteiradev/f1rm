// letgo tears down the task's tagged Docker stack when it removes the worktree. Fake docker, real temp git repo.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoId, type Docker } from "../docker.ts";
import { machine } from "../server/machine.ts";
import { letgo } from "./letgo.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => (made.push(realpathSync(mkdtempSync(join(tmpdir(), "f1rm-ldk-")))), made.at(-1)!);
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const wt = (repo: string, task: string) => join(repo, ".claude", "worktrees", task);
function repoWith(...tasks: string[]) {
  return repoNamed(tmp(), ...tasks);
}
function repoNamed(repo: string, ...tasks: string[]) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "start");
  for (const t of tasks) git(repo, "worktree", "add", "-b", `worktree-${t}`, wt(repo, t));
  return repo;
}

/** A fake docker holding one tagged container, network and volume for `task` of `repo` (or nothing, or down); records every call. */
function fakeDocker(repo: string, task: string, mode: "stack" | "empty" | "down" = "stack") {
  const calls: string[][] = [];
  const d: Docker = async (args) => {
    calls.push(args);
    if (mode === "down") return { code: 1, out: "Cannot connect to the Docker daemon" };
    if (args.includes("rm")) return { code: 0, out: "" };
    const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : []));
    const mine = mode === "stack" && filters.includes(`label=f1rm.repo=${repo}`) && filters.includes(`label=f1rm.task=${task}`);
    const kind = args[0] === "network" ? "net1" : args[0] === "volume" ? "vol1" : "c1";
    return { code: 0, out: mine ? [kind, kind, "", "", "", task, repo].join("\t") : "" };
  };
  return { d, calls };
}

function fakeClaude(sessions: { id: string; name: string; cwd: string }[], docker: Docker) {
  const live = sessions.map((s) => ({ kind: "background", state: "done", ...s }));
  return {
    docker,
    sessions: async () => live.slice(),
    letGo: async (id: string, o?: { afterStop?: () => void | Promise<void> }) => {
      await o?.afterStop?.();
      live.splice(live.findIndex((s) => s.id === id), 1);
    },
    gitCommonDir: machine.gitCommonDir,
    removeWorktree: machine.removeWorktree,
  };
}
const TORE = "tore down 1 containers, 1 networks, 1 volumes";

test("letgo of a merged task tears its stack down with the repo's basename and the task, and says so", async () => {
  const repo = repoWith("done");
  const f = fakeDocker(repoId(repo), "done");
  const r = await letgo(["backend-dev-done"], fakeClaude([{ id: "a1", name: "backend-dev-done", cwd: wt(repo, "done") }], f.d), repo);
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual([`backend-dev-done: let go, removed its worktree and branch worktree-done, ${TORE}`]);
  expect(f.calls.some((c) => c.includes(`label=f1rm.task=done`))).toBe(true);
  expect(f.calls.some((c) => c[0] === "rm" && c.includes("c1"))).toBe(true);
});

test("letgo of a dropped task (unmerged, archived) tears its stack down too", async () => {
  const repo = repoWith("drop");
  writeFileSync(join(wt(repo, "drop"), "a.txt"), "a\n");
  const f = fakeDocker(repoId(repo), "drop");
  const r = await letgo(["backend-dev-drop"], fakeClaude([{ id: "d1", name: "backend-dev-drop", cwd: wt(repo, "drop") }], f.d), repo);
  expect(r.lines[0]).toBe(`backend-dev-drop: let go, archived its work as refs/f1rm/archive/drop (1 file), removed its worktree and branch worktree-drop, ${TORE}`);
  expect(f.calls.length).toBeGreaterThan(0);
});

test("a docker that is down does not fail letgo or add to its line; a task with no tagged resources adds nothing", async () => {
  const repo = repoWith("down", "bare");
  const down = fakeDocker(repoId(repo), "down", "down");
  const a = await letgo(["backend-dev-down"], fakeClaude([{ id: "x1", name: "backend-dev-down", cwd: wt(repo, "down") }], down.d), repo);
  expect(a.ok).toBe(true);
  expect(a.lines).toEqual(["backend-dev-down: let go, removed its worktree and branch worktree-down"]);
  expect(down.calls.length).toBeGreaterThan(0);
  const none = fakeDocker(repoId(repo), "bare", "empty");
  const b = await letgo(["backend-dev-bare"], fakeClaude([{ id: "x2", name: "backend-dev-bare", cwd: wt(repo, "bare") }], none.d), repo);
  expect(b.lines).toEqual(["backend-dev-bare: let go, removed its worktree and branch worktree-bare"]);
  expect(none.calls.some((c) => c.includes("rm"))).toBe(false);
});

test("a docker that throws does not fail letgo", async () => {
  const repo = repoWith("boom");
  const boom: Docker = async () => { throw new Error("spawn failed"); };
  const r = await letgo(["backend-dev-boom"], fakeClaude([{ id: "b1", name: "backend-dev-boom", cwd: wt(repo, "boom") }], boom), repo);
  expect(r.ok).toBe(true);
  expect(existsSync(wt(repo, "boom"))).toBe(false);
});

test("letgo --leftovers tears down each removed task's stack, and still removes the worktree when docker is down", async () => {
  const repo = repoWith("old", "gone");
  const f = fakeDocker(repoId(repo), "old");
  const r = await letgo(["--leftovers"], fakeClaude([], f.d), repo, tmp());
  expect(r.lines).toEqual([`gone: removed its worktree and branch worktree-gone`, `old: removed its worktree and branch worktree-old, ${TORE}`]);
  const repo2 = repoWith("old2");
  const down = fakeDocker(repoId(repo2), "old2", "down");
  const r2 = await letgo(["--leftovers"], fakeClaude([], down.d), repo2, tmp());
  expect(r2.ok).toBe(true);
  expect(r2.lines).toEqual([`old2: removed its worktree and branch worktree-old2`]);
  expect(existsSync(wt(repo2, "old2"))).toBe(false);
});

test("two repos with the same folder name: letgo in one never touches the other's resources", async () => {
  const a = repoNamed(join(tmp(), "app"), "t");
  const b = repoNamed(join(tmp(), "app"), "t");
  expect(repoId(a)).not.toBe(repoId(b));
  const stacks = [{ id: "ca", repo: repoId(a) }, { id: "cb", repo: repoId(b) }];
  const d: Docker = async (args) => {
    if (args.includes("rm")) {
      for (const id of args.slice(args.indexOf("--") + 1)) stacks.splice(stacks.findIndex((s) => s.id === id), 1);
      return { code: 0, out: "" };
    }
    const filters = args.flatMap((x, i) => (args[i - 1] === "--filter" ? [x] : []));
    const rows = args[0] === "ps" ? stacks.filter((s) => filters.includes(`label=f1rm.repo=${s.repo}`) && filters.includes("label=f1rm.task=t")) : [];
    return { code: 0, out: rows.map((s) => [s.id, s.id, "", "", "", "t", s.repo].join("\t")).join("\n") };
  };
  await letgo(["backend-dev-t"], fakeClaude([{ id: "p1", name: "backend-dev-t", cwd: wt(a, "t") }], d), a);
  expect(stacks.map((s) => s.id)).toEqual(["cb"]);
});

test("letgo --leftovers skips a task name that is empty or holds a slash", async () => {
  const repo = repoWith("ok");
  git(repo, "branch", "worktree-");
  git(repo, "branch", "worktree-a/b");
  const f = fakeDocker(repoId(repo), "ok", "empty");
  const r = await letgo(["--leftovers"], fakeClaude([], f.d), repo, tmp());
  expect(r.lines).toEqual([`ok: removed its worktree and branch worktree-ok`]);
});
