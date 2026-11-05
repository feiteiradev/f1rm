// The top-bar usage gauges: the state each reading shows (thresholds, ahead of pace, no reading), the reset text, the words that tell the states apart without colour, and the polite announcements.
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageView } from "../server/gauges.ts";
import { HOLD_5H, HOLD_7D, WARN_5H, WARN_7D } from "../usage.ts";
import { announce, gaugeModel, resetText, THRESHOLDS } from "./gauges.ts";
import { Gauges } from "./gauges.tsx";

const real = { mode: process.env.MODE };
afterEach(() => (real.mode === undefined ? delete process.env.MODE : (process.env.MODE = real.mode)));

// 2026-11-03 (a Tuesday) 12:00 local; the clock for every test.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime() / 1000;
const NOW = at(3, 12);
const view = (five: number | null, seven: number | null, over: Partial<UsageView> = {}): UsageView => ({
  ...(five !== null && { fiveHour: { usedPct: five, resetsAt: at(3, 18, 40) } }),
  ...(seven !== null && { sevenDay: { usedPct: seven, resetsAt: at(9, 9) } }), // Monday 9 Nov
  readAt: NOW,
  warn: { fiveHour: (five ?? 0) >= WARN_5H, sevenDay: (seven ?? 0) >= WARN_7D },
  hold: null,
  ahead: false,
  ...over,
});
const html = (usage: UsageView | null) => renderToStaticMarkup(<Gauges usage={usage} now={NOW} />);

test("the client's thresholds are the pacing module's", () => {
  expect(THRESHOLDS).toEqual({ fiveHour: { warn: WARN_5H, hold: HOLD_5H }, sevenDay: { warn: WARN_7D, hold: HOLD_7D } });
});

test("the reset reads a clock time today and a weekday plus time on another day", () => {
  expect(resetText(at(3, 18, 40), NOW)).toBe("18:40");
  expect(resetText(at(9, 9), NOW)).toBe("Mon 09:00");
  expect(resetText(at(4, 0, 5), NOW)).toBe("Wed 00:05"); // under a day away but not today
});

test("normal: used percent, reset time, no chip, no note", () => {
  const h = html(view(42, 38));
  expect(h).toContain('role="group" aria-label="Claude usage"');
  expect(h).toContain('aria-label="5-hour window: 42% used, resets 18:40"');
  expect(h).toContain('aria-label="Weekly window: 38% used, resets Monday 09:00"');
  expect(h).toContain(">42%<");
  expect(h).toContain("resets <time");
  expect(h).toContain(">Mon 09:00</time>");
  expect(h).not.toContain("Near limit");
  expect(h).not.toContain("Paused until");
  expect(h).not.toContain("Ahead of pace");
  expect(h.match(/data-state="ok"/g)).toHaveLength(2);
});

test("warn from 75 (5-hour) and 85 (weekly), not from 74 and 84: an outlined Near limit chip", () => {
  expect(gaugeModel("fiveHour", { usedPct: 74.9, resetsAt: at(3, 18, 40) }, NOW).state).toBe("ok");
  expect(gaugeModel("fiveHour", { usedPct: 75, resetsAt: at(3, 18, 40) }, NOW).state).toBe("warn");
  expect(gaugeModel("sevenDay", { usedPct: 84.9, resetsAt: at(9, 9) }, NOW).state).toBe("ok");
  expect(gaugeModel("sevenDay", { usedPct: 85, resetsAt: at(9, 9) }, NOW).state).toBe("warn");
  const h = html(view(78, 61));
  expect(h).toContain('aria-label="5-hour window: 78% used, near limit, resets 18:40"');
  expect(h).toContain('data-state="warn"');
  expect(h).toContain(">Near limit<");
  expect(h.match(/Near limit/g)).toHaveLength(1); // the weekly gauge judges itself
});

