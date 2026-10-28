// The Mac's sleep, seen from a timer that did not fire: a gap between two ticks of more than SLEEP_GAP_MS is a sleep, and for SLEEP_GRACE_MS after it nobody is judged stalled (their processes were
// frozen with the machine, not stuck). The office's recovery tick and `f1rm status --watch` each keep one.
export const SLEEP_GAP_MS = 2 * 60_000;
export const SLEEP_GRACE_MS = 5 * 60_000;

/** Call it at every tick with the clock; true while the machine is just back from a sleep. */
export function sleepGrace() {
  let last: number | null = null;
  let until = 0;
  return (now: number): boolean => {
    if (last !== null && now - last > SLEEP_GAP_MS) until = now + SLEEP_GRACE_MS;
    last = now;
    return now < until;
  };
}
