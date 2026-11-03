// The daily docker sweep: once per 24 h, per registered repo, removes tagged orphans only. Fake docker, fixed clock, temp dirs.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoId, type Docker } from "../docker.ts";
import { due, liveTasksOf, sweepTick } from "./dockersweep.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => (made.push(realpathSync(mkdtempSync(join(tmpdir(), "f1rm-sweep-")))), made.at(-1)!);
const DAY = 24 * 3600_000;

type Res = { kind: "c" | "n" | "v"; id: string; labels: Record<string, string> };
function fakeDocker(res: Res[], down = false) {
  const calls: string[][] = [];
  const d: Docker = async (args) => {
    calls.push(args);
    if (down) return { code: 1, out: "Cannot connect" };
    if (args.includes("rm")) {
      for (const id of args.slice(args.indexOf("--") + 1)) { const i = res.findIndex((r) => r.id === id); if (i >= 0) res.splice(i, 1); }
      return { code: 0, out: "" };
    }
    const kind = args[0] === "network" ? "n" : args[0] === "volume" ? "v" : "c";
    const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a.replace(/^label=/, "")] : []));
    const rows = res.filter((r) => r.kind === kind && filters.every((f) => { const [k, v] = f.split(/=(.*)/s); return v === undefined ? k in r.labels : r.labels[k] === v; }));
    return { code: 0, out: rows.map((r) => [r.id, r.id, "", "", r.labels["com.docker.compose.project"] ?? "", r.labels["f1rm.task"] ?? "", r.labels["f1rm.repo"] ?? ""].join("\t")).join("\n") };
  };
  return { d, calls };
}
const tag = (kind: Res["kind"], id: string, repo: string, task: string): Res => ({ kind, id, labels: { "f1rm.repo": repo, "f1rm.task": task } });
const ids = (res: Res[]) => res.map((r) => r.id).sort();
/** A real repo folder called `name` under a fresh temp dir, and its repoId. */
const repoDir = (name: string) => { const p = join(tmp(), name); mkdirSync(p); return { p, id: repoId(p) }; };

test("sweepTick runs once, not again within 24 h, and again after", async () => {
  const state = join(tmp(), "docker-sweep.json");
  const shop = repoDir("shop");
  const res = [tag("c", "c1", shop.id, "gone")];
  const f = fakeDocker(res);
  const live = () => new Set<string>();
  const t0 = 1_000_000_000;
  const a = await sweepTick([shop.p], live, f.d, t0, state);
  expect(a).toEqual(["docker sweep shop: removed 1 containers, 0 networks, 0 volumes"]);
  expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ repos: { [shop.p]: t0 } });
  res.push(tag("c", "c2", shop.id, "gone2"));
  expect(await sweepTick([shop.p], live, f.d, t0 + DAY - 1, state)).toEqual([]);
  expect(ids(res)).toEqual(["c2"]);
  expect((await sweepTick([shop.p], live, f.d, t0 + DAY, state)).length).toBe(1);
  expect(ids(res)).toEqual([]);
});

test("due: a lastRun in the future counts as 0, so the sweep runs", () => {
  const state = join(tmp(), "s.json");
  writeFileSync(state, JSON.stringify({ lastRun: 50 * DAY }));
  expect(due(state, 10 * DAY, "r")).toBe(true);
  expect(due(state, 50 * DAY + 1, "r")).toBe(false);
  expect(due(join(tmp(), "none.json"), 10 * DAY, "r")).toBe(true);
});

test("sweepTick removes only orphans of each registered repo: live tasks, other repos and untagged resources stay", async () => {
  const state = join(tmp(), "s.json");
  const shop = repoDir("shop");
  const blog = repoDir("blog");
  const res: Res[] = [
    tag("c", "orphan", shop.id, "gone"), tag("v", "orphanvol", shop.id, "gone"),
    tag("c", "live", shop.id, "running"), tag("c", "other", blog.id, "gone"), tag("c", "foreign", "elsewhere-abc123", "gone"),
    { kind: "c", id: "untagged", labels: {} }, { kind: "v", id: "untaggedvol", labels: { "com.docker.compose.project": "mydb" } },
  ];
  const f = fakeDocker(res);
  const seen: string[] = [];
  await sweepTick([shop.p, blog.p], async (repo) => (seen.push(repo), new Set(repo === shop.p ? ["running"] : [])), f.d, 10 * DAY, state);
  expect(seen).toEqual([shop.p, blog.p]);
  expect(ids(res)).toEqual(["foreign", "live", "untagged", "untaggedvol"]);
  expect(f.calls.some((c) => c.includes("prune") || c[0] === "rmi")).toBe(false);
});

