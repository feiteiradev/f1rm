// Ask: a read-only side question to a copy of an employee's session, answered as a stream.
import type { machine as realMachine } from "./machine.ts";
import type { Employee } from "./office.ts";

export const MAX_QUESTION = 4000;

/** One newline-delimited JSON line of the response body. The stream ending after text lines means the answer is complete. */
export type AskLine = { text: string } | { error: string };

/** The answer as NDJSON. Cancelling the stream (the browser went away) stops the fork. */
export function askStream(machine: typeof realMachine, e: Employee, question: string): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  const answer = machine.askFork(e.sessionId, e.cwd, question, stop.signal);
  const enc = new TextEncoder();
  const line = (l: AskLine) => enc.encode(JSON.stringify(l) + "\n");
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await answer.next();
        if (next.done) controller.close();
        else controller.enqueue(line({ text: next.value }));
      } catch (err) {
        controller.enqueue(line({ error: `Ask failed: ${(err as Error).message}` }));
        controller.close();
      }
    },
    // An answer waiting on the fork can't be returned from, so the fork itself is stopped.
    cancel() {
      stop.abort();
    },
  });
}
