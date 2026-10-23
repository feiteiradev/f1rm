// The approvals broker: holds a PermissionRequest hook's HTTP response until the browser decides, the timeout passes or the session moves on.
import { randomUUID } from "node:crypto";

/** A raised hand: a tool the session is asking to run, who asks and why (the hire's last words, cut short), and whether "Always for this project" can be offered. */
export type Approval = { id: string; sessionId: string; tool: string; input: unknown; at: number; why: string; canAlways: boolean };
/** An allow rule Claude Code writes to the repo's `.claude/settings.local.json` (its `localSettings` destination). */
export type PermissionUpdate = { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow"; destination: "localSettings" };
/** What the hook answers with. Null (an empty 200) leaves the decision to the terminal prompt. */
export type Decision = { behavior: "allow"; updatedPermissions?: PermissionUpdate[] } | { behavior: "deny"; message: string };

/** Seconds the broker holds a request by default: 30 minutes, so a hire waits for the user in the office. `f1rm install` gives the hook a longer timeout, so the broker always answers first. */
export const DEFAULT_TIMEOUT_S = 1800;
/** When an empty why is read again, in ms after the request arrived. */
const LOOK_AGAIN_MS = [250, 1000, 3000];
export const DENY_MESSAGE = "Denied from the f1rm office.";

const allow = (ruleContent?: string, toolName = "Bash"): PermissionUpdate[] => [{ type: "addRules", rules: [{ toolName, ...(ruleContent && { ruleContent }) }], behavior: "allow", destination: "localSettings" }];

/**
 * The rule "Always for this project" adds, or none. A Bash command that is one plain program gets a rule for its program and subcommand (`git status *`), or for exactly the command when
 * it has no subcommand (`ls -la`). A chained, piped, substituted or redirected line, and any other tool, get only what Claude Code itself suggested for the request (`permission_suggestions`),
 * its allow rules moved to the local settings.
 */
export function alwaysRules(tool: string, input: unknown, suggestions: unknown): PermissionUpdate[] {
  const command = tool === "Bash" ? String((input as { command?: unknown } | null)?.command ?? "").trim() : "";
  const [program, sub] = command.split(/\s+/);
  if (command && /^[\w.+-]+$/.test(program) && !/[;&|()`$<>\\\n]/.test(command)) {
    const prefixed = sub !== undefined && /^[a-z][\w-]*$/.test(sub);
    return allow(prefixed ? `${program} ${sub} *` : command);
  }
  if (!Array.isArray(suggestions)) return [];
  const rules = suggestions.flatMap((s) => (s?.type === "addRules" && s.behavior === "allow" && Array.isArray(s.rules) ? s.rules : []));
  const named = rules.filter((r) => typeof r?.toolName === "string" && (r.ruleContent === undefined || typeof r.ruleContent === "string"));
  return named.length ? [{ type: "addRules", rules: named.map((r) => ({ toolName: r.toolName, ...(r.ruleContent !== undefined && { ruleContent: r.ruleContent }) })), behavior: "allow", destination: "localSettings" }] : [];
}

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
    /** Resolves with the browser's decision, or null on timeout, release or an aborted request. `why` is the hire's last words, or a reader of them; `always` is the rule the third answer adds, and none means it can't be offered. */
    hold(sessionId: string, tool: string, input: unknown, at: number, signal: AbortSignal, why: string | (() => string) = "", always: PermissionUpdate[] = []): Promise<Decision | null> {
      const read = typeof why === "function" ? why : () => why;
      const approval: Approval = { id: randomUUID(), sessionId, tool, input, at, why: read(), canAlways: always.length > 0 };
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
