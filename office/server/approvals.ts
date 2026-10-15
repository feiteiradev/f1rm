// The approvals broker: holds a PermissionRequest hook's HTTP response until the browser decides, the timeout passes or the session moves on.
import { randomUUID } from "node:crypto";

/** A raised hand: a tool the session is asking to run. */
export type Approval = { id: string; sessionId: string; tool: string; input: unknown; at: number };
/** What the hook answers with. Null (an empty 200) leaves the decision to the terminal prompt. */
export type Decision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** Seconds the broker holds a request by default. `f1rm install` gives the hook a longer timeout, so the broker always answers first. */
export const DEFAULT_TIMEOUT_S = 60;
export const DENY_MESSAGE = "Denied from the f1rm office.";

export function createBroker(timeoutMs: number, onChange: () => void) {
  const held = new Map<string, { approval: Approval; settle: (d: Decision | null) => void }>();

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
    /** Resolves with the browser's decision, or null on timeout, release or an aborted request. */
    hold(sessionId: string, tool: string, input: unknown, at: number, signal: AbortSignal): Promise<Decision | null> {
      const approval: Approval = { id: randomUUID(), sessionId, tool, input, at };
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(approval.id, null), timeoutMs);
        const settle = (d: Decision | null) => (clearTimeout(timer), resolve(d));
        held.set(approval.id, { approval, settle });
        signal.addEventListener("abort", () => finish(approval.id, null), { once: true });
        onChange();
      });
    },
    /** False when the request is gone: already answered, timed out, or the terminal got there first. */
    answer: (id: string, decision: Decision) => finish(id, decision),
    /** The session moved on: its held requests get no decision. */
    release(sessionId: string) {
      for (const [id, h] of held) if (h.approval.sessionId === sessionId) finish(id, null);
    },
    releaseAll() {
      for (const id of [...held.keys()]) finish(id, null);
    },
  };
}
