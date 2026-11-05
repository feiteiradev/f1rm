// The subscription's usage windows, as a `claude --bg` session's statusLine reports them (see `f1rm usage-tap`): one machine-wide file, read by pacing and the gauges.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivate } from "./server/private.ts";

export const HOLD_5H = 90, HOLD_7D = 95, WARN_5H = 75, WARN_7D = 85;
const WEEK = 7 * 86400;

export type Win = { usedPct: number; resetsAt: number };
export type Usage = { fiveHour?: Win; sevenDay?: Win; readAt: number };

export const usageFile = (home: string) => join(home, ".f1rm", "usage.json");

const win = (w: unknown): Win | undefined => {
  const { usedPct, resetsAt } = (w ?? {}) as Record<string, unknown>;
  // resetsAt < 1e11: a ms epoch would hold forever
  return typeof usedPct === "number" && typeof resetsAt === "number" && usedPct >= 0 && usedPct <= 100 && resetsAt > 0 && resetsAt < 1e11 ? { usedPct, resetsAt } : undefined;
};
// A window resets within 7 days, so one more than 8 days out is garbage.
const live = (w: Win | undefined, now: number) => (w && w.resetsAt > now && w.resetsAt <= now + 8 * 86400 ? w : undefined);
// Usage only rises within a window (same resetsAt), so a lagging session's lower reading never wins.
const newer = (fresh: Win | undefined, old: Win | undefined) =>
  fresh && old && old.resetsAt === fresh.resetsAt ? { ...fresh, usedPct: Math.max(fresh.usedPct, old.usedPct) } : (fresh ?? old);
const rawOf = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The file's content with expired windows dropped; null when it is missing, corrupt or holds no window. */
export function readUsage(file: string, now: number): Usage | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const fiveHour = live(win(raw.fiveHour), now), sevenDay = live(win(raw.sevenDay), now);
    if (!fiveHour && !sevenDay) return null;
    return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), readAt: typeof raw.readAt === "number" ? raw.readAt : now };
  } catch {
    return null;
  }
}

/** Takes the windows of a statusLine's stdin JSON into the file; bad input writes nothing and never throws. */
export function recordUsage(stdinJson: string, file: string, now: number): void {
  try {
    const rl = JSON.parse(stdinJson)?.rate_limits;
    const win_ = (k: string) => {
      const w = rl?.[k];
      return win({ usedPct: w?.used_percentage, resetsAt: w?.resets_at });
    };
    const fresh = { fiveHour: live(win_("five_hour"), now), sevenDay: live(win_("seven_day"), now) };
    if (!fresh.fiveHour && !fresh.sevenDay) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // Merge against the file as it is, and again if another session wrote it meanwhile (checked right before the rename).
    for (let i = 0; i < 3; i++) {
      const seen = rawOf(file);
      const old = readUsage(file, now);
      const fiveHour = live(newer(fresh.fiveHour, old?.fiveHour), now), sevenDay = live(newer(fresh.sevenDay, old?.sevenDay), now);
      writePrivate(tmp, JSON.stringify({ ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), readAt: now }));
      if (rawOf(file) === seen) break;
    }
    renameSync(tmp, file);
  } catch {
    // a session's status line must never fail on this
  }
}

/** A local clock time, with the weekday when it is more than a day away. */
export const when = (epoch: number, now: number) => {
  const d = new Date(epoch * 1000);
  return `${epoch - now > 86400 ? `${d.toLocaleDateString("en-GB", { weekday: "short" })} ` : ""}${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

export function pacing(u: Usage | null, now: number): { hold: { until: number; reason: string } | null; ahead: boolean } {
  const holds: { until: number; reason: string }[] = [];
  const { fiveHour: f, sevenDay: s } = u ?? {};
  if (f && f.usedPct >= HOLD_5H) holds.push({ until: f.resetsAt, reason: `5-hour usage is ${f.usedPct}% (resets ${when(f.resetsAt, now)})` });
  if (s && s.usedPct >= HOLD_7D) holds.push({ until: s.resetsAt, reason: `7-day usage is ${s.usedPct}% (resets ${when(s.resetsAt, now)})` });
  const hold = holds.sort((a, b) => b.until - a.until)[0] ?? null;
  const elapsed = s ? Math.min(1, Math.max(0, 1 - (s.resetsAt - now) / WEEK)) : 0;
  return { hold, ahead: !!s && Math.floor(s.usedPct) > Math.floor(elapsed * 100) };
}

export const warn = (u: Usage) => ({ fiveHour: (u.fiveHour?.usedPct ?? 0) >= WARN_5H, sevenDay: (u.sevenDay?.usedPct ?? 0) >= WARN_7D });

/** The status-line text `f1rm usage-tap` prints, e.g. "5h 51% · 7d 62%"; empty with no reading. */
export const usageText = (u: Usage | null) =>
  [u?.fiveHour && `5h ${u.fiveHour.usedPct}%`, u?.sevenDay && `7d ${u.sevenDay.usedPct}%`].filter(Boolean).join(" · ");

// Absolute and single-quoted: a `claude --bg` session may have no `f1rm` on its PATH, and claude runs the command through a shell.
const sh = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
const TAP = { type: "command", command: `${sh(process.execPath)} ${sh(join(import.meta.dir, "cli", "f1rm.ts"))} usage-tap` };

/** The claude flags with the usage statusLine in `--settings` (merged into a JSON one, the caller's own statusLine wins). ponytail shortcut: a `--settings` that is a file path is left as given and that hire reports no usage. */
export function withUsageTap(flags: string[]): string[] {
  const eq = flags.findIndex((f) => f.startsWith("--settings="));
  const at = eq >= 0 ? eq : flags.indexOf("--settings");
  if (at < 0) return ["--settings", JSON.stringify({ statusLine: TAP }), ...flags];
  try {
    const own = JSON.parse(eq >= 0 ? flags[eq]!.slice(11) : (flags[at + 1] ?? ""));
    if (own === null || typeof own !== "object" || Array.isArray(own)) return flags;
    const merged = JSON.stringify({ ...own, statusLine: own.statusLine ?? TAP });
    return flags.map((f, i) => (eq >= 0 ? (i === eq ? `--settings=${merged}` : f) : i === at + 1 ? merged : f));
  } catch {
    return flags;
  }
}