test("paused from 90 (5-hour) and 95 (weekly), not from 89 and 94: a solid chip with the window's reset, and the tooltip", () => {
  expect(gaugeModel("fiveHour", { usedPct: 89.9, resetsAt: at(3, 18, 40) }, NOW).state).toBe("warn");
  expect(gaugeModel("fiveHour", { usedPct: 90, resetsAt: at(3, 18, 40) }, NOW).state).toBe("paused");
  expect(gaugeModel("sevenDay", { usedPct: 94.9, resetsAt: at(9, 9) }, NOW).state).toBe("warn");
  expect(gaugeModel("sevenDay", { usedPct: 95, resetsAt: at(9, 9) }, NOW).state).toBe("paused");
  const h = html(view(93, 71, { hold: { until: at(3, 18, 40), reason: "x" } }));
  expect(h).toContain('aria-label="5-hour window: 93% used, paused until 18:40, no new work starts"');
  expect(h).toContain('data-state="paused"');
  expect(h).toContain(">Paused until <time");
  expect(h).toContain('title="No hire, wake or auto-wake wait starts until 18:40."');
  expect(h).not.toContain("Near limit");
  const w = html(view(10, 96));
  expect(w).toContain("Paused until <time");
  expect(w).toContain(">Mon 09:00</time>");
  expect(w).toContain("until Mon 09:00.");
});

test("warning and paused differ by words, not colour alone: a plain chip against a solid one with its own class", () => {
  const warn = html(view(78, 10));
  const paused = html(view(93, 10));
  expect(warn).toContain('class="chip"');
  expect(paused).toContain('class="chip"');
  expect(warn).toContain("Near limit");
  expect(paused).toContain("Paused until");
  expect(warn).not.toContain("Paused until");
  expect(paused).not.toContain("Near limit");
});

test("ahead of pace: a notch at the elapsed share and the note, on the weekly gauge only", () => {
  // Weekly resets Mon 9 Nov 09:00; now Tue 3 Nov 12:00: 5d21h left, so 17.0% of 7 days is gone... 64% used is ahead.
  const h = html(view(35, 64, { ahead: true }));
  expect(h).toContain('aria-label="Weekly window: 64% used, resets Monday 09:00, ahead of pace"');
  expect(h).toContain('<span class="pace-note">Ahead of pace</span>');
  expect(h).not.toContain("team per project");
  expect(h.match(/class="pace"/g)).toHaveLength(1);
  expect(h).toContain('class="pace" style="left:16.');
  expect(html(view(35, 64))).not.toContain("Ahead of pace");
});

test("no reading: both gauges stay, each says so and shows no number, ticks or fill", () => {
  const h = html(null);
  expect(h).toContain('aria-label="5-hour window: no reading yet"');
  expect(h).toContain('aria-label="Weekly window: no reading yet"');
  expect(h.match(/data-state="none"/g)).toHaveLength(2);
  expect(h.match(/no reading yet<\/span>/g)).toHaveLength(2);
  expect(h).not.toContain('class="fill"');
  expect(h).not.toContain('class="tick"');
  expect(h).not.toContain("%");
});

test("a window can be missing on its own", () => {
  const h = html(view(51, null));
  expect(h).toContain("5-hour window: 51% used");
  expect(h).toContain('aria-label="Weekly window: no reading yet"');
});

test("the percent is a whole number, rounded down so it never reads above what the threshold judged", () => {
  expect(html(view(74.9, 10))).toContain(">74%<");
});

test("the gauges take no tab stop, the track is hidden from readers, and one polite status region exists", () => {
  const h = html(view(42, 38));
  expect(h).not.toContain("tabindex");
  expect(h).not.toContain("<button");
  expect(h).toContain('class="track" aria-hidden="true"');
  expect(h).toContain('class="sr-only" role="status"');
});

test("the recording has no office to read: no gauges in the demo build", () => {
  process.env.MODE = "demo";
  expect(html(view(42, 38))).toBe("");
});

test("announcements: crossing a threshold, resuming and a pace flip are spoken; ordinary drift is not", () => {
  const a = (p: UsageView | null, n: UsageView | null) => announce(p, n, NOW);
  expect(a(view(70, 10), view(78, 10))).toBe("5-hour usage is near limit: 78% used, resets 18:40.");
  expect(a(view(80, 10), view(93, 10))).toBe("5-hour usage reached 93%. Paused until 18:40: no hire, wake or auto-wake wait starts.");
  expect(a(view(93, 10), view(3, 10))).toBe("Paused work resumes: 5-hour window reset.");
  expect(a(view(10, 60), view(10, 64, { ahead: true }))).toBe("Weekly usage is ahead of pace.");
  expect(a(view(40, 10), view(44, 12))).toBeNull();
  expect(a(view(78, 10), view(80, 10))).toBeNull();
  expect(a(null, view(78, 10))).toBeNull(); // a first reading that is only near the limit is not news
  expect(a(null, view(93, 10))).toBe("5-hour usage reached 93%. Paused until 18:40: no hire, wake or auto-wake wait starts."); // but a first one already paused is
  expect(a(view(93, 10), view(93, 10))).toBeNull();
});
