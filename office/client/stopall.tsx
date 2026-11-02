// The top bar's pause control: Stop all (asks once), or Resume all while any project is paused. Visible in the lobby and inside a project.
import { useEffect, useMemo, useRef, useState } from "react";
import { escapeCancels, IDLE, keepsStatus, stopAllControls, type Controls, type View } from "./stopall.ts";
import "./stopall.css";

export function StopAllView({ paused, view, controls }: { paused: string[]; view: View; controls: Controls }) {
  const main = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const was = useRef(view.phase);
  const settledAt = useRef(0);
  // Focus follows the question: to Confirm when it opens, back to the main button when it closes (the confirm buttons are gone by then).
  useEffect(() => {
    if (view.phase === "confirm") confirm.current?.focus();
    else if (was.current === "confirm") main.current?.focus();
    if (view.phase === "idle" && was.current !== "idle") settledAt.current = Date.now();
    was.current = view.phase;
  }, [view.phase]);
  // Escape closes the question from anywhere on the page, and the listener goes with the question.
  useEffect(() => {
    if (view.phase !== "confirm") return;
    const onKey = (e: KeyboardEvent) => escapeCancels(view, e.key) && controls.cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.phase, controls]);
  // A project paused or resumed from outside (`f1rm pause`, the schedule) makes the last result stale; this page's own action keeps its words.
  const key = paused.join("\n");
  useEffect(() => {
    if (view.status && !keepsStatus(view, Date.now() - settledAt.current)) controls.clear();
  }, [key]);
  const busy = view.phase === "stopping" || view.phase === "resuming";
  return (
    <span className="stopall">
      {view.phase === "confirm" ? (
        <span role="group" aria-label="Confirm stopping all projects" className="ask">
          <span>Stop all projects?</span>
          <button type="button" ref={confirm} onClick={controls.confirm}>Confirm</button>
          <button type="button" onClick={controls.cancel}>Cancel</button>
        </span>
      ) : (
        // One button for every state but the question, so the focus stays on it while it works. aria-disabled, not disabled: a disabled button drops the focus.
        <button type="button" ref={main} className="hire-btn" aria-disabled={busy || undefined} onClick={() => !busy && (paused.length ? controls.resume() : controls.ask())}>
          {view.phase === "stopping" ? "Stopping…" : view.phase === "resuming" ? "Resuming…" : paused.length ? "Resume all" : "Stop all"}
        </button>
      )}
      <span className="status" role="status" data-failed={view.failed || undefined}>{view.status}</span>
    </span>
  );
}

/** `paused` is the snapshot's list of paused projects; the page needs only whether it is empty. The recording has no office to stop. */
export function StopAll({ paused }: { paused: string[] }) {
  const [view, setView] = useState(IDLE);
  const controls = useMemo(() => stopAllControls(setView), []);
  if (import.meta.env.MODE === "demo") return null;
  return <StopAllView paused={paused} view={view} controls={controls} />;
}
