// The office page, rendered from the server's state alone: a lobby with a door per project, and one project's office full screen at a time.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OfficeState, Status } from "../server/office.ts";
import { rosterOf, scaleFor } from "./layout.ts";
import { DOOR, hashFor, layoutLobby, projectState, roomFromHash } from "./lobby.ts";
import { createLobby, type Lobby as LobbyScene } from "./lobby-scene.ts";
import { AskBox, History, useHistory } from "./ask.tsx";
import { BoardList, BoardPanel } from "./board.tsx";
import { JumpButton, Palette } from "./jump.tsx";
import { TellBox } from "./tell.tsx";
import { roleTitle } from "../people.ts";
import type { HistoryEntry } from "./history.ts";
import { poseOf, statusCounts } from "./pose.ts";
import { createScene, type Scene } from "./scene.ts";
import "./office.css";
import "./lobby.css";

const COUNTERS: [Status, string][] = [["working", "Active"], ["waiting", "Waiting"], ["idle", "Idle"]];
const STATUS_TEXT: Record<Status, string> = { working: "Working", waiting: "Waiting for permission", idle: "Idle", offline: "Offline" };
const IDLE_TEXT = "On a coffee break";
const NOBODY: OfficeState = { rooms: {}, employees: {}, interns: {} };

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

function Panel({ state, id, entries, onAsk, onTell, onClose }: { state: OfficeState; id: string; entries: HistoryEntry[]; onAsk: (question: string) => void; onTell: (message: string) => void; onClose: () => void }) {
  const e = state.employees[id];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [id]);
  if (!e) return null;
  const { name } = e, role = roleTitle(e.role);
  const interns = Object.values(state.interns).filter((i) => i.parent === id);
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
        {e.title && (
          <>
            <dt>Session</dt>
            <dd>{e.title}</dd>
          </>
        )}
        <dt>Room</dt>
        <dd title={e.cwd}>{state.rooms[e.room]?.name}</dd>
        <dt>Status</dt>
        <dd data-status={e.status}>
          <span className="swatch" aria-hidden />
          {STATUS_TEXT[e.status]}
        </dd>
        <dt>Activity</dt>
        <dd className="activity">{activity}</dd>
        {interns.length > 0 && (
          <>
            <dt>Interns</dt>
            <dd>{interns.map((i) => i.type || "Sub-agent").join(", ")}</dd>
          </>
        )}
      </dl>
      <JumpButton key={id} id={id} />
      <AskBox key={id} onAsk={onAsk} />
      <TellBox key={id} name={name} onTell={onTell} />
      <History entries={entries} />
    </aside>
  );
}

