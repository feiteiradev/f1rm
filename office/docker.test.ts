// Docker tagging: a task's containers, networks and volumes are found by label and removed; nothing untagged is touched. Fake docker only.
import { expect, test } from "bun:test";
import { leftovers, removeLeftovers, stackName, sweep, tagEnv, tagLabels, teardown, type Docker } from "./docker";

type Res = { kind: "container" | "network" | "volume"; id: string; name: string; state?: string; image?: string; labels: Record<string, string> };

/** A fake docker holding resources; records every call and every id it listed. List calls apply the --filter label=k[=v] flags (AND). */
function fake(res: Res[], opts: { down?: boolean } = {}) {
  const calls: string[][] = [];
  const listed = new Set<string>();
  const d: Docker = async (args) => {
    calls.push(args);
    if (opts.down) return { code: 1, out: "Cannot connect to the Docker daemon" };
    const kind = args[0] === "network" ? "network" : args[0] === "volume" ? "volume" : "container";
    if (args.includes("rm")) {
      const ids = args.slice(args.indexOf("--") + 1);
      for (const id of ids) { const i = res.findIndex((r) => r.id === id); if (i >= 0) res.splice(i, 1); }
      return { code: 0, out: ids.join("\n") };
    }
    const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a.replace(/^label=/, "")] : []));
    const rows = res.filter((r) => r.kind === kind && filters.every((f) => { const [k, v] = f.split(/=(.*)/s); return v === undefined ? k in r.labels : r.labels[k] === v; }));
    const L = (r: Res, k: string) => r.labels[k] ?? "";
    rows.forEach((r) => listed.add(r.id));
    return { code: 0, out: rows.map((r) => [r.id, r.name, r.state ?? "", r.image ?? "", L(r, "com.docker.compose.project"), L(r, "f1rm.task"), L(r, "f1rm.repo")].join("\t")).join("\n") };
  };
  return { d, calls, res, listed };
}
const tagged = (kind: Res["kind"], id: string, repo: string, task: string, extra: Partial<Res> = {}): Res =>
  ({ kind, id, name: id, labels: { "f1rm.repo": repo, "f1rm.task": task }, ...extra });
const inStack = (kind: Res["kind"], id: string, repo: string, task: string): Res =>
  ({ kind, id, name: id, labels: { "com.docker.compose.project": stackName(repo, task) } });
const ids = (res: Res[]) => res.map((r) => r.id).sort();

test("stackName is compose-safe, carries the hash, and tagEnv/tagLabels carry the tag", () => {
  expect(stackName("F1rm", "Fix Login!")).toMatch(/^f1rm-f1rm-fix-login--[0-9a-f]{8}$/);
  expect(tagLabels("f1rm", "t1")).toEqual(["f1rm.repo=f1rm", "f1rm.task=t1"]);
  expect(tagEnv("f1rm", "t1")).toEqual({ COMPOSE_PROJECT_NAME: stackName("f1rm", "t1") });
});

test("stackName is injective on the colliding pairs", () => {
  const pairs: [[string, string], [string, string]][] = [
    [["a", "b-c"], ["a-b", "c"]], [["f1rm", "Fix Login!"], ["f1rm", "fix login?"]], [["f1rm", "a"], ["f1rm", "ab"]], [["f1rm", "t1"], ["f1rm", "t10"]],
  ];
  for (const [x, y] of pairs) expect(stackName(...x)).not.toBe(stackName(...y));
});

test("teardown removes containers (with -v), networks and volumes of that task only", async () => {
  const f = fake([
    tagged("container", "c1", "f1rm", "t1"), tagged("network", "n1", "f1rm", "t1"), tagged("volume", "v1", "f1rm", "t1"),
    tagged("container", "c2", "f1rm", "t2"), tagged("volume", "v2", "other", "t1"),
    { kind: "container", id: "c3", name: stackName("f1rm", "t1") + "-db", labels: {} }, // untagged, name only
    inStack("container", "c4", "f1rm", "t1"), // compose project of the task
    { kind: "container", id: "c5", name: "x", labels: { "com.docker.compose.project": stackName("f1rm", "t1"), "f1rm.repo": "other" } }, // label says another repo
  ]);
  const r = await teardown(f.d, "f1rm", "t1");
  expect(ids(f.res)).toEqual(["c2", "c3", "c5", "v2"]);
  expect(r.containers.sort()).toEqual(["c1", "c4"]);
  expect(r.networks).toEqual(["n1"]);
  expect(r.volumes).toEqual(["v1"]);
  expect(f.calls.some((a) => a.join(" ").startsWith("rm -f -v -- "))).toBe(true);
  const order = f.calls.filter((a) => a.includes("rm")).map((a) => (a[0] === "rm" ? "container" : a[0]));
  expect(order).toEqual(["container", "network", "volume"]);
});

test("teardown and sweep never confuse colliding names", async () => {
  const f = fake([inStack("container", "x1", "a-b", "c"), inStack("container", "x2", "a", "b-c"), inStack("container", "y1", "f1rm", "t1"), inStack("container", "y2", "f1rm", "t10")]);
  await teardown(f.d, "a", "b-c");
  expect(ids(f.res)).toEqual(["x1", "y1", "y2"]);
  await sweep(f.d, "a", new Set());
  expect(ids(f.res)).toEqual(["x1", "y1", "y2"]); // x1 belongs to repo a-b, not a
  await sweep(f.d, "f1rm", new Set(["t1"]));
  expect(ids(f.res)).toEqual(["x1", "y1"]); // t10 is an orphan, t1 is live
});

