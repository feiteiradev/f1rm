// Docker tagging: a task's containers, networks and volumes are found by label and removed; nothing untagged is touched. Fake docker only.
import { expect, test } from "bun:test";
import { leftovers, removeLeftovers, stackName, sweep, tagEnv, tagLabels, teardown, type Docker } from "./docker";

type Res = { kind: "container" | "network" | "volume"; id: string; name: string; state?: string; image?: string; labels: Record<string, string> };

/** A fake docker holding resources; records every call. List calls apply the --filter label=k[=v] flags (AND). */
function fake(res: Res[], opts: { down?: boolean } = {}) {
  const calls: string[][] = [];
  const d: Docker = async (args) => {
    calls.push(args);
    if (opts.down) return { code: 1, out: "Cannot connect to the Docker daemon" };
    const kind = args[0] === "ps" ? "container" : args[0] === "network" ? "network" : args[0] === "volume" ? "volume" : "container";
    if (args.includes("rm")) {
      const ids = args.slice(args.indexOf("rm") + 1).filter((a) => !a.startsWith("-"));
      for (const id of ids) { const i = res.findIndex((r) => r.id === id); if (i >= 0) res.splice(i, 1); }
      return { code: 0, out: ids.join("\n") };
    }
    const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a.replace(/^label=/, "")] : []));
    const rows = res.filter((r) => r.kind === kind && filters.every((f) => { const [k, v] = f.split(/=(.*)/s); return v === undefined ? k in r.labels : r.labels[k] === v; }));
    const L = (r: Res, k: string) => r.labels[k] ?? "";
    return { code: 0, out: rows.map((r) => [r.id, r.name, r.state ?? "", r.image ?? "", L(r, "com.docker.compose.project"), L(r, "f1rm.task")].join("\t")).join("\n") };
  };
  return { d, calls, res };
}
const tagged = (kind: Res["kind"], id: string, repo: string, task: string, extra: Partial<Res> = {}): Res =>
  ({ kind, id, name: id, labels: { "f1rm.repo": repo, "f1rm.task": task }, ...extra });
const ids = (res: Res[]) => res.map((r) => r.id).sort();

test("stackName is lowercased and compose-safe; tagEnv and tagLabels carry the tag", () => {
  expect(stackName("F1rm", "Fix Login!")).toBe("f1rm-f1rm-fix-login-");
  expect(tagLabels("f1rm", "t1")).toEqual(["f1rm.repo=f1rm", "f1rm.task=t1"]);
  const env = tagEnv("f1rm", "t1");
  expect(env.COMPOSE_PROJECT_NAME).toBe("f1rm-f1rm-t1");
  expect(env.F1RM_DOCKER_LABELS).toContain("f1rm.task=t1");
});

test("teardown removes containers (with -v), networks and volumes of that task only", async () => {
  const f = fake([
    tagged("container", "c1", "f1rm", "t1"), tagged("network", "n1", "f1rm", "t1"), tagged("volume", "v1", "f1rm", "t1"),
    tagged("container", "c2", "f1rm", "t2"), tagged("volume", "v2", "other", "t1"),
    { kind: "container", id: "c3", name: "f1rm-f1rm-t1-db", labels: {} }, // untagged, name only
    { kind: "container", id: "c4", name: "x", labels: { "com.docker.compose.project": "f1rm-f1rm-t1" } }, // compose project of the task
  ]);
  const r = await teardown(f.d, "f1rm", "t1");
  expect(ids(f.res)).toEqual(["c2", "c3", "v2"]);
  expect(r.containers.sort()).toEqual(["c1", "c4"]);
  expect(r.networks).toEqual(["n1"]);
  expect(r.volumes).toEqual(["v1"]);
  expect(f.calls.some((a) => a.join(" ").startsWith("rm -f -v"))).toBe(true);
  const order = f.calls.filter((a) => a.includes("rm")).map((a) => a[0] === "rm" ? "container" : a[0]);
  expect(order).toEqual(["container", "network", "volume"]);
});

test("sweep removes this repo's orphans only", async () => {
  const f = fake([
    tagged("container", "live", "f1rm", "t1"), tagged("container", "gone", "f1rm", "t9"), tagged("volume", "vgone", "f1rm", "t9"),
    tagged("network", "ngone", "f1rm", "t8"), tagged("container", "alien", "other", "t9"),
    { kind: "container", id: "plain", name: "postgres", labels: {} },
  ]);
  const r = await sweep(f.d, "f1rm", new Set(["t1"]));
  expect(ids(f.res)).toEqual(["alien", "live", "plain"]);
  expect(r.containers).toEqual(["gone"]);
  expect(r.networks).toEqual(["ngone"]);
  expect(r.volumes).toEqual(["vgone"]);
});

const old = () => [
  { kind: "container", id: "e1", name: "app-e2e-3", state: "running", image: "app", labels: { "com.docker.compose.project": "app" } },
  { kind: "container", id: "r1", name: "review-12", state: "exited", image: "rev", labels: {} },
  { kind: "container", id: "pg", name: "postgres", state: "running", image: "postgres", labels: {} },
  { kind: "container", id: "tg", name: "foo-e2e-1", state: "running", image: "x", labels: { "f1rm.task": "t1", "f1rm.repo": "f1rm" } },
] as Res[];

test("leftovers lists untagged -e2e- and review- containers, not postgres or a tagged one", async () => {
  const r = await leftovers(fake(old()).d);
  expect(r.count).toBe(2);
  expect(r.items).toEqual([
    { id: "e1", name: "app-e2e-3", state: "running", image: "app", project: "app" },
    { id: "r1", name: "review-12", state: "exited", image: "rev", project: "" },
  ]);
});

test("removeLeftovers refuses an id not in the fresh list or one that became tagged", async () => {
  const res = old();
  const f = fake(res);
  res.find((r) => r.id === "r1")!.labels["f1rm.task"] = "t2"; // tagged since the list was shown
  const r = await removeLeftovers(f.d, ["e1", "r1", "pg", "nope"]);
  expect(r.removed).toEqual(["e1"]);
  expect(ids(f.res)).toEqual(["pg", "r1", "tg"]);
  expect(f.calls.some((a) => a.join(" ") === "rm -f -v e1")).toBe(true);
});

test("docker down gives a result, not a throw", async () => {
  const f = fake([], { down: true });
  const t = await teardown(f.d, "f1rm", "t1");
  expect(t.errors.length).toBeGreaterThan(0);
  expect((await sweep(f.d, "f1rm", new Set())).errors.length).toBeGreaterThan(0);
  expect((await leftovers(f.d)).count).toBe(0);
  expect((await removeLeftovers(f.d, ["a"])).removed).toEqual([]);
  const thrower: Docker = async () => { throw new Error("boom"); };
  expect((await teardown(thrower, "f1rm", "t1")).errors.length).toBeGreaterThan(0);
});

test("no call ever uses image or prune", async () => {
  const f = fake([...old(), tagged("container", "c1", "f1rm", "t1")]);
  await teardown(f.d, "f1rm", "t1"); await sweep(f.d, "f1rm", new Set()); await removeLeftovers(f.d, ["e1"]);
  expect(f.calls.length).toBeGreaterThan(0);
  for (const a of f.calls) { expect(a).not.toContain("image"); expect(a).not.toContain("prune"); expect(a).not.toContain("rmi"); }
});
