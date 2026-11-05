// Seam: usage.ts (the statusLine reading on disk, the pacing rules) and `f1rm usage-tap` spawned with a temp HOME and stdin.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pacing, readUsage, recordUsage, usageFile, warn, withUsageTap } from "./usage.ts";

const NOW = 1_793_700_000;
const tmp = () => mkdtempSync(join(tmpdir(), "f1rm-usage-"));
const input = (five?: [number, number], seven?: [number, number]) =>
  JSON.stringify({
    rate_limits: {
      ...(five && { five_hour: { used_percentage: five[0], resets_at: five[1] } }),
      ...(seven && { seven_day: { used_percentage: seven[0], resets_at: seven[1] } }),
    },
  });
const file = () => usageFile(tmp());
const stored = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("usageFile is <home>/.f1rm/usage.json", () => {
  expect(usageFile("/h")).toBe("/h/.f1rm/usage.json");
});

test("recordUsage writes both windows and readUsage returns them with readAt", () => {
  const f = file();
  recordUsage(input([51, NOW + 1000], [62, NOW + 5000]), f, NOW);
  expect(readUsage(f, NOW + 1)).toEqual({ fiveHour: { usedPct: 51, resetsAt: NOW + 1000 }, sevenDay: { usedPct: 62, resetsAt: NOW + 5000 }, readAt: NOW });
});

test("a new input without a window keeps that window from the file; a present window replaces it", () => {
  const f = file();
  recordUsage(input([51, NOW + 1000], [62, NOW + 5000]), f, NOW);
  recordUsage(input([60, NOW + 1000]), f, NOW + 10);
  expect(readUsage(f, NOW + 11)).toEqual({ fiveHour: { usedPct: 60, resetsAt: NOW + 1000 }, sevenDay: { usedPct: 62, resetsAt: NOW + 5000 }, readAt: NOW + 10 });
});

test("a window whose resetsAt is not after now is dropped on write and on read", () => {
  const f = file();
  recordUsage(input([51, NOW], [62, NOW + 5000]), f, NOW);
  expect(stored(f).fiveHour).toBeUndefined();
  recordUsage(input([70, NOW + 100]), f, NOW);
  expect(readUsage(f, NOW + 100)).toEqual({ sevenDay: { usedPct: 62, resetsAt: NOW + 5000 }, readAt: NOW });
  expect(readUsage(f, NOW + 5000)?.sevenDay).toBeUndefined();
});

test("garbage in changes nothing and never throws; a missing, corrupt or empty file reads as null", () => {
  const f = file();
  for (const bad of ["", "not json", "null", "[]", "{}", '{"rate_limits":null}', '{"rate_limits":{"five_hour":{"used_percentage":"x","resets_at":1}}}']) recordUsage(bad, f, NOW);
  expect(existsSync(f)).toBe(false);
  expect(readUsage(f, NOW)).toBeNull();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, "{broken");
  expect(readUsage(f, NOW)).toBeNull();
  writeFileSync(f, "{}");
  expect(readUsage(f, NOW)).toBeNull();
});

test("the file is private (0600) and no temp file is left behind", () => {
  const f = file();
  recordUsage(input([51, NOW + 1000]), f, NOW);
  recordUsage(input([52, NOW + 1000]), f, NOW);
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(f, ".."))).toEqual(["usage.json"]);
});

const u = (five?: number, seven?: number, sevenReset = NOW + 3.5 * 86400) => ({
  ...(five !== undefined && { fiveHour: { usedPct: five, resetsAt: NOW + 3600 } }),
  ...(seven !== undefined && { sevenDay: { usedPct: seven, resetsAt: sevenReset } }),
  readAt: NOW,
});

test("pacing holds from 90% on the 5-hour window and 95% on the 7-day window, until that window resets", () => {
  expect(pacing(u(89, 94), NOW).hold).toBeNull();
  expect(pacing(u(90), NOW).hold).toEqual({ until: NOW + 3600, reason: expect.stringContaining("5-hour usage is 90%") });
  const h = pacing(u(10, 95), NOW).hold;
  expect(h).toEqual({ until: NOW + 3.5 * 86400, reason: expect.stringContaining("7-day usage is 95%") });
});

test("pacing holds until the later reset when both windows are over", () => {
  expect(pacing(u(99, 99), NOW).hold?.until).toBe(NOW + 3.5 * 86400);
});

test("ahead when the 7-day used share is ahead of the elapsed share of the week", () => {
  // half the week gone: 50% elapsed
  expect(pacing(u(undefined, 51), NOW).ahead).toBe(true);
  expect(pacing(u(undefined, 50), NOW).ahead).toBe(false);
  expect(pacing(u(undefined, 50.4), NOW).ahead).toBe(false); // the display floors to 50: equal numbers are not ahead
  expect(pacing(u(undefined, 10), NOW).ahead).toBe(false);
  expect(pacing(u(99), NOW).ahead).toBe(false);
});

test("ahead at 10% of the week elapsed, and at the clamp ends", () => {
  const at = (pct: number, left: number) => pacing({ sevenDay: { usedPct: pct, resetsAt: NOW + left }, readAt: NOW }, NOW).ahead;
  const week = 7 * 86400;
  expect([at(20, 0.9 * week), at(5, 0.9 * week)]).toEqual([true, false]);
  expect(at(1, week + 86400)).toBe(true); // reset far ahead: elapsed clamps to 0
  expect(at(0, week + 86400)).toBe(false);
  expect(at(99, 1)).toBe(false); // about to reset: elapsed ~100%
});

