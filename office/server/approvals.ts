// The approvals broker: holds a PermissionRequest hook's HTTP response until the browser decides, the timeout passes or the session moves on.
import { randomUUID } from "node:crypto";

/** A raised hand: a tool the session is asking to run, who asks and why (the hire's last words, cut short), whether "Always for this project" can be offered, and the text of the rule it would add (empty when it can't). */
export type Approval = { id: string; sessionId: string; tool: string; input: unknown; at: number; why: string; canAlways: boolean; rule: string };
/** An allow rule Claude Code writes to the repo's `.claude/settings.local.json` (its `localSettings` destination). */
export type PermissionUpdate = { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow"; destination: "localSettings" };
/** What the hook answers with. Null (an empty 200) leaves the decision to the terminal prompt. */
export type Decision = { behavior: "allow"; updatedPermissions?: PermissionUpdate[] } | { behavior: "deny"; message: string };

/** Seconds the broker holds a request by default: 30 minutes, so a hire waits for the user in the office. `f1rm install` gives the hook a longer timeout, so the broker always answers first. */
export const DEFAULT_TIMEOUT_S = 1800;
/** When the why is read again, in ms after the request arrived: the transcript catches up with the hook a moment late. */
const LOOK_AGAIN_MS = [250, 1000, 3000];
export const DENY_MESSAGE = "Denied from the f1rm office.";

/**
 * What "Always for this project" grants: exactly the allow rules Claude Code suggested for this request (`permission_suggestions`), moved to the local settings, and never a rule the office makes.
 * Only `addRules` entries with `behavior: "allow"` count, and only their rules that name a tool and a pattern: a suggestion for a whole tool is dropped, as is an entry left with no rule.
 * No suggestion, no Always.
 */
export function alwaysRules(suggestions: unknown): PermissionUpdate[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((s) => {
    if (s?.type !== "addRules" || s.behavior !== "allow" || !Array.isArray(s.rules)) return [];
    const rules = s.rules.filter((r: any) => typeof r?.toolName === "string" && r.toolName && typeof r.ruleContent === "string" && r.ruleContent).map((r: any) => ({ toolName: r.toolName, ruleContent: r.ruleContent }));
    return rules.length ? [{ type: "addRules" as const, rules, behavior: "allow" as const, destination: "localSettings" as const }] : [];
  });
}

/** The rules as the card shows them: `Bash(npm run proofa), Bash(npm run proofb)`. */
const ruleText = (always: PermissionUpdate[]) => always.flatMap((u) => u.rules.map((r) => `${r.toolName}(${r.ruleContent})`)).join(", ");

export function createBroker(timeoutMs: number, onChange: () => void) {
  const held = new Map<string, { approval: Approval; always: PermissionUpdate[]; settle: (d: Decision | null) => void }>();

  function finish(id: string, decision: Decision | null) {
    const entry = held.get(id);
    if (!entry) return false;
    held.delete(id);
    entry.settle(decision);
    onChange();
    return true;
  }

  return {
    list: () => [...held.values()].map((h) => h.approval),
    /** Resolves with the browser's decision, or null on timeout, release or an aborted request. `read` gives the hire's last words; `always` are the rules the third answer adds, and none means it can't be offered. */
    hold(sessionId: string, tool: string, input: unknown, at: number, signal: AbortSignal, read: () => string = () => "", always: PermissionUpdate[] = []): Promise<Decision | null> {
      const approval: Approval = { id: randomUUID(), sessionId, tool, input, at, why: read(), canAlways: always.length > 0, rule: ruleText(always) };
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(approval.id, null), timeoutMs);
        // The hook fires a moment before Claude Code has written the hire's last words to its transcript, so what is read first can be empty or the words before: look again a few times.
        const looks = LOOK_AGAIN_MS.map((ms) => setTimeout(() => {
          const said = read();
          if (said && said !== approval.why && held.has(approval.id)) (approval.why = said, onChange());
        }, ms));
        const settle = (d: Decision | null) => (clearTimeout(timer), looks.forEach(clearTimeout), resolve(d));
        held.set(approval.id, { approval, always, settle });
        signal.addEventListener("abort", () => finish(approval.id, null), { once: true });
        onChange();
      });
    },
    /** False when the request is gone: already answered, timed out, or the terminal got there first. */
    answer: (id: string, decision: Decision) => finish(id, decision),
    /** Allows the request and adds its rule. False when it is gone, or has no rule to add (then it stays held). */
    always(id: string) {
      const entry = held.get(id);
      return !!entry?.always.length && finish(id, { behavior: "allow", updatedPermissions: entry.always });
    },
    /** The session moved on: its held requests get no decision. */
    release(sessionId: string) {
      for (const [id, h] of held) if (h.approval.sessionId === sessionId) finish(id, null);
    },
    releaseAll() {
      for (const id of [...held.keys()]) finish(id, null);
    },
  };
}
