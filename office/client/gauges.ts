// What each usage gauge shows: its state from the reading, the reset text and the sentences a reader hears. Pure; the page only draws it.
import type { UsageView } from "../server/gauges.ts";

type Win = { usedPct: number; resetsAt: number };
export type Kind = "fiveHour" | "sevenDay";
export type State = "ok" | "warn" | "paused" | "none";

// The same numbers as usage.ts (the client cannot import it: it reads files); gauges.test.tsx pins them equal.
export const THRESHOLDS = { fiveHour: { warn: 75, hold: 90 }, sevenDay: { warn: 85, hold: 95 } };
const NAMES = { fiveHour: "5-hour", sevenDay: "Weekly" };
const WEEK = 7 * 86400;
const pad = (n: number) => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** A local clock time (24h), with the 3-letter weekday when the day is not today. */
export function resetText(epoch: number, now: number, long = false) {
  const d = new Date(epoch * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, new Date(now * 1000)) ? time : `${d.toLocaleDateString("en-GB", { weekday: long ? "long" : "short" })} ${time}`;
}

export type Gauge = {
  kind: Kind;
  name: string;
  state: State;
  /** Whole number, rounded down so it never reads above what the thresholds judged. */
  pct: number | null;
  reset: string | null;
  resetIso: string | null;
  ahead: boolean;
  /** Where the elapsed share of the 7 days sits on the track, in percent; weekly only. */
  pace: number | null;
  ticks: number[];
  label: string;
  /** The paused chip's tooltip. */
  hold: string | null;
};

export function gaugeModel(kind: Kind, win: Win | undefined, now: number, ahead = false): Gauge {
  const name = NAMES[kind];
  const t = THRESHOLDS[kind];
  const ticks = [t.warn, t.hold];
  if (!win) return { kind, name, state: "none", pct: null, reset: null, resetIso: null, ahead: false, pace: null, ticks: [], label: `${name} window: no reading yet`, hold: null };
  const state: State = win.usedPct >= t.hold ? "paused" : win.usedPct >= t.warn ? "warn" : "ok";
  const pct = Math.floor(win.usedPct);
  const reset = resetText(win.resetsAt, now);
  const long = resetText(win.resetsAt, now, true);
  const isAhead = kind === "sevenDay" && ahead;
  const body =
    state === "paused" ? `${pct}% used, paused until ${long}, no new work starts` : `${pct}% used, ${state === "warn" ? "near limit, " : ""}resets ${long}`;
  return {
    kind, name, state, pct, reset, ahead: isAhead, ticks,
    resetIso: new Date(win.resetsAt * 1000).toISOString(),
    pace: isAhead ? Math.min(100, Math.max(0, (1 - (win.resetsAt - now) / WEEK) * 100)) : null,
    label: `${name} window: ${body}${isAhead ? ", ahead of pace, 1 team per project" : ""}`,
    hold: state === "paused" ? `No hire, wake or auto-wake wait starts until ${reset}.` : null,
  };
}

export const gaugesOf = (u: UsageView | null | undefined, now: number) => [
  gaugeModel("fiveHour", u?.fiveHour, now),
  gaugeModel("sevenDay", u?.sevenDay, now, !!u?.oneTeam),
];

/** What a polite status region says when `next` differs from `prev` in a way worth hearing; null otherwise (and for the first reading, and for ordinary drift). */
export function announce(prev: UsageView | null | undefined, next: UsageView | null | undefined, now: number): string | null {
  const [before, after] = [gaugesOf(prev, now), gaugesOf(next, now)];
  for (let i = 0; i < 2; i++) {
    const [p, n] = [before[i]!, after[i]!];
    if (p.state === n.state) continue;
    if (!prev && n.state !== "paused") continue; // a first reading is news only when it is already paused
    if (n.state === "paused") return `${n.name} usage reached ${n.pct}%. Paused until ${n.reset}: no hire, wake or auto-wake wait starts.`;
    if (p.state === "paused") return `Paused work resumes: ${n.name} window reset.`;
    if (n.state === "warn") return `${n.name} usage is near limit: ${n.pct}% used, resets ${n.reset}.`;
  }
  if (prev && !before[1]!.ahead && after[1]!.ahead) return "Weekly usage is ahead of pace: 1 team per project.";
  return null;
}
