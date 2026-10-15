// The approvals tray in the top bar: every raised hand, with the full request, and Approve and Deny. It works from the lobby and from every project.
import { useEffect, useRef, useState } from "react";
import type { OfficeState } from "../server/office.ts";
import type { Approval } from "../server/approvals.ts";
import { argsText } from "./approvals.ts";
import { post } from "./post.ts";
import "./approvals.css";

function Hand({ state, approval: a }: { state: OfficeState; approval: Approval }) {
  const who = state.employees[a.sessionId];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function answer(verb: "approve" | "deny") {
    setBusy(true);
    setError(await post(`${verb}/${encodeURIComponent(a.id)}`));
    setBusy(false);
  }
  return (
    <li className="hand" data-tool={a.tool}>
      <p className="who">
        <strong>{who?.name ?? "Someone"}</strong>
        <span className="where">{who ? (state.rooms[who.room]?.name ?? "") : ""}</span>
      </p>
      <p className="tool">{a.tool || "Tool"}</p>
      {/* Text, never HTML: the arguments are whatever the session asked to run. */}
      <pre className="args" aria-label={`${a.tool} arguments`}>{argsText(a.tool, a.input)}</pre>
      <div className="answer">
        <button className="approve" disabled={busy} onClick={() => answer("approve")}>Approve</button>
        <button className="deny" disabled={busy} onClick={() => answer("deny")}>Deny</button>
      </div>
      {error && <p className="problem" role="alert">{error}</p>}
    </li>
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
              {hands.map((a) => <Hand key={a.id} state={state} approval={a} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
