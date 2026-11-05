// What the office pushes for the top-bar usage gauges and the one-time leftovers card. Reads only; the one deletion (answer "removed") goes through docker.ts's removeLeftovers.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { leftovers, removeLeftovers, type Docker } from "../docker.ts";
import { pacing, readUsage, warn, type Usage } from "../usage.ts";
import { writePrivate } from "./private.ts";

export type UsageView = Usage & { warn: { fiveHour: boolean; sevenDay: boolean }; hold: { until: number; reason: string } | null; ahead: boolean };
export type LeftoverGroup = { prefix: string; running: number; exited: number; names: string[] };
/** `fingerprint` is a hash of the sorted container ids: what the click names as the list it was shown, never the ids themselves. */
export type LeftoversView = { count: number; running: number; exited: number; groups: LeftoverGroup[]; moreGroups: number; fingerprint: string };

/** The reading with its derived flags; `nowMs` is the office's clock. Null with no file. */
export function usageView(file: string | undefined, nowMs: number): UsageView | null {
  const now = Math.floor(nowMs / 1000);
  const u = file ? readUsage(file, now) : null;
  return u && { ...u, warn: warn(u), ...pacing(u, now) };
}

const NAMES_SHOWN = 8;
const GROUPS_SHOWN = 20;
/** `tideline-e2e-3f9a1c` -> `tideline-e2e-*`; `review-quillbase-218` -> `review-quillbase-*`. */
export const groupOf = (name: string) => {
  const e2e = name.indexOf("-e2e-");
  if (e2e > 0) return `${name.slice(0, e2e)}-e2e-*`;
  const review = name.match(/^(review-[^-]+)-/);
  return review ? `${review[1]}-*` : name;
};
export const fingerprintOf = (ids: string[]) => createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16);

/** Running groups first, then exited, largest first inside each; at most 20 groups, the rest counted in `moreGroups`. */
export function groupLeftovers(items: { id: string; name: string; state: string }[]): LeftoversView | null {
  if (!items.length) return null;
  const by = new Map<string, LeftoverGroup & { all: number }>();
  for (const { name, state } of items) {
    const prefix = groupOf(name);
    const g = by.get(prefix) ?? { prefix, running: 0, exited: 0, names: [], all: 0 };
    by.set(prefix, g);
    g[state === "running" ? "running" : "exited"]++;
    g.all++;
    if (g.names.length < NAMES_SHOWN) g.names.push(name);
  }
  const all = [...by.values()]
    .sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || b.all - a.all)
    .map(({ all: _, ...g }) => g);
  const running = all.reduce((n, g) => n + g.running, 0);
  return { count: items.length, running, exited: items.length - running, groups: all.slice(0, GROUPS_SHOWN), moreGroups: Math.max(0, all.length - GROUPS_SHOWN), fingerprint: fingerprintOf(items.map((i) => i.id)) };
}

const answeredOf = (file: string) => {
  try {
    const a = JSON.parse(readFileSync(file, "utf8")).answered;
    return a === "removed" || a === "kept";
  } catch (err) {
    if (existsSync(file)) console.log(`f1rm: ${file} cannot be read (${(err as Error).message}); the leftovers card will ask again`);
    return false;
  }
};

const CACHE_MS = 60_000;
const ANSWERED = "Already answered.";
type Refused = { ok: false; error: string; removed: number; failed: number; status: number };
const refused = (error: string, status: number, removed = 0, failed = 0): Refused => ({ ok: false, error, removed, failed, status });

/** The leftovers card: the list is cached for a minute and asked of docker only while the user has not answered (the answer is on disk, so it lasts). One answer, once. */
export function createLeftovers({ docker, file, clock, onChange }: { docker?: Docker; file?: string; clock: () => number; onChange: () => void }) {
  let answered = !!file && answeredOf(file);
  let removing = false; // set before the first await, so a second Remove or a Keep meanwhile is refused
  let card: LeftoversView | null = null;
  let at = -Infinity;
  let busy = false;
  const refresh = async () => {
    busy = true;
    try {
      const { items } = await leftovers(docker!);
      if (answered) return;
      const next = groupLeftovers(items);
      const changed = JSON.stringify(next) !== JSON.stringify(card);
      card = next;
      if (changed) onChange();
    } finally {
      at = clock();
      busy = false;
    }
  };
  /** Records the answer in memory first, then on disk; false when the disk refused (the answer holds until the office restarts). */
  const settle = (kind: "removed" | "kept") => {
    answered = true;
    card = null;
    let saved = true;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      mkdirSync(dirname(file!), { recursive: true });
      writePrivate(tmp, JSON.stringify({ answered: kind, at: clock() }));
      renameSync(tmp, file!);
    } catch (err) {
      saved = false;
      console.error(`f1rm: could not save the leftovers answer (${kind}): ${(err as Error).message}`);
    }
    onChange();
    return saved;
  };
  return {
    /** What the snapshot carries now; a stale list starts a refresh and the card arrives with the next push. */
    current(): LeftoversView | null {
      if (docker && file && !answered && !busy && clock() - at >= CACHE_MS) void refresh().catch(() => {});
      return answered ? null : card;
    },
    keep(): { ok: true } | Refused {
      if (!file) return refused("This office does not look after leftovers.", 404);
      if (answered || removing) return refused(ANSWERED, 409);
      settle("kept");
      return { ok: true };
    },
    /** Removes what a fresh docker list holds, never what the client names, and only when that list is the one the click was shown (`fingerprint`). The card is answered only when everything went. */
    async remove(fingerprint: unknown): Promise<{ ok: true; removed: number; note?: string } | Refused> {
      if (!docker || !file) return refused("This office does not look after leftovers.", 404);
      if (answered || removing) return refused(ANSWERED, 409);
      removing = true;
      try {
        const fresh = await leftovers(docker);
        if (!fresh.items.length && fresh.errors.length) return refused(`Docker did not answer: ${fresh.errors[0]}`, 502);
        const shown = groupLeftovers(fresh.items)?.fingerprint;
        // Never "removed" for a list that is empty, or for a click that names no list.
        if (typeof fingerprint !== "string" || shown === undefined || shown !== fingerprint) {
          if (!busy) void refresh().catch(() => {}); // the card shows the list as it is now
          return refused("The list changed, review it again.", 409);
        }
        const ids = fresh.items.map((i) => i.id);
        const r = await removeLeftovers(docker, ids);
        // Errors, or nothing removed of a list that held something (its own re-listing failed): a failure, not an answer.
        if (r.errors.length || (ids.length > 0 && r.removed.length === 0)) {
          at = -Infinity; // the card shows what is left
          const failed = ids.length - r.removed.length;
          return refused(`Removed ${r.removed.length} of ${ids.length}. ${failed} could not be removed: ${(r.errors[0] ?? "they were gone before docker was asked").replace(/^[^:]*: /, "")}. Try again or keep them.`, 502, r.removed.length, failed);
        }
        const saved = settle("removed");
        return { ok: true, removed: r.removed.length, ...(!saved && { note: "The answer was not saved, so f1rm may ask again after a restart." }) };
      } finally {
        removing = false;
      }
    },
  };
}
