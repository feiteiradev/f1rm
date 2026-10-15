// Ask: the panel's side-question box and the shift's history. Answers stream in from a read-only copy of the session.
import { useRef, useState } from "react";
import { addEntry, patchAsk, readAnswer, type History, type HistoryEntry } from "./history.ts";
import "./ask.css";

/** Keeps the shift's history above the panel, so closing it or selecting someone else loses nothing. */
// ponytail: lives in the page's memory, so a reload starts a new shift's history; move it to the server if that is felt.
export function useHistory() {
  const [history, setHistory] = useState<History>({});
  const nextId = useRef(0);

  async function ask(sessionId: string, question: string) {
    const id = nextId.current++;
    setHistory((h) => addEntry(h, sessionId, { kind: "ask", id, question, answer: "", state: "streaming" }));
    const finish = (error: string | null) =>
      setHistory((h) => patchAsk(h, sessionId, id, (e) => ({ ...e, state: error ? "failed" : "done", ...(error && { error }) })));
    if (import.meta.env.MODE === "demo") return finish("Ask needs a live office; this is a recording.");
    try {
      // The page lives under /<ui token>/, so a relative URL carries the token.
      const res = await fetch(new URL(`ask/${encodeURIComponent(sessionId)}`, location.href), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      finish(await readAnswer(res, (text) => setHistory((h) => patchAsk(h, sessionId, id, (e) => ({ ...e, answer: e.answer + text })))));
    } catch {
      finish("The office isn't reachable.");
    }
  }
  return { history, ask };
}

function Entry({ entry }: { entry: HistoryEntry }) {
  switch (entry.kind) {
    case "ask":
      return (
        <li data-kind="ask" data-state={entry.state}>
          <p className="q">{entry.question}</p>
          <p className="a" aria-live="polite">
            {entry.answer || (entry.state === "streaming" ? "Reading its session…" : "")}
          </p>
          {entry.error && <p className="problem">{entry.error}</p>}
        </li>
      );
    case "tell":
      return (
        <li data-kind="tell">
          <p className="q">Told: {entry.message}</p>
        </li>
      );
  }
}

export function AskBox({ entries, onAsk }: { entries: HistoryEntry[]; onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState("");
  return (
    <section className="ask" aria-label="Ask">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!question.trim()) return;
          onAsk(question.trim());
          setQuestion("");
        }}
      >
        <label htmlFor="ask-question">Ask a side question</label>
        <div className="row">
          <input id="ask-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What are you working on?" maxLength={4000} autoComplete="off" />
          <button type="submit" disabled={!question.trim()}>Ask</button>
        </div>
      </form>
      <p className="hint">Answered by a read-only copy of this session. It can't see the turn being written right now, and it never changes the work.</p>
      {entries.length > 0 && (
        <ol className="history" aria-label="History this shift">
          {entries.map((e) => (
            <Entry key={`${e.kind}-${e.id}`} entry={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
