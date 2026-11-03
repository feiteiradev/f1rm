// The snapshot's `usage` and `leftovers`, and the two leftovers routes. In-process office, a temp home, a fake docker: never the real docker or ~/.f1rm.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { machine } from "./machine.ts";
import type { OfficeState } from "./office.ts";
import type { Docker } from "../docker.ts";

const TOKEN = "ui-token";
const NOW = 1_800_000_000; // seconds
let now = NOW * 1000;
let server: ReturnType<typeof startServer>;
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  server?.stop(true);
  now = NOW * 1000;
});

const clientDir = mkdtempSync(join(tmpdir(), "f1rm-gauges-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>f1rm</title>");
const home = () => mkdtempSync(join(tmpdir(), "f1rm-gauges-"));

const fakeMachine = { sessions: async () => [], backgroundId: async () => null, workingHires: async () => 0 } as unknown as typeof machine;
function start(extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  server = startServer({ port: 0, secret: "s", token: TOKEN, machine: fakeMachine, clientDir, clock: () => now, ...extra });
  return server;
}
const base = () => `http://127.0.0.1:${server.port}`;
const post = (path: string, body?: object) =>
  fetch(`${base()}/${TOKEN}/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base() }, body: JSON.stringify(body ?? {}) });

function office(until: (s: OfficeState & { usage?: any; leftovers?: any }) => boolean, timeout = 1500) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base() } } as any);
  sockets.push(ws);
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no matching state within " + timeout + "ms")), timeout);
    ws.onmessage = (m) => {
      const s = JSON.parse(String(m.data));
      if (until(s)) (clearTimeout(timer), resolve(s));
    };
  });
}

const usageAt = (h: string, u: object) => {
  const file = join(h, "usage.json");
  writeFileSync(file, JSON.stringify({ readAt: NOW, ...u }));
  return file;
};

test("usage is null with no usage file, and without one configured", async () => {
  start({ usageFile: join(home(), "usage.json") });
  expect((await office((s) => "usage" in s)).usage).toBeNull();
  server.stop(true);
  start();
  expect((await office((s) => "usage" in s)).usage).toBeNull();
});

test("usage at 51% and 62% carries both windows, no warning, no hold, no pace limit", async () => {
  const file = usageAt(home(), { fiveHour: { usedPct: 51, resetsAt: NOW + 3600 }, sevenDay: { usedPct: 62, resetsAt: NOW + 2 * 86400 } });
  start({ usageFile: file });
  const { usage } = await office((s) => !!s.usage);
  expect(usage).toMatchObject({ fiveHour: { usedPct: 51, resetsAt: NOW + 3600 }, sevenDay: { usedPct: 62 }, readAt: NOW, warn: { fiveHour: false, sevenDay: false }, hold: null, oneTeam: false });
});

test("usage at 91% five-hour holds until its reset, and warns", async () => {
  const file = usageAt(home(), { fiveHour: { usedPct: 91, resetsAt: NOW + 7200 }, sevenDay: { usedPct: 10, resetsAt: NOW + 5 * 86400 } });
  start({ usageFile: file });
  const { usage } = await office((s) => !!s.usage);
  expect(usage.warn).toEqual({ fiveHour: true, sevenDay: false });
  expect(usage.hold.until).toBe(NOW + 7200);
  expect(usage.hold.reason).toContain("5-hour usage is 91%");
});

test("a weekly reading above the elapsed share of its window is ahead of pace: one team", async () => {
  // 3 of 7 days gone (43%); 62% used is ahead
  const file = usageAt(home(), { sevenDay: { usedPct: 62, resetsAt: NOW + 4 * 86400 } });
  start({ usageFile: file });
  const { usage } = await office((s) => !!s.usage);
  expect(usage.oneTeam).toBe(true);
  expect(usage.fiveHour).toBeUndefined();
});

test("a window past its reset is dropped from the snapshot, and the file is re-read when the snapshot is rebuilt", async () => {
  const h = home();
  const file = usageAt(h, { fiveHour: { usedPct: 51, resetsAt: NOW + 3600 } });
  start({ usageFile: file });
  expect((await office((s) => !!s.usage)).usage.fiveHour.usedPct).toBe(51);
  now += 7200 * 1000; // the window has reset
  expect((await office((s) => "usage" in s)).usage).toBeNull();
});

// ---- leftovers ----
type Box = { id: string; name: string; state: string; tagged?: boolean };
function fakeDocker(boxes: Box[], opts: { down?: boolean; failRm?: string[] } = {}) {
  const calls: string[][] = [];
  const docker: Docker = async (args) => {
    calls.push(args);
    if (opts.down) return { code: 1, out: "Cannot connect to the Docker daemon" };
    if (args[0] === "ps") return { code: 0, out: boxes.map((b) => [b.id, b.name, b.state, "img", "", b.tagged ? "t" : "", b.tagged ? "r" : ""].join("\t")).join("\n") };
    if (args[0] === "rm") {
      const id = args[args.length - 1]!;
      if (opts.failRm?.includes(id)) return { code: 1, out: "device busy" };
      const at = boxes.findIndex((b) => b.id === id);
      if (at >= 0) boxes.splice(at, 1);
      return { code: 0, out: id };
    }
    return { code: 0, out: "" };
  };
  return { docker, calls, psCalls: () => calls.filter((c) => c[0] === "ps").length, rmIds: () => calls.filter((c) => c[0] === "rm").map((c) => c[c.length - 1]) };
}
const boxes = (): Box[] => [
  ...Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, name: `tideline-e2e-${i.toString(16).padStart(6, "a")}`, state: "running" })),
  { id: "q1", name: "quillbase-e2e-1d7e90", state: "exited" },
  { id: "q2", name: "quillbase-e2e-52ac08", state: "exited" },
  { id: "r1", name: "review-marlow-77", state: "exited" },
  { id: "keep", name: "web", state: "running" },
  { id: "mine", name: "shop-e2e-1", state: "running", tagged: true },
];
const leftoversOf = (h: string) => join(h, "leftovers.json");

test("the snapshot lists untagged leftovers by group, running groups first; tagged and other containers never count", async () => {
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: leftoversOf(home()) });
  const { leftovers } = await office((s) => !!s.leftovers);
  expect(leftovers).toMatchObject({ count: 14, running: 11, exited: 3 });
  expect(leftovers.groups.map((g: any) => [g.prefix, g.running, g.exited])).toEqual([["tideline-e2e-*", 11, 0], ["quillbase-e2e-*", 0, 2], ["review-marlow-*", 0, 1]]);
  expect(leftovers.groups[1].names).toEqual(["quillbase-e2e-1d7e90", "quillbase-e2e-52ac08"]);
  expect(leftovers.groups[0].names).toHaveLength(8); // the card shows 8 and "and N more"
});

test("leftovers are computed at most once a minute", async () => {
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: leftoversOf(home()) });
  await office((s) => !!s.leftovers);
  await office((s) => !!s.leftovers);
  await office((s) => !!s.leftovers);
  expect(d.psCalls()).toBe(1);
  now += 61_000;
  await office((s) => !!s.leftovers);
  await Bun.sleep(30);
  expect(d.psCalls()).toBe(2);
});

test("docker down, or no leftovers, is null: no card", async () => {
  const down = fakeDocker(boxes(), { down: true });
  start({ docker: down.docker, leftoversFile: leftoversOf(home()) });
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
  await Bun.sleep(30);
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
  server.stop(true);
  const none = fakeDocker([{ id: "w", name: "web", state: "running" }]);
  start({ docker: none.docker, leftoversFile: leftoversOf(home()) });
  await office((s) => "leftovers" in s);
  await Bun.sleep(30);
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
});

test("remove acts on the fresh list only: a client's ids are ignored (an untagged web or an f1rm container is never named), and no image or volume is touched", async () => {
  const list = boxes();
  const d = fakeDocker(list);
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  const res = await post("leftovers/remove", { ids: ["keep", "mine", "web"], fingerprint: f });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, removed: 14 });
  expect(d.rmIds().sort()).toEqual(["q1", "q2", "r1", ...Array.from({ length: 11 }, (_, i) => `t${i}`)].sort());
  expect(d.calls.flat().some((a) => ["prune", "image", "volume", "network"].includes(a))).toBe(false);
  expect(JSON.parse(readFileSync(leftoversOf(h), "utf8"))).toMatchObject({ answered: "removed" });
});

test("after Remove the card is gone and never listed again, even after the cache expires and docker is asked no more", async () => {
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: leftoversOf(home()) });
  await post("leftovers/remove", { fingerprint: await fp() });
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
  const asked = d.psCalls();
  now += 120_000;
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
  await Bun.sleep(30);
  expect(d.psCalls()).toBe(asked);
});

test("Keep writes answered=kept, removes nothing, and the card never returns, not even in a new office on the same file", async () => {
  const d = fakeDocker(boxes());
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  await office((s) => !!s.leftovers);
  const res = await post("leftovers/keep");
  expect(res.status).toBe(200);
  expect(d.rmIds()).toEqual([]);
  expect(JSON.parse(readFileSync(leftoversOf(h), "utf8")).answered).toBe("kept");
  expect((await office((s) => "leftovers" in s)).leftovers).toBeNull();
  server.stop(true);
  const again = fakeDocker(boxes());
  start({ docker: again.docker, leftoversFile: leftoversOf(h) });
  await office((s) => "leftovers" in s);
  await Bun.sleep(30);
  expect(again.psCalls()).toBe(0);
});

test("a failed removal keeps the card (not answered) and says how many could not go", async () => {
  const d = fakeDocker(boxes(), { failRm: ["q2", "r1"] });
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const res = await post("leftovers/remove", { fingerprint: await fp() });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error).toContain("Removed 12 of 14. 2 could not be removed");
  expect(existsSync(leftoversOf(h))).toBe(false);
});

test("the leftovers routes take POST only and need the office link", async () => {
  start({ docker: fakeDocker(boxes()).docker, leftoversFile: leftoversOf(home()) });
  expect((await fetch(`${base()}/${TOKEN}/leftovers/remove`, { headers: { origin: base() } })).status).toBe(405);
  expect((await fetch(`${base()}/wrong/leftovers/remove`, { method: "POST", headers: { origin: base() } })).status).toBe(401);
});

// ---- the fix pass: one answer, consent for the list shown ----
const fp = async () => (await office((s) => !!s.leftovers)).leftovers.fingerprint as string;

test("Remove after Keep deletes nothing and says it was already answered; Keep stays kept", async () => {
  const d = fakeDocker(boxes());
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  await post("leftovers/keep");
  const res = await post("leftovers/remove", { fingerprint: f });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("Already answered.");
  expect(d.rmIds()).toEqual([]);
  expect(JSON.parse(readFileSync(leftoversOf(h), "utf8")).answered).toBe("kept");
});

test("Keep after Remove does not overwrite it", async () => {
  const d = fakeDocker(boxes());
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  expect((await post("leftovers/remove", { fingerprint: f })).status).toBe(200);
  const res = await post("leftovers/keep");
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("Already answered.");
  expect(JSON.parse(readFileSync(leftoversOf(h), "utf8")).answered).toBe("removed");
});

test("two Removes at once delete once, and a Keep that arrives mid-removal does not overwrite it", async () => {
  const d = fakeDocker(boxes());
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  const [a, b, k] = await Promise.all([post("leftovers/remove", { fingerprint: f }), post("leftovers/remove", { fingerprint: f }), post("leftovers/keep")]);
  expect([a.status, b.status, k.status].sort()).toEqual([200, 409, 409]);
  expect(d.rmIds()).toHaveLength(14); // each container once
  expect(JSON.parse(readFileSync(leftoversOf(h), "utf8")).answered).toBe("removed");
});

test("the snapshot carries a fingerprint of the list (a hash of the sorted ids, not the ids)", async () => {
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: leftoversOf(home()) });
  const f = await fp();
  expect(f).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify((await office((s) => !!s.leftovers)).leftovers)).not.toContain('"t3"');
});

test("Remove for a list that changed is refused with 409 and nothing is deleted; the new list comes with the next push", async () => {
  const list = boxes();
  const d = fakeDocker(list);
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  list.push({ id: "new1", name: "marlow-e2e-new", state: "running" }); // a container appeared after the card was shown
  const res = await post("leftovers/remove", { fingerprint: f });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("The list changed, review it again.");
  expect(d.rmIds()).toEqual([]);
  expect(existsSync(leftoversOf(h))).toBe(false);
  const fresh = await office((s) => s.leftovers?.count === 15);
  expect(fresh.leftovers.fingerprint).not.toBe(f);
});

test("Remove with no fingerprint is refused too", async () => {
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: leftoversOf(home()) });
  await fp();
  expect((await post("leftovers/remove")).status).toBe(409);
  expect(d.rmIds()).toEqual([]);
});

test("a fingerprint that is not a string, or an empty fresh list, is refused 409 and never settles removed", async () => {
  const list = boxes();
  const d = fakeDocker(list);
  const h = home();
  start({ docker: d.docker, leftoversFile: leftoversOf(h) });
  const f = await fp();
  for (const body of [{}, { fingerprint: 123 }, { fingerprint: null }, { fingerprint: ["x"] }]) expect((await post("leftovers/remove", body)).status).toBe(409);
  list.length = 0; // everything is gone by the time the click lands
  for (const body of [{}, { fingerprint: f }]) expect((await post("leftovers/remove", body)).status).toBe(409);
  expect(d.rmIds()).toEqual([]);
  expect(existsSync(leftoversOf(h))).toBe(false);
});

test("a removal whose own re-listing fails, or removes nothing, is a failure: 502, the card stays, not settled", async () => {
  const d = fakeDocker(boxes());
  let lists = 0;
  const flaky: Docker = async (args) => (args[0] === "ps" && ++lists > 2 ? { code: 1, out: "daemon went away" } : d.docker(args)); // snapshot list and the route's list work, removeLeftovers' own re-list fails
  const h = home();
  start({ docker: flaky, leftoversFile: leftoversOf(h) });
  const f = await fp();
  const res = await post("leftovers/remove", { fingerprint: f });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("daemon went away");
  expect(d.rmIds()).toEqual([]);
  expect(existsSync(leftoversOf(h))).toBe(false);
});

test("an answer that cannot be saved still answers: Remove says so, Keep is 200", async () => {
  const h = home();
  const blocker = join(h, "file");
  writeFileSync(blocker, "x");
  const d = fakeDocker(boxes());
  start({ docker: d.docker, leftoversFile: join(blocker, "leftovers.json") }); // the parent is a file: no write can succeed
  const f = await fp();
  const res = await post("leftovers/remove", { fingerprint: f });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, removed: 14 });
  expect(body.note).toContain("not saved");
  server.stop(true);
  start({ docker: fakeDocker(boxes()).docker, leftoversFile: join(blocker, "leftovers.json") });
  await fp();
  expect((await post("leftovers/keep")).status).toBe(200);
});

test("the card lists at most 20 groups and says how many more there are", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `g${i}`, name: `proj${String.fromCharCode(97 + i)}-e2e-1`, state: "running" }));
  start({ docker: fakeDocker(many).docker, leftoversFile: leftoversOf(home()) });
  const { leftovers } = await office((s) => !!s.leftovers);
  expect(leftovers.groups).toHaveLength(20);
  expect(leftovers.moreGroups).toBe(5);
  expect(leftovers.count).toBe(25);
});