test("empty repo or task throws", async () => {
  const f = fake([]);
  await expect(teardown(f.d, "", "t")).rejects.toThrow();
  await expect(teardown(f.d, "r", "")).rejects.toThrow();
  await expect(sweep(f.d, "", new Set())).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("sweep removes this repo's orphans only", async () => {
  const f = fake([
    tagged("container", "live", "f1rm", "t1"), tagged("container", "gone", "f1rm", "t9"), tagged("volume", "vgone", "f1rm", "t9"),
    tagged("network", "ngone", "f1rm", "t8"), tagged("container", "alien", "other", "t9"),
    { kind: "container", id: "plain", name: "postgres", labels: {} },
    inStack("container", "stack-live", "f1rm", "t1"), inStack("container", "stack-gone", "f1rm", "t9"),
  ]);
  const r = await sweep(f.d, "f1rm", new Set(["t1"]));
  expect(ids(f.res)).toEqual(["alien", "live", "plain", "stack-live"]);
  expect(r.containers.sort()).toEqual(["gone", "stack-gone"]);
  expect(r.networks).toEqual(["ngone"]);
  expect(r.volumes).toEqual(["vgone"]);
});

const old = () => [
  { kind: "container", id: "e1", name: "app-e2e-3", state: "running", image: "app", labels: { "com.docker.compose.project": "app" } },
  { kind: "container", id: "r1", name: "review-12", state: "exited", image: "rev", labels: {} },
  { kind: "container", id: "pg", name: "postgres", state: "running", image: "postgres", labels: {} },
  { kind: "container", id: "tg", name: "foo-e2e-1", state: "running", image: "x", labels: { "f1rm.task": "t1", "f1rm.repo": "f1rm" } },
  { kind: "container", id: "sg", name: "svc-e2e-1", state: "running", image: "x", labels: { "com.docker.compose.project": stackName("f1rm", "t1") } }, // live stack, no f1rm labels
  { kind: "container", id: "rl", name: "review-9", state: "running", image: "x", labels: { "f1rm.repo": "f1rm" } }, // repo label only
] as Res[];

test("leftovers lists untagged -e2e- and review- containers, not postgres, a tagged one or an f1rm stack", async () => {
  const r = await leftovers(fake(old()).d);
  expect(r.count).toBe(2);
  expect(r.errors).toEqual([]);
  expect(r.items).toEqual([
    { id: "e1", name: "app-e2e-3", state: "running", image: "app", project: "app" },
    { id: "r1", name: "review-12", state: "exited", image: "rev", project: "" },
  ]);
});

test("removeLeftovers refuses an id not in the fresh list, one that became tagged, and a name", async () => {
  const res = old();
  const f = fake(res);
  res.find((r) => r.id === "r1")!.labels["f1rm.task"] = "t2"; // tagged since the list was shown
  const r = await removeLeftovers(f.d, ["e1", "r1", "pg", "nope", "app-e2e-3"]);
  expect(r.removed).toEqual(["e1"]);
  expect(ids(f.res)).toEqual(["pg", "r1", "rl", "sg", "tg"]);
  expect(f.calls.some((a) => a.join(" ") === "rm -f -v -- e1")).toBe(true);
  const g = fake(old());
  expect((await removeLeftovers(g.d, ["review-12"])).removed).toEqual([]);
});

test("docker down gives a result, not a throw", async () => {
  const f = fake([], { down: true });
  const t = await teardown(f.d, "f1rm", "t1");
  expect(t.errors.length).toBeGreaterThan(0);
  expect((await sweep(f.d, "f1rm", new Set())).errors.length).toBeGreaterThan(0);
  const l = await leftovers(f.d);
  expect(l.count).toBe(0);
  expect(l.errors.length).toBeGreaterThan(0);
  expect((await removeLeftovers(f.d, ["a"])).removed).toEqual([]);
  const thrower: Docker = async () => { throw new Error("boom"); };
  expect((await teardown(thrower, "f1rm", "t1")).errors.length).toBeGreaterThan(0);
});

test("every call is ps, network, volume or rm, and every rm target was listed first", async () => {
  const f = fake([...old(), tagged("container", "c1", "f1rm", "t1"), tagged("volume", "v1", "f1rm", "t1"), inStack("network", "n1", "f1rm", "t1")]);
  await teardown(f.d, "f1rm", "t1"); await sweep(f.d, "f1rm", new Set()); await removeLeftovers(f.d, ["e1"]);
  expect(f.calls.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const a of f.calls) {
    expect(["ps", "network", "volume", "rm"]).toContain(a[0]!);
    if (a[0] === "network" || a[0] === "volume") expect(["ls", "rm"]).toContain(a[1]!);
    expect(a).not.toContain("image"); expect(a).not.toContain("prune"); expect(a).not.toContain("rmi");
    if (a.includes("rm")) { expect(a).toContain("--"); for (const id of a.slice(a.indexOf("--") + 1)) expect(f.listed.has(id)).toBe(true); }
    else seen.add(a[0]!);
  }
});
