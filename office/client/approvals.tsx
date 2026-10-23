// The permission card: a raised hand with the full request and its answers. It shows in the top-bar tray and on the hire's desk, both from the same state and through the same component.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OfficeState } from "../server/office.ts";
import type { Approval } from "../server/approvals.ts";
import { cardOf, handsOf } from "./approvals.ts";
import { post } from "./post.ts";
import "./approvals.css";

type Verb = "approve" | "deny" | "always";

export function HandCard({ state, approval: a }: { state: OfficeState; approval: Approval }) {
  const card = cardOf(state, a);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function answer(verb: Verb) {
    setBusy(true);
    setError(await post(`${verb}/${encodeURIComponent(a.id)}`));
    setBusy(false);
  }
  const grant = `grant-${a.id}`;
  return (
    <article className="hand" data-tool={a.tool} aria-label={`${card.who} asks to use ${card.tool}`}>
      <p className="who">
        <strong>{card.who}</strong>
        <span className="where">{card.project}</span>
      </p>
      <p className="tool">{card.tool}</p>
      {/* The hire's last words can arrive after the card; the slot is there from the start, so nothing under it moves. */}
      <p className="why" aria-live="polite">{card.why && <><span className="why-label">Why </span>{card.why}</>}</p>
      {/* Text, never HTML: the arguments are whatever the session asked to run. */}
      <pre className="args" aria-label={`${card.tool} arguments`}>{card.args}</pre>
      <div className="answer">
        <button className="approve" disabled={busy} onClick={() => answer("approve")}>Approve once</button>
        <button className="deny" disabled={busy} onClick={() => answer("deny")}>Deny</button>
      </div>
      {card.always && (
        <div className="always">
          <button disabled={busy} aria-describedby={grant} onClick={() => answer("always")}>Always for this project</button>
          <p id={grant} className="grant">{card.always.note}</p>
        </div>
      )}
      {error && <p className="problem" role="alert">{error}</p>}
    </article>
  );
}

/** The card on a hire's desk: opens on a click of the raised-hand character, closes on Escape (the page's key handler) or a click outside. Focus moves into it and returns to where it was. */
export function DeskCard({ state, id, at, onClose }: { state: OfficeState; id: string; at: { x: number; y: number }; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const hands = handsOf(state, id);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const away = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && onClose();
    addEventListener("mousedown", away);
    return () => {
      removeEventListener("mousedown", away);
      if (before?.isConnected) before.focus?.();
    };
  }, []);
  const who = state.employees[id]?.name ?? "Someone";
  return (
    <div className="desk-card" ref={root} tabIndex={-1} role="dialog" aria-label={`Permission request from ${who}`} style={{ "--x": `${at.x}px`, top: at.y } as CSSProperties}>
      {hands.map((a) => <HandCard key={a.id} state={state} approval={a} />)}
    </div>
  );
}

export function Tray({ state }: { state: OfficeState }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hands = state.approvals;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", away);
    addEventListener("keydown", key);
    return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
  }, [open]);
  // A recording has no broker, so no approvals field and no tray.
  if (!hands) return null;
  return (
    <div className="tray" ref={root}>
      <button className="tray-button" data-waiting={hands.length > 0 || undefined} aria-expanded={open} onClick={() => setOpen(!open)}>
        Approvals
        <span className="badge" aria-label={`${hands.length} waiting`}>{hands.length}</span>
      </button>
      {open && (
        <section className="tray-panel" aria-label="Approvals">
          {hands.length === 0 ? (
            <p className="none">No one is waiting for permission.</p>
          ) : (
            <ul>
              {hands.map((a) => <li key={a.id}><HandCard state={state} approval={a} /></li>)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
