// ⌘K's fuzzy search over employees.
export type Entry = { id: string; name: string; role: string; room: string; task: string };

/** A substring beats a scattered match; earlier and tighter is better. Null if `token` isn't in `field`. */
function score(field: string, token: string): number | null {
  const at = field.indexOf(token);
  if (at >= 0) return 1000 - at;
  let last = -1, gaps = 0;
  for (const ch of token) {
    const next = field.indexOf(ch, last + 1);
    if (next < 0) return null;
    if (last >= 0) gaps += next - last - 1;
    last = next;
  }
  return 500 - gaps;
}

/**
 * Entries matching every space-separated token of `query` in at least one of name, role, room or task,
 * best first; ties keep their input order. An empty query keeps everyone.
 */
export function search(entries: Entry[], query: string): Entry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked: { entry: Entry; total: number }[] = [];
  for (const entry of entries) {
    const fields = [entry.name, entry.role, entry.room, entry.task].map((f) => f.toLowerCase());
    let total = 0;
    for (const token of tokens) {
      const best = Math.max(...fields.map((f) => score(f, token) ?? -Infinity));
      if (best === -Infinity) {
        total = -Infinity;
        break;
      }
      total += best;
    }
    if (total > -Infinity) ranked.push({ entry, total });
  }
  return ranked.sort((a, b) => b.total - a.total).map((r) => r.entry);
}
