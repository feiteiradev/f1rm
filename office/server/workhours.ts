// The work-hours schedule: when the office pauses every project and when it lifts the pause it made. A pure function of the clock, the config and the project's two flags (the pause, and the
// override a manual resume out of hours leaves), so a boundary the Mac slept through needs no catching up: the first tick after waking sees the state and applies it.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";
import type { Paused } from "./pause.ts";
import { writePrivate } from "./private.ts";
import { instant, wall } from "./recovery.ts";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `workHours` of `~/.f1rm/config.json`. `enabled: false` turns the schedule off: every time is then a work time. */
export type WorkHours = { enabled: boolean; days: string[]; start: string; end: string; timezone: string };
export const DEFAULTS: WorkHours = { enabled: true, days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "19:00", timezone: "Europe/Lisbon" };

export const configFileOf = (home: string) => join(home, ".f1rm", "config.json");

const minutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
const zoneExists = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * The work hours, with the default for each field that is missing or impossible (a day that is no weekday, a time that is no HH:MM, a zone Intl does not know, an end that is not after the start),
 * so a typo never turns the schedule off or crashes the office. No file, or one that is cut, gives the defaults.
 * ponytail: a window that crosses midnight is not supported; set the days and hours of the day side.
 */
export function readConfig(file: string): WorkHours {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))?.workHours;
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const days = Array.isArray(raw.days) && raw.days.length && raw.days.every((d: unknown) => typeof d === "string" && WEEKDAYS.includes(d.toLowerCase())) ? [...new Set<string>(raw.days.map((d: string) => d.toLowerCase()))] : DEFAULTS.days;
  const time = (v: unknown, fallback: string) => (typeof v === "string" && HHMM.test(v) ? v : fallback);
  const start = time(raw.start, DEFAULTS.start);
  const end = time(raw.end, DEFAULTS.end);
  const window = minutes(end) > minutes(start) ? { start, end } : { start: DEFAULTS.start, end: DEFAULTS.end };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    days, ...window,
    timezone: typeof raw.timezone === "string" && zoneExists(raw.timezone) ? raw.timezone : DEFAULTS.timezone,
  };
}

/** The `[start, end)` instants of the calendar day `i` days after the one `t` falls on in the zone, or null when it is no work day. */
function dayWindow(c: WorkHours, t: number, i: number): [number, number] | null {
  const w = wall(t, c.timezone);
  const weekday = new Date(Date.UTC(w.year, w.month, w.day + i)).getUTCDay();
  if (!c.days.includes(WEEKDAYS[weekday]!)) return null;
  const at = (hhmm: string) => instant(c.timezone, w.year, w.month, w.day + i, Math.floor(minutes(hhmm) / 60), minutes(hhmm) % 60);
  return [at(c.start), at(c.end)];
}

export function inWorkHours(c: WorkHours, t: number): boolean {
  if (!c.enabled) return true;
  const day = dayWindow(c, t, 0);
  return !!day && t >= day[0] && t < day[1];
}

/** The next end of a work day after `t`: when a manual resume out of hours stops holding. */
export function nextEnd(c: WorkHours, t: number): number {
  for (let i = 0; i < 8; i++) {
    const day = dayWindow(c, t, i);
    if (day && day[1] > t) return day[1];
  }
  return Infinity; // unreachable: the config always has a work day
}

/** A manual resume out of hours: the schedule leaves the project running until `until`. */
export type Override = { until: number };

/**
 * What the schedule does to a project now. Out of hours an unpaused project is paused (unless an override holds), and a pause of any kind is left as it is. In hours only a pause the schedule made is
 * lifted: one by hand stays until the user resumes, however many boundaries pass.
 */
export function scheduleAction(c: WorkHours, now: number, paused: Paused | null, override: Override | null): "pause" | "resume" | null {
  if (inWorkHours(c, now)) return paused?.by === "schedule" ? "resume" : null;
  return paused || (override && override.until > now) ? null : "pause";
}

export const overridesDirOf = (home: string) => join(home, ".f1rm", "overrides");
export const overrideFile = (dir: string, repo: string) => join(dir, `${repoKey(repo)}.json`);

export function readOverride(file: string): Override | null {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return Number.isFinite(o?.until) ? { until: o.until } : null;
  } catch {
    return null;
  }
}

export function writeOverride(file: string, o: Override) {
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(`${file}.tmp`, JSON.stringify(o) + "\n");
  renameSync(`${file}.tmp`, file);
}

export const clearOverride = (file: string) => rmSync(file, { force: true });
