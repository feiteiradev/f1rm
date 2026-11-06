// The permission card's pure part: what a raised hand shows, as text, and who needs the user.
import type { Employee, OfficeState } from "../server/office.ts";
import type { Approval } from "../server/approvals.ts";
import { post } from "./post.ts";

/** The full arguments of a tool request as plain text: a Bash command as is, anything else as indented JSON. Never shortened, because approving acts on exactly this. */
export function argsText(tool: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  if (tool === "Bash" && typeof command === "string") return command;
  return JSON.stringify(input, null, 2) ?? "";
}

/** What the third answer grants, in words: the rule is the server's exact text. */
export const alwaysNote = (rule: string) => `Allow ${rule} for every hire of this project`;

/** One raised hand as the card shows it. `why` is null until the hire's last words arrive; `always` is null unless the server named a rule to add. */
export function cardOf(state: OfficeState, a: Approval) {
  const who = state.employees[a.sessionId];
  return {
    who: who?.name ?? "Someone",
    project: who ? (state.rooms[who.room]?.name ?? "") : "",
    tool: a.tool || "Tool",
    args: argsText(a.tool, a.input),
    why: a.why || null,
    always: a.canAlways && a.rule ? { rule: a.rule, note: alwaysNote(a.rule) } : null,
  };
}

/** The raised hands of one hire, oldest first. */
export const handsOf = (state: OfficeState, sessionId: string) => (state.approvals ?? []).filter((a) => a.sessionId === sessionId);

/** Where a hire's card hangs, in the scene's scrolling frame: the horizontal centre of the desk, the pixel under its name, and the pixel over its raised-hand bubble. */
export type Anchor = { x: number; below: number; above: number };

export const NEEDS_YOU = "NEEDS YOU";

/** The tag over a lead that waits on the user, with the words a screen reader says for it. Only a lead wears it. */
export const needsYouTag = (e: Pick<Employee, "role" | "name" | "needsYou">) => (e.needsYou && e.role === "lead" ? { text: NEEDS_YOU, label: `${e.name} needs you` } : null);

/** Answers a decision ticket with the option the user picked; null when the office wrote it, otherwise why not. */
export const answerDecision = (id: string, option: number) => post(`decide/${encodeURIComponent(id)}`, { option });
