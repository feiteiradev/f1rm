// The office page: the PixiJS scene plus React panels, both rendered from the server's state alone.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OfficeState, Status } from "../server/office.ts";
import { rosterOf } from "./layout.ts";
import { identityOf } from "./people.ts";
import { poseOf, statusCounts } from "./pose.ts";
import { createScene, type Scene } from "./scene.ts";
import "./office.css";

const COUNTERS: [Status, string][] = [["working", "Active"], ["waiting", "Waiting"], ["idle", "Idle"]];
const STATUS_TEXT: Record<Status, string> = { working: "Working", waiting: "Waiting for permission", idle: "Idle", offline: "Offline" };
const IDLE_TEXT = "On a coffee break";

function Counter({ state }: { state: OfficeState }) {
  const counts = statusCounts(state);
  return (
    <ul className="counter" aria-label="Employees by status">
      {COUNTERS.map(([status, label]) => (
        <li key={status} data-status={status}>
          <span className="swatch" aria-hidden />
          <span className="count">{counts[status]}</span>
          {label}
        </li>
      ))}
    </ul>
  );
}

function Panel({ state, id, onClose }: { state: OfficeState; id: string; onClose: () => void }) {
  const e = state.employees[id];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [id]);
  if (!e) return null;
  const { name, role } = identityOf(id);
  const activity = e.status === "offline" ? "None" : e.activity || (e.status === "idle" ? IDLE_TEXT : "None");
  return (
    <aside className="panel" aria-label={`${name}, ${role}`}>
      <header>
        <div>
          <h2>{name}</h2>
          <p className="role">{role}</p>
        </div>
        <button ref={closeRef} onClick={onClose} aria-label="Close panel">
          Close
        </button>
      </header>
      <dl>
        <dt>Room</dt>
        <dd title={e.cwd}>{state.rooms[e.room]?.name}</dd>
        <dt>Status</dt>
        <dd data-status={e.status}>
          <span className="swatch" aria-hidden />
          {STATUS_TEXT[e.status]}
        </dd>
        <dt>Activity</dt>
        <dd className="activity">{activity}</dd>
      </dl>
    </aside>
  );
}

function Office() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [connected, setConnected] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const latest = useRef({ state, selected });
  latest.current = { state, selected };
  const opener = useRef<Element | null>(null);
  // The scene keeps the first render's callback, so this reads only refs and the stable setter.
  const select = (id: string | null) => {
    const open = latest.current.selected;
    if (id && !open) opener.current = document.activeElement;
    setSelected(id);
    if (!id && open) (opener.current as HTMLElement | null)?.focus?.();
  };

  useEffect(() => {
    // The page lives under /<ui token>/, so the socket path inherits the token.
    const url = new URL("ws", location.href);
    url.protocol = "ws:";
    const ws = new WebSocket(url);
    ws.onmessage = (m) => setState(JSON.parse(m.data));
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, []);

  useEffect(() => {
    let dead = false;
    createScene(host.current!, select).then((s) => {
      if (dead) return s.destroy();
      scene.current = s;
      if (latest.current.state) s.update(latest.current.state, latest.current.selected);
    });
    return () => {
      dead = true;
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (state) scene.current?.update(state, selected);
  }, [state, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && select(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const empty = state && Object.keys(state.rooms).length === 0;
  return (
    <>
      <header className="bar">
        <h1>f1rm</h1>
        {!connected && <p className="offline" role="alert">Disconnected. Run <code>f1rm start</code> again and use the new URL.</p>}
        {state && <Counter state={state} />}
      </header>
      <main>
        <div className="scene" ref={host} />
        {!state && <p className="note">Connecting…</p>}
        {empty && <p className="note">The office is empty. Start <code>claude</code> in any terminal and an employee arrives.</p>}
        {state && selected && <Panel state={state} id={selected} onClose={() => select(null)} />}
        {/* The canvas has no accessible tree, so the roster is the keyboard and screen-reader way in. */}
        <ul className="roster">
          {state &&
            rosterOf(state).map((e) => {
              const { name, role } = identityOf(e.sessionId);
              return (
                <li key={e.sessionId}>
                  <button data-pose={poseOf(e)} onClick={() => select(e.sessionId)}>
                    {name}, {role}, {state.rooms[e.room]?.name}, {STATUS_TEXT[e.status]}
                  </button>
                </li>
              );
            })}
        </ul>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Office />);
