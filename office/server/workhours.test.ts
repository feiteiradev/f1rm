// Seam: the work-hours schedule as a pure function of a clock, the config and the project's flags, with Europe/Lisbon dates written as UTC instants.
// Lisbon is UTC+0 in winter and UTC+1 from the last Sunday of March to the last Sunday of October, so a wrong zone shows up as an hour of difference.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paused } from "./pause.ts";
import { DEFAULTS, inWorkHours, nextEnd, readConfig, scheduleAction } from "./workhours.ts";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const cfg = DEFAULTS;
const manual: Paused = { by: "manual", at: 1, why: "" };
const scheduled: Paused = { by: "schedule", at: 1, why: "work hours" };

const dir = mkdtempSync(join(tmpdir(), "f1rm-workhours-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a work day runs from 09:00 to 19:00 Lisbon time, the end excluded", () => {
  expect(inWorkHours(cfg, at(2026, 10, 27, 8, 59))).toBe(false); // Tue, winter time
  expect(inWorkHours(cfg, at(2026, 10, 27, 9, 0))).toBe(true);
  expect(inWorkHours(cfg, at(2026, 10, 27, 18, 59))).toBe(true);
  expect(inWorkHours(cfg, at(2026, 10, 27, 19, 0))).toBe(false);
});

test("Friday evening, Saturday and Sunday are out of hours until Monday 09:00", () => {
  expect(inWorkHours(cfg, at(2026, 10, 30, 19, 0))).toBe(false); // Fri 19:00
  expect(inWorkHours(cfg, at(2026, 10, 31, 12, 0))).toBe(false); // Sat noon
  expect(inWorkHours(cfg, at(2026, 11, 1, 12, 0))).toBe(false); // Sun noon
  expect(inWorkHours(cfg, at(2026, 11, 2, 8, 59))).toBe(false);
  expect(inWorkHours(cfg, at(2026, 11, 2, 9, 0))).toBe(true); // Mon 09:00
});

test("the clocks going forward (Sunday 2026-03-29) move Monday's start to 08:00 UTC", () => {
  expect(inWorkHours(cfg, at(2026, 3, 27, 18, 59))).toBe(true); // Fri, still winter: 19:00 is 19:00 UTC
  expect(inWorkHours(cfg, at(2026, 3, 27, 19, 0))).toBe(false);
  expect(inWorkHours(cfg, at(2026, 3, 30, 7, 59))).toBe(false); // Mon 08:59 in summer time
  expect(inWorkHours(cfg, at(2026, 3, 30, 8, 0))).toBe(true); // Mon 09:00
  expect(inWorkHours(cfg, at(2026, 3, 30, 17, 59))).toBe(true);
  expect(inWorkHours(cfg, at(2026, 3, 30, 18, 0))).toBe(false); // Mon 19:00
});

test("the clocks going back (Sunday 2026-10-25) move Monday's start to 09:00 UTC", () => {
  expect(inWorkHours(cfg, at(2026, 10, 23, 17, 59))).toBe(true); // Fri, summer time: 19:00 is 18:00 UTC
  expect(inWorkHours(cfg, at(2026, 10, 23, 18, 0))).toBe(false);
  expect(inWorkHours(cfg, at(2026, 10, 26, 8, 59))).toBe(false); // Mon 08:59 in winter time
  expect(inWorkHours(cfg, at(2026, 10, 26, 9, 0))).toBe(true);
});

test("nextEnd is the next 19:00 of a work day, skipping the weekend and following the zone", () => {
  expect(nextEnd(cfg, at(2026, 10, 27, 12, 0))).toBe(at(2026, 10, 27, 19, 0)); // Tue noon
  expect(nextEnd(cfg, at(2026, 10, 27, 20, 0))).toBe(at(2026, 10, 28, 19, 0)); // Tue evening
  expect(nextEnd(cfg, at(2026, 10, 24, 12, 0))).toBe(at(2026, 10, 26, 19, 0)); // Sat -> Mon
  expect(nextEnd(cfg, at(2026, 10, 23, 18, 0))).toBe(at(2026, 10, 26, 19, 0)); // Fri 19:00 summer -> Mon 19:00 winter
  expect(nextEnd(cfg, at(2026, 3, 28, 12, 0))).toBe(at(2026, 3, 30, 18, 0)); // Sat -> Mon 19:00 summer
});

test("at 19:00 every project that is not paused is paused by the schedule; one paused already is left", () => {
  const night = at(2026, 10, 27, 19, 0);
  expect(scheduleAction(cfg, night, null, null)).toBe("pause");
  expect(scheduleAction(cfg, night, scheduled, null)).toBe(null);
  expect(scheduleAction(cfg, night, manual, null)).toBe(null);
});

test("the office that starts out of hours with nothing paused pauses at once, unless an override is live", () => {
  const sat = at(2026, 10, 31, 11, 0);
  expect(scheduleAction(cfg, sat, null, null)).toBe("pause");
  expect(scheduleAction(cfg, sat, null, { until: at(2026, 11, 2, 19, 0) })).toBe(null);
});

test("at 09:00 on a work day only a project the schedule paused is resumed", () => {
  const morning = at(2026, 10, 27, 9, 0);
  expect(scheduleAction(cfg, morning, scheduled, null)).toBe("resume");
  expect(scheduleAction(cfg, morning, manual, null)).toBe(null); // paused by hand stays paused
  expect(scheduleAction(cfg, morning, null, null)).toBe(null);
});

test("a pause by hand during the work day is not resumed by the schedule, at 19:00 or the next 09:00", () => {
  expect(scheduleAction(cfg, at(2026, 10, 27, 14, 0), manual, null)).toBe(null);
  expect(scheduleAction(cfg, at(2026, 10, 27, 19, 0), manual, null)).toBe(null);
  expect(scheduleAction(cfg, at(2026, 10, 28, 9, 0), manual, null)).toBe(null);
});

test("an override lasts until the next 19:00; after it the schedule pauses again", () => {
  const until = at(2026, 10, 28, 19, 0); // resumed Tue 20:00 by hand
  expect(scheduleAction(cfg, at(2026, 10, 27, 23, 0), null, { until })).toBe(null);
  expect(scheduleAction(cfg, at(2026, 10, 28, 12, 0), null, { until })).toBe(null); // in hours anyway
  expect(scheduleAction(cfg, at(2026, 10, 28, 19, 0), null, { until })).toBe("pause"); // expired at the boundary
});

test("an override that expires while a pause by hand is in force changes nothing", () => {
  const until = at(2026, 10, 28, 19, 0);
  expect(scheduleAction(cfg, at(2026, 10, 28, 19, 30), manual, { until })).toBe(null);
});

test("a boundary the Mac slept through is applied at the first tick after waking", () => {
  // asleep from 18:50 to 21:00: the 19:00 pause lands now
  expect(scheduleAction(cfg, at(2026, 10, 27, 21, 0), null, null)).toBe("pause");
  // asleep through 09:00 Wednesday, awake at 09:20: the schedule's pause is lifted now
  expect(scheduleAction(cfg, at(2026, 10, 28, 9, 20), scheduled, null)).toBe("resume");
  // asleep over the whole weekend, awake Monday 10:00
  expect(scheduleAction(cfg, at(2026, 11, 2, 10, 0), scheduled, null)).toBe("resume");
});

test("a schedule that is turned off never pauses, and lifts the pause it made", () => {
  const off = { ...cfg, enabled: false };
  const night = at(2026, 10, 31, 23, 0);
  expect(scheduleAction(off, night, null, null)).toBe(null);
  expect(scheduleAction(off, night, scheduled, null)).toBe("resume");
  expect(scheduleAction(off, night, manual, null)).toBe(null);
});

test("with no config file the defaults are Mon-Fri 09:00-19:00 Europe/Lisbon, on", () => {
  expect(readConfig(join(dir, "absent.json"))).toEqual({ enabled: true, days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "19:00", timezone: "Europe/Lisbon" });
});

test("config.json overrides the days, the hours and the zone, and can turn the schedule off", () => {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ workHours: { days: ["mon", "wed"], start: "08:30", end: "17:00", timezone: "America/New_York" } }));
  const c = readConfig(file);
  expect(c).toEqual({ enabled: true, days: ["mon", "wed"], start: "08:30", end: "17:00", timezone: "America/New_York" });
  expect(inWorkHours(c, at(2026, 10, 26, 12, 29))).toBe(false); // Mon 08:29 in New York (EDT, UTC-4)
  expect(inWorkHours(c, at(2026, 10, 26, 12, 30))).toBe(true);
  expect(inWorkHours(c, at(2026, 10, 27, 15, 0))).toBe(false); // Tue is no work day
  writeFileSync(file, JSON.stringify({ workHours: { enabled: false } }));
  expect(readConfig(file).enabled).toBe(false);
});

test("a config that is cut, of another shape or has an impossible field falls back field by field to the defaults", () => {
  const file = join(dir, "bad.json");
  writeFileSync(file, "{ not json");
  expect(readConfig(file)).toEqual(DEFAULTS);
  writeFileSync(file, JSON.stringify({ workHours: { days: ["funday"], start: "25:00", end: "08:00", timezone: "Mars/Base", enabled: "no" } }));
  expect(readConfig(file)).toEqual(DEFAULTS);
  writeFileSync(file, JSON.stringify({ workHours: { start: "10:00", end: "09:00" } })); // an end before the start is no window
  expect(readConfig(file)).toEqual(DEFAULTS);
  writeFileSync(file, JSON.stringify({ workHours: { start: "10:00" } }));
  expect(readConfig(file)).toEqual({ ...DEFAULTS, start: "10:00" });
});
