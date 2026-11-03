// The leftovers card: old untagged containers, asked about once, in the Approvals tray (the commands card's slot).
import { useState } from "react";
import type { LeftoversView as Card } from "../server/gauges.ts";
import { answerLeftovers, kindOf, OPEN, sampleOf, totalOf, type View } from "./leftovers.ts";
import "./leftovers.css";

export function LeftoversView({ card, view, controls }: { card: Card; view: View; controls: { remove: () => void; keep: () => void } }) {
  const busy = view.phase === "busy";
  const noun = card.count === 1 ? "container" : "containers";
  return (
    <article className="leftovers" aria-label="Leftover containers">
      <h3>Leftover containers <span className="count">{card.count}</span></h3>
      <p className="lede">
        Left behind by other projects, not tagged by f1rm. <b>Remove</b> stops the {card.running} running ones and deletes all {card.count}. Images, volumes and everything else stay. You are asked once.
      </p>
      {card.groups.map((g, i) => (
        <details key={g.prefix} open={i === 0 || undefined}>
          <summary>
            <span className="pattern">{g.prefix}</span>
            <span className="kind">{kindOf(g)}</span>
            <span className="sample">{sampleOf(g)}</span>
          </summary>
          <ul className="names">
            {g.names.map((n) => <li key={n}>{n}</li>)}
            {totalOf(g) > g.names.length && <li>and {totalOf(g) - g.names.length} more</li>}
          </ul>
        </details>
      ))}
      {card.moreGroups > 0 && <p className="more">and {card.moreGroups} more groups</p>}
      <div className="answer">
        {/* aria-disabled, not disabled: the focus stays on the button while it works. */}
        <button type="button" className="yes" aria-disabled={busy || undefined} onClick={() => !busy && controls.remove()}>
          {busy ? "Removing…" : view.problem ? "Try again" : `Yes, remove ${card.count} ${noun}`}
        </button>
        <button type="button" className="no" aria-disabled={busy || undefined} onClick={() => !busy && controls.keep()}>Not now, keep them</button>
      </div>
      {view.problem && <p className="problem" role="alert">{view.problem}</p>}
    </article>
  );
}

/** The card with its own answers. `onDone` gets the line to show in its slot once the office has acted; the card is gone by then. */
export function LeftoversCard({ card, onDone }: { card: Card; onDone: (note: string) => void }) {
  const [view, setView] = useState<View>(OPEN);
  // The office's push drops the card before its reply lands, so the line goes to the tray (which stays) from here, not from an effect of the card.
  const set = (v: View) => (setView(v), v.phase === "done" && onDone(v.note!));
  const controls = {
    remove: () => void answerLeftovers("remove", card.fingerprint, set),
    keep: () => void answerLeftovers("keep", card.fingerprint, set),
  };
  return view.phase === "done" ? null : <LeftoversView card={card} view={view} controls={controls} />;
}
