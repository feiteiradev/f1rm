// The New topic dialog: one name, and the project's room starts lead-<name> that opens with grilling. It reuses the Hire dialog's shell.
import { useEffect, useId, useRef, useState } from "react";
import { send } from "./post.ts";
import { startTopic, topicProblem } from "./topic.ts";
import "./hire.css";

/** `live` are the names of the project's leads that are live now. */
export function TopicDialog({ room, name, live, onClose }: { room: string; name: string; live: string[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const id = useId();
  const problem = topicProblem(topic, live);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    field.current?.focus(); // showModal puts focus on Close otherwise
    return () => opener?.focus?.();
  }, []);

  async function start() {
    if (problem !== null || busy) return;
    setBusy(true);
    setRefused(null);
    const error = await startTopic(room, topic, send, live);
    if (error === null) return onClose();
    setBusy(false);
    setRefused(error);
  }

  return (
    <dialog
      ref={dialog}
      className="hire topic"
      aria-labelledby={`${id}-title`}
      onCancel={(e) => (e.preventDefault(), onClose())}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <header>
        <h2 id={`${id}-title`}>New topic in {name}</h2>
        <button type="button" onClick={onClose} aria-label="Close new topic dialog">Close</button>
      </header>
      <form onSubmit={(e) => (e.preventDefault(), start())}>
        <div className="fields">
          <label htmlFor={`${id}-name`}>Topic name</label>
          <input
            id={`${id}-name`}
            ref={field}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-describedby={`${id}-help`}
            aria-invalid={!!problem}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={`${id}-help`} className="help">Lowercase words joined by hyphens. It starts lead-{topic || "<topic>"}, which opens by grilling you.</p>
          <button type="submit" disabled={problem !== null || busy}>{busy ? "Starting…" : "Start"}</button>
          <p className="problem" role="alert">{refused ?? problem}</p>
        </div>
      </form>
    </dialog>
  );
}
