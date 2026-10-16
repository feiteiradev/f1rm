// A project's edition: the question asked on first entry, and the select in the top bar. Work is the engineering company;
// Founder adds marketing, SEO, social media, sales and strategy.
import { useEffect, useId, useRef, useState } from "react";
import { send } from "./post.ts";
import "./edition.css";

export type Edition = "work" | "founder";
const DEMO = import.meta.env.MODE === "demo";

/** Sets a project's edition; null when the office did it, otherwise why it didn't. */
async function setEdition(room: string, edition: Edition) {
  if (DEMO) return "Editions are set in a live office; this is a recording.";
  return (await send("edition", { room, edition })).error;
}

/** The question on entering a project with no edition. Not now (or Escape) closes it until the next entry. */
export function EditionAsk({ room, name, onClose }: { room: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => opener?.focus?.();
  }, []);
  async function choose(edition: Edition) {
    const error = await setEdition(room, edition);
    if (error) return setProblem(error);
    onClose();
  }
  return (
    <dialog ref={dialog} className="edition-ask" aria-labelledby={`${id}-title`} aria-describedby={`${id}-what`} onCancel={(e) => (e.preventDefault(), onClose())}>
      <h2 id={`${id}-title`}>What kind of project is {name}?</h2>
      <dl id={`${id}-what`}>
        <dt>Work</dt>
        <dd>The engineering company: designers, developers, a reviewer and a researcher.</dd>
        <dt>Founder</dt>
        <dd>All of that, plus marketing, SEO, social media, sales and strategy, for a product of your own.</dd>
      </dl>
      <p className="where">You can change it later in the top bar, or with <code>f1rm edition</code>.</p>
      <div className="choices">
        <button type="button" onClick={() => choose("work")}>Work</button>
        <button type="button" onClick={() => choose("founder")}>Founder</button>
        <button type="button" className="later" onClick={onClose}>Not now</button>
      </div>
      <p className="problem" role="alert">{problem}</p>
    </dialog>
  );
}

/** The open project's edition, in the top bar. */
export function EditionSelect({ room, edition }: { room: string; edition: Edition | null }) {
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  return (
    <span className="edition-select">
      <label htmlFor={id}>Edition</label>
      <select id={id} value={edition ?? ""} disabled={DEMO} onChange={async (e) => setProblem(await setEdition(room, e.target.value as Edition))}>
        {!edition && <option value="" disabled>Not chosen</option>}
        <option value="work">Work</option>
        <option value="founder">Founder</option>
      </select>
      {problem && <span className="problem" role="alert">{problem}</span>}
    </span>
  );
}