/** One project's office, full screen: its scene, employee panel, whiteboard panel and keyboard roster. `state` is already that project's slice. */
function Project({ state }: { state: OfficeState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const { history, ask, tell } = useHistory();
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
    let dead = false;
    createScene(host.current!, select, setBoard).then((s) => {
      if (dead) return s.destroy();
      scene.current = s;
      s.update(latest.current.state, latest.current.selected);
    });
    return () => {
      dead = true;
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.update(state, selected);
  }, [state, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && select(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="scene" ref={host} />
      {selected && <Panel state={state} id={selected} entries={history[selected] ?? []} onAsk={(q) => ask(selected, q)} onTell={(m) => tell(selected, m)} onClose={() => select(null)} />}
      {board && state.rooms[board] && <BoardPanel state={state} id={board} onClose={() => setBoard(null)} />}
      <BoardList state={state} onOpen={setBoard} />
      {/* The canvas has no accessible tree, so the roster is the keyboard and screen-reader way in. */}
      <ul className="roster">
        {rosterOf(state).map((e) => {
          const interns = Object.values(state.interns).filter((i) => i.parent === e.sessionId).length;
          return (
            <li key={e.sessionId}>
              <button data-pose={poseOf(e)} onClick={() => select(e.sessionId)}>
                {e.name}, {roleTitle(e.role)}, {state.rooms[e.room]?.name}, {STATUS_TEXT[e.status]}
                {interns > 0 && `, ${interns} ${interns === 1 ? "intern" : "interns"}`}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The lobby: the hallway scene with one real button per door laid over it, so doors are clickable, focusable and named. */
function Lobby({ state, onOpen }: { state: OfficeState; onOpen: (roomId: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<LobbyScene | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let dead = false;
    createLobby(host.current!).then((s) => {
      if (dead) return s.destroy();
      scene.current = s;
      s.update(latest.current);
    });
    const watch = new ResizeObserver(() => setSize({ w: host.current!.clientWidth, h: host.current!.clientHeight }));
    watch.observe(host.current!);
    return () => {
      dead = true;
      watch.disconnect();
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.update(state);
  }, [state]);

  const scale = scaleFor(size.w);
  const { doors } = layoutLobby(state, Math.floor(size.w / scale), Math.floor(size.h / scale));
  return (
    <div className="scene">
      <div className="hall">
        <div className="hall-art" ref={host} />
        <ul className="doors" aria-label="Projects">
          {doors.map((d) => (
            <li key={d.room.id}>
              <button
                className="door"
                data-room={d.room.id}
                data-empty={d.count === 0 || undefined}
                data-waiting={d.waiting || undefined}
                style={{ left: d.x * scale, top: d.y * scale, width: DOOR.w * scale, height: DOOR.h * scale }}
                onClick={() => onOpen(d.room.id)}
              >
                <span className="plaque">
                  <span className="name" title={d.room.name}>{d.room.name}</span>
                  <span className="meta">
                    <span className="people">{d.count === 0 ? "empty" : `${d.count} inside`}</span>
                    {d.waiting && <span className="wait"><span className="swatch" aria-hidden /> waiting</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The open project from the URL fragment. Each move pushes a history entry, so the browser's Back and Forward walk between lobby and projects. */
function useRoute() {
  const [open, setOpen] = useState(() => roomFromHash(location.hash));
  useEffect(() => {
    const sync = () => setOpen(roomFromHash(location.hash));
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const go = (roomId: string | null) => {
    if (roomId === roomFromHash(location.hash)) return;
    history.pushState(null, "", location.pathname + location.search + hashFor(roomId));
    setOpen(roomId);
  };
  return [open, go] as const;
}

function Office() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [connected, setConnected] = useState(true);
  const [open, go] = useRoute();
  const left = useRef<string | null>(null);

  useEffect(() => {
    // The page lives under /<ui token>/, so the socket path inherits the token.
    const url = new URL("ws", location.href);
    url.protocol = "ws:";
    const ws = new WebSocket(url);
    ws.onmessage = (m) => setState(JSON.parse(m.data));
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, []);

  // A project the office doesn't have (an old link, or everyone left and the server forgot it) shows the lobby with a note.
  const inside = open !== null && state?.rooms[open] ? open : null;
  const view = inside && state ? projectState(state, inside) : state;
  useEffect(() => {
    // Keyboard focus follows the move: to the way back on entering, to the door just left on returning.
    if (inside) document.querySelector<HTMLElement>(".back")?.focus();
    else if (left.current) [...document.querySelectorAll<HTMLElement>(".door")].find((d) => d.dataset.room === left.current)?.focus();
    left.current = inside;
  }, [inside]);

  const empty = state && Object.keys(state.rooms).length === 0;
  return (
    <>
      <header className="bar">
        <h1>f1rm</h1>
        {open !== null && (
          <button className="back" onClick={() => go(null)}>
            <span aria-hidden>← </span>Lobby
          </button>
        )}
        {inside && state && <p className="crumb">{state.rooms[inside].name}</p>}
        {!connected && <p className="offline" role="alert">Disconnected. Run <code>f1rm start</code> again and use the new URL.</p>}
        {state && <Palette state={state} onOpen={go} />}
        {view && <Counter state={view} />}
      </header>
      <main>
        {inside && view ? <Project key={inside} state={view} /> : <Lobby state={state ?? NOBODY} onOpen={go} />}
        {!state && <p className="note">Connecting…</p>}
        {empty && <p className="note">The office is empty. Start <code>claude</code> in any terminal and an employee arrives.</p>}
        {state && open !== null && !inside && !empty && <p className="note low">That project isn't in the office right now.</p>}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Office />);
