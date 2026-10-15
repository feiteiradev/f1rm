// Tell: a message into an employee's inbox socket, read at its next step.
import type { machine as realMachine } from "./machine.ts";
import type { Employee } from "./office.ts";

export const MAX_MESSAGE = 4000;

export type TellResult = { ok: true } | { ok: false; error: string };

export async function tell(machine: typeof realMachine, e: Employee, message: string): Promise<TellResult> {
  // No socket header yet: messaging is off for the session, or it has not reported since f1rm started.
  if (!e.socket) return { ok: false, error: "This session has no inbox to tell." };
  try {
    await machine.tell(e.socket, e.sessionId, message);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Tell failed: ${(err as Error).message}` };
  }
}
