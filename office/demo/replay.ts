// Plays a recorded event log back as office states, through the same reducer and sweep the server runs.
import { emptyOffice, reduce, sweep, type F1rmEvent, type OfficeState, type Timeouts } from "../server/office.ts";

/** The recording is 7 minutes long; playing it this many times faster makes it a minute. */
export const SPEED = 6;
// The server's defaults, so a quiet employee goes offline in the demo exactly when it would in the office.
const TIMEOUTS: Timeouts = { offlineAfter: 5 * 60_000, removeAfter: 15 * 60_000 };
const TICK = 1000;
const HOLD = 14_000;

/** The office after each change, with its time in ms on the recording's clock. Quiet employees go offline on that clock. */
export function frames(events: F1rmEvent[]): { at: number; state: OfficeState }[] {
  let state = emptyOffice();
  const out = [{ at: 0, state }];
  const push = (at: number, next: OfficeState) => {
    if (next !== state) out.push({ at, state: (state = next) });
  };
  let i = 0;
  const end = (events.at(-1)?.at ?? 0) + HOLD;
  for (let now = TICK; now <= end; now += TICK) {
    for (; i < events.length && events[i].at <= now; i++) push(events[i].at, reduce(state, events[i]));
    push(now, sweep(state, now, TIMEOUTS, (e) => e.lastEventAt, new Set()));
  }
  return out;
}

type Timer = ReturnType<typeof setTimeout>;
/** Emits each frame when its time comes, `speed` times faster than recorded, and starts over from an empty office after the last. Returns a stop function. */
export function play(
  fs: { at: number; state: OfficeState }[],
  emit: (s: OfficeState) => void,
  { speed = SPEED, schedule = setTimeout, cancel = clearTimeout }: { speed?: number; schedule?: (f: () => void, ms: number) => Timer; cancel?: (t: Timer) => void } = {},
) {
  let timer: Timer;
  const show = (i: number) => {
    emit(fs[i].state);
    const next = (i + 1) % fs.length;
    timer = schedule(() => show(next), (next === 0 ? 0 : fs[next].at - fs[i].at) / speed);
  };
  show(0);
  return () => cancel(timer);
}