test("windows outside 0..100%, with a ms epoch or more than 8 days ahead are refused", () => {
  const f = file();
  for (const bad of [input([-5, NOW + 1000]), input([150, NOW + 1000]), input([95, (NOW + 1000) * 1000]), input([95, NOW + 9 * 86400])]) recordUsage(bad, f, NOW);
  expect(existsSync(f)).toBe(false);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify({ fiveHour: { usedPct: 95, resetsAt: NOW * 1000 }, readAt: NOW }));
  expect(readUsage(f, NOW)).toBeNull(); // a stored ms epoch would hold forever
});

test("within one window a lagging reading cannot lower the percentage; a new window replaces it; one window at a time keeps the other", () => {
  const f = file();
  recordUsage(input([60, NOW + 1000]), f, NOW);
  recordUsage(input([55, NOW + 1000]), f, NOW + 5);
  expect(readUsage(f, NOW + 6)?.fiveHour?.usedPct).toBe(60);
  recordUsage(input(undefined, [30, NOW + 5000]), f, NOW + 7);
  recordUsage(input([65, NOW + 1000]), f, NOW + 8);
  expect(readUsage(f, NOW + 9)).toMatchObject({ fiveHour: { usedPct: 65 }, sevenDay: { usedPct: 30 } });
  recordUsage(input([3, NOW + 19000]), f, NOW + 10); // the next window starts low
  expect(readUsage(f, NOW + 11)?.fiveHour).toEqual({ usedPct: 3, resetsAt: NOW + 19000 });
});

test("usage-tap with an empty HOME writes nothing, not even a relative path, and exits 0", () => {
  const dir = tmp();
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "cli", "f1rm.ts"), "usage-tap"], { cwd: dir, env: { ...process.env, HOME: "" }, stdin: Buffer.from(input([51, Math.floor(Date.now() / 1000) + 3600])), stdout: "pipe", stderr: "pipe" });
  expect([r.exitCode, r.stdout.toString()]).toEqual([0, ""]);
  expect(existsSync(join(dir, ".f1rm"))).toBe(false); // (bun itself may create a Library/ cache folder for an empty HOME)
});

test("null or empty usage means no hold and not ahead of pace", () => {
  expect(pacing(null, NOW)).toEqual({ hold: null, ahead: false });
  expect(pacing({ readAt: NOW }, NOW)).toEqual({ hold: null, ahead: false });
});

test("warn flags 5-hour from 75% and 7-day from 85%", () => {
  expect(warn(u(74, 84))).toEqual({ fiveHour: false, sevenDay: false });
  expect(warn(u(75, 85))).toEqual({ fiveHour: true, sevenDay: true });
});

test("withUsageTap adds the statusLine to --settings, merges into a JSON one, lets the caller's statusLine win and leaves a file path alone", () => {
  const tap = { type: "command", command: `'${process.execPath}' '${join(import.meta.dir, "cli", "f1rm.ts")}' usage-tap` };
  expect(withUsageTap(["--model", "x"])).toEqual(["--settings", JSON.stringify({ statusLine: tap }), "--model", "x"]);
  const merged = withUsageTap(["--settings", '{"env":{"A":"1"}}', "--model", "x"]);
  expect(merged.slice(2)).toEqual(["--model", "x"]);
  expect(JSON.parse(merged[1])).toEqual({ env: { A: "1" }, statusLine: tap });
  const own = '{"statusLine":{"type":"command","command":"mine"}}';
  expect(withUsageTap(["--settings", own])).toEqual(["--settings", own]);
  expect(withUsageTap(["--settings", "/tmp/s.json"])).toEqual(["--settings", "/tmp/s.json"]);
});

test("withUsageTap merges into a --settings=<json> and never adds a second --settings", () => {
  const merged = withUsageTap(["--settings={\"env\":{\"A\":\"1\"}}", "--model", "x"]);
  expect(merged.filter((f) => f.startsWith("--settings"))).toHaveLength(1);
  expect(merged.slice(1)).toEqual(["--model", "x"]);
  expect(JSON.parse(merged[0]!.slice("--settings=".length))).toMatchObject({ env: { A: "1" }, statusLine: { type: "command" } });
  expect(withUsageTap(["--settings=/tmp/s.json"])).toEqual(["--settings=/tmp/s.json"]);
});

test("f1rm usage-tap records stdin into <HOME>/.f1rm/usage.json, prints the status text and exits 0, also on garbage", () => {
  const home = tmp();
  const run = (stdin: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "cli", "f1rm.ts"), "usage-tap"], { env: { ...process.env, HOME: home }, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const future = Math.floor(Date.now() / 1000) + 3600;
  const ok = run(input([51, future], [62, future + 86400]));
  expect([ok.exitCode, ok.stdout.toString().trim()]).toEqual([0, "5h 51% · 7d 62%"]);
  expect(readUsage(usageFile(home), Math.floor(Date.now() / 1000))?.fiveHour?.usedPct).toBe(51);
  expect(run("garbage").stdout.toString().trim()).toBe("5h 51% · 7d 62%"); // keeps showing the last reading
  const fresh = Bun.spawnSync(["bun", join(import.meta.dir, "cli", "f1rm.ts"), "usage-tap"], { env: { ...process.env, HOME: tmp() }, stdin: Buffer.from("garbage"), stdout: "pipe", stderr: "pipe" });
  expect([fresh.exitCode, fresh.stdout.toString().trim()]).toEqual([0, ""]);
});