test("two repos with the same folder name: sweeping one never removes the other's resources", async () => {
  const a = repoDir("app");
  const b = repoDir("app");
  expect(a.id).not.toBe(b.id);
  const res = [tag("c", "a-orphan", a.id, "gone"), tag("c", "b-live", b.id, "work")];
  await sweepTick([a.p], () => new Set(), fakeDocker(res).d, 10 * DAY, join(tmp(), "s.json"));
  expect(ids(res)).toEqual(["b-live"]);
});

test("a registered repo whose folder is gone is skipped", async () => {
  const f = fakeDocker([]);
  expect(await sweepTick([join(tmp(), "vanished")], () => new Set(), f.d, 10 * DAY, join(tmp(), "s.json"))).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("a docker failure does not throw, and an unreachable docker does not use up the day", async () => {
  const state = join(tmp(), "s.json");
  const shop = repoDir("shop");
  expect(await sweepTick([shop.p], () => new Set(), fakeDocker([], true).d, 10 * DAY, state)).toEqual([]);
  expect(() => readFileSync(state)).toThrow(); // retried on the next tick
  const boom: Docker = async () => { throw new Error("spawn"); };
  expect(await sweepTick([shop.p], () => new Set(), boom, 10 * DAY, state)).toEqual([]);
  const bad = async () => { throw new Error("listing failed"); };
  expect(await sweepTick([shop.p], bad, fakeDocker([]).d, 10 * DAY, state)).toEqual([]);
});

test("liveTasksOf: every worktree folder (a symlinked one too) plus every task a session of the repo names", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".claude", "worktrees", "has-tree"), { recursive: true });
  symlinkSync(tmp(), join(repo, ".claude", "worktrees", "linked"));
  const sessions = [
    { name: "backend-dev-starting", cwd: repo },
    { name: "backend-dev-other", cwd: "/elsewhere/.claude/worktrees/other" },
    { name: "frontend-dev-intree", cwd: join(repo, ".claude", "worktrees", "intree") },
    { name: "pm", cwd: repo },
  ];
  expect([...liveTasksOf(repo, sessions)].sort()).toEqual(["has-tree", "intree", "linked", "starting"]);
});

test("a repo that failed is tried on the next tick while the one that worked waits its 24 h; the old {lastRun} file still counts for every repo", async () => {
  const state = join(tmp(), "s.json");
  const shop = repoDir("shop"), blog = repoDir("blog");
  const res = [tag("c", "s1", shop.id, "gone"), tag("c", "b1", blog.id, "gone")];
  const f = fakeDocker(res);
  const failShop: Docker = async (args) => (args.some((a) => a.includes(`f1rm.repo=${shop.id}`)) ? { code: 1, out: "boom" } : f.d(args));
  const t0 = 10 * DAY;
  await sweepTick([shop.p, blog.p], () => new Set(), failShop, t0, state);
  expect(ids(res)).toEqual(["s1"]);
  res.push(tag("c", "b2", blog.id, "gone2"));
  await sweepTick([shop.p, blog.p], () => new Set(), f.d, t0 + 1000, state);
  expect(ids(res)).toEqual(["b2"]); // shop swept again, blog waits
  expect(due(state, t0 + 1000, shop.p)).toBe(false);
  expect(due(state, t0 + 1000, blog.p)).toBe(false);
  const old = join(tmp(), "old.json");
  writeFileSync(old, JSON.stringify({ lastRun: t0 }));
  expect([due(old, t0 + 1000, shop.p), due(old, t0 + DAY, shop.p)]).toEqual([false, true]);
});

test("repoId is the same for a repo reached through a symlink by another name", () => {
  const real = join(tmp(), "shop");
  mkdirSync(real);
  const link = join(tmp(), "alias");
  symlinkSync(real, link);
  expect(repoId(link)).toBe(repoId(real));
  expect(repoId(link).startsWith("shop-")).toBe(true);
});

test("liveTasksOf: a repo reached through a symlink still matches the sessions that name its real path", () => {
  const real = tmp();
  const link = join(tmp(), "link");
  symlinkSync(real, link);
  const sessions = [{ name: "backend-dev-a", cwd: join(real, ".claude", "worktrees", "a") }, { name: "frontend-dev-b", cwd: real }];
  expect([...liveTasksOf(link, sessions)].sort()).toEqual(["a", "b"]);
});
