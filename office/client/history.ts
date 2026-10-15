// The panel's history of a shift: what was asked and what was told.
import type { AskLine } from "../server/ask.ts";

export type AskEntry = {
  kind: "ask";
  id: number;
  question: string;
  answer: string;
  state: "streaming" | "done" | "failed";
  /** Why it failed, when state is "failed". */
  error?: string;
};
export type TellEntry = {
  kind: "tell";
  id: number;
  message: string;
  state: "sending" | "sent" | "failed";
  /** Why it failed, when state is "failed". */
  error?: string;
};
export type HistoryEntry = AskEntry | TellEntry;
/** Entries per employee (session id), oldest first. */
export type History = Record<string, HistoryEntry[]>;

export function addEntry(history: History, sessionId: string, entry: HistoryEntry): History {
  return { ...history, [sessionId]: [...(history[sessionId] ?? []), entry] };
}

export function patchEntry<K extends HistoryEntry["kind"]>(
  history: History,
  sessionId: string,
  kind: K,
  id: number,
  patch: (e: Extract<HistoryEntry, { kind: K }>) => Extract<HistoryEntry, { kind: K }>,
): History {
  return { ...history, [sessionId]: (history[sessionId] ?? []).map((e) => (e.kind === kind && e.id === id ? patch(e as Extract<HistoryEntry, { kind: K }>) : e)) };
}

/** Feeds each piece of the answer to `onText` as it arrives. Null when the answer is complete, otherwise why it isn't. */
export async function readAnswer(res: Response, onText: (text: string) => void): Promise<string | null> {
  if (!res.ok) return (await res.json().catch(() => null))?.error ?? `Ask failed (${res.status}).`;
  const dec = new TextDecoder();
  let buf = "";
  const take = (raw: string): string | null => {
    if (!raw) return null;
    const line = JSON.parse(raw) as AskLine;
    if ("error" in line) return line.error;
    onText(line.text);
    return null;
  };
  try {
    const reader = res.body!.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const part of parts) {
        const failure = take(part);
        if (failure) return failure;
      }
    }
    return take(buf);
  } catch {
    return "The office isn't reachable.";
  }
}
