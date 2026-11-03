// The leftovers card's answers. Remove posts no ids: the office deletes what a fresh docker list holds, never what a page names.
import type { LeftoverGroup } from "../server/gauges.ts";
import { send } from "./post.ts";

export type View = { phase: "open" | "busy" | "done"; problem?: string; note?: string };
export const OPEN: View = { phase: "open" };

export const totalOf = (g: LeftoverGroup) => g.running + g.exited;
/** The closed group's one line: its first name and how many more. */
export const sampleOf = (g: LeftoverGroup) => (totalOf(g) > 1 ? `${g.names[0]} and ${totalOf(g) - 1} more` : (g.names[0] ?? ""));
export const kindOf = (g: LeftoverGroup) => [g.running && `${g.running} running`, g.exited && `${g.exited} exited`].filter(Boolean).join(", ");

/** Posts the answer. `set` sees busy, then done (with the line to show) or open again with why not. */
export async function answerLeftovers(kind: "remove" | "keep", fingerprint: string, set: (v: View) => void) {
  set({ phase: "busy" });
  // Consent is for the list shown: Remove names it by its fingerprint (a hash, not the ids), and the office refuses a list that changed.
  const { error, reply } = await send(`leftovers/${kind}`, kind === "remove" ? { fingerprint } : undefined);
  if (error) return set({ phase: "open", problem: error });
  const saved = typeof reply?.note === "string" ? ` ${reply.note}` : "";
  set({ phase: "done", note: kind === "keep" ? "Kept. f1rm will not ask about these again." : `Removed ${reply?.removed ?? 0} leftover containers. Nothing else was touched.${saved}` });
}
