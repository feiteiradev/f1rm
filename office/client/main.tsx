// The office page, rendered from the server's state alone: a lobby with a door per project, and one project's office full screen at a time.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OfficeState, Status } from "../server/office.ts";
import { rosterOf, scaleFor, selectionIn } from "./layout.ts";
import { DOOR, hashFor, layoutLobby, projectState, roomFromHash } from "./lobby.ts";
import { createLobby, type Lobby as LobbyScene } from "./lobby-scene.ts";
import { Tray } from "./approvals.tsx";
import { AskBox, History, useHistory } from "./ask.tsx";
import { BoardList, BoardPanel } from "./board.tsx";
import { EditionAsk, EditionSelect } from "./edition.tsx";
import { HireDialog } from "./hire.tsx";
import { JumpButton, OnEnded, Palette } from "./jump.tsx";
import { ENDED, without } from "./jump.ts";
import { connectLive, OFFICE_DOWN, whyDown } from "./live.ts";
import { LetGo } from "./letgo.tsx";
import { post } from "./post.ts";
import { InternBox, TellBox } from "./tell.tsx";
import { roleTitle, teamOf } from "../people.ts";
import type { HistoryEntry } from "./history.ts";
import { poseOf, statusCounts } from "./pose.ts";
import { createScene, type Scene } from "./scene.ts";
import "./office.css";
import "./lobby.css";

const COUNTERS: [Status, string][] = [["working", "Active"], ["waiting", "Waiting"], ["idle", "Idle"]];
const STATUS_TEXT: Record<Status, string> = { working: "Working", waiting: "Waiting for permission", idle: "Idle", offline: "Offline" };
const IDLE_TEXT = "On a coffee break";
// The PM is the one you talk to: when its turn ends, the next move is yours.
const statusText = (e: { role: string | null; status: Status }) => (e.role === "pm" && e.status === "idle" ? "Waiting for you" : STATUS_TEXT[e.status]);
const DEMO = import.meta.env.MODE === "demo";
const NOBODY: OfficeState = { rooms: {}, employees: {}, interns: {} };
/** The teams with a lead in the room, which a hire can join. */
const teamsIn = (state: OfficeState, room: string) =>
  [...new Set(Object.values(state.employees).filter((e) => e.room === room && e.role === "lead").map(teamOf).filter((t) => t !== null))].sort();

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

function Panel({ state, id, entries, onAsk, onTell, onIntern, onClose }: { state: OfficeState; id: string; entries: HistoryEntry[]; onAsk: (question: string) => void; onTell: (message: string) => void; onIntern: (subtask: string) => void; onClose: () => void }) {
  const e = state.employees[id];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [id]);
  if (!e) return null;
  const { name } = e, role = roleTitle(e.role);
  const interns = Object.values(state.interns).filter((i) => i.parent === id);
  const team = teamOf(e);
  const pm = e.role === "pm";
  const idle = pm ? "Its last message is in its terminal. Press Talk to answer." : IDLE_TEXT;
  const activity = e.status === "offline" ? "None" : e.activity || (e.status === "idle" ? idle : "None");
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
        {team && (
          <>
            <dt>Team</dt>
            <dd>{team}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd data-status={e.status}>
          <span className="swatch" aria-hidden />
          {statusText(e)}
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
      <JumpButton id={id} label={pm ? "Talk" : undefined} />
      <LetGo id={id} name={name} />
      <AskBox onAsk={onAsk} />
      <TellBox name={name} onTell={onTell} />
      <InternBox name={name} onIntern={onIntern} />
      <History entries={entries} />
    </aside>
  );
}

/** One project's office, full screen: its scene, employee panel, whiteboard panel and keyboard roster. `state` is already that project's slice. */
function Project({ room, state, onHire }: { room: string; state: OfficeState; onHire: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pmNote, setPmNote] = useState<string | null>(null);
  const starting = useRef(false);
  const hasPm = Object.values(state.employees).some((e) => e.role === "pm");
  useEffect(() => {
    if (!hasPm) return;
    starting.current = false;
    setPmNote(null);
  }, [hasPm]);
  // A tap on the empty table. Taps while a PM is on its way open no second tab: it takes a few seconds to arrive, and the server refuses a second PM only once the first has.
  // ponytail: a PM slower than 30 s to arrive can be started twice; track the tab itself if that shows up.
  async function startPm() {
    if (DEMO) return setPmNote("Starting a PM needs a live office; this is a recording.");
    if (starting.current) return;
    starting.current = true;
    setPmNote("Starting a PM in a new iTerm tab…");
    const error = await post("start-pm", { room });
    if (error) {
      starting.current = false;
      return setPmNote(error);
    }
    setTimeout(() => {
      starting.current = false;
      setPmNote(null);
    }, 30_000);
  }
  const [board, setBoard] = useState<{ id: string; team?: string } | null>(null);
  const openBoard = (id: string, team?: string) => setBoard({ id, team });
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
    // The opener can be the roster button of the very employee who just left; focus then goes to the next one rather than to the page.
    if (!id && open) ((opener.current?.isConnected ? opener.current : document.querySelector(".roster button") ?? document.querySelector(".back")) as HTMLElement | null)?.focus?.();
  };

  useEffect(() => {
    let dead = false;
    createScene(host.current!, select, openBoard, onHire, startPm).then((s) => {
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

  // The employee left (an ended session, or the office's next push): the panel closes and focus goes back.
  useEffect(() => {
    if (selected && selectionIn(state, selected) === null) select(null);
  }, [state, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && select(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="scene" ref={host} />
      {selected && <Panel key={selected} state={state} id={selected} entries={history[selected] ?? []} onAsk={(q) => ask(selected, q)} onTell={(m) => tell(selected, m)} onIntern={(t) => tell(selected, t, true)} onClose={() => select(null)} />}
      {board && state.rooms[board.id] && <BoardPanel key={`${board.id}/${board.team ?? ""}`} state={state} id={board.id} team={board.team} onClose={() => setBoard(null)} />}
      <BoardList state={state} onOpen={openBoard} />
      {pmNote && <p className="note low pm-note" role="status">{pmNote}</p>}
      {/* The canvas has no accessible tree, so the roster is the keyboard and screen-reader way in. */}
      <ul className="roster">
        {rosterOf(state).map((e) => {
          const interns = Object.values(state.interns).filter((i) => i.parent === e.sessionId).length;
          return (
            <li key={e.sessionId}>
              <button data-pose={poseOf(e)} onClick={() => select(e.sessionId)}>
                {e.name}, {roleTitle(e.role)}, {state.rooms[e.room]?.name}, {statusText(e)}
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
                    {state.editions?.[d.room.id] && (
                      <span className="edition" data-edition={state.editions[d.room.id]}>{state.editions[d.room.id] === "founder" ? "Founder" : "Work"}</span>
                    )}
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
  // Why the connection is down, or null while it is up.
  const [down, setDown] = useState<string | null>(null);
  const [open, go] = useRoute();
  // The socket handler is set up once, so it calls the latest `go` through a ref.
  const goRef = useRef(go);
  goRef.current = go;
  const [hiring, setHiring] = useState(false);
  // "Not now" on the edition question lasts until the project is left.
  const [notNow, setNotNow] = useState<string | null>(null);
  const left = useRef<string | null>(null);

  useEffect(() => {
    // The page lives under /<ui token>/, so the socket path inherits the token.
    const url = new URL("ws", location.href);
    url.protocol = "ws:";
    // The office's first message on every connection is the whole state, so coming back reloads it.
    return connectLive({
      url: url.href,
      onUp: (up) => {
        setDown(up ? null : OFFICE_DOWN);
        // One look says whether the office is gone or this link is no longer one it knows; a reply after the office is back changes nothing.
        if (!up) whyDown().then((why) => setDown((d) => (d === null ? null : why)));
      },
      onMessage: (message) => {
        // `f1rm` in a project's folder: this page shows that project, as if its door was clicked.
        if (typeof message.show === "string") return goRef.current(message.show);
        setState(message);
      },
    });
  }, []);

  // A Jump found the session over: the employee leaves now (the office's next push says the same) and a toast says why.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Stable, so the Provider doesn't re-render every Jump consumer on each push.
  const onEnded = useCallback((id: string) => {
    setState((s) => s && without(s, id));
    setToast(ENDED);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // A project the office doesn't have (an old link, or everyone left and the server forgot it) shows the lobby with a note.
  const inside = open !== null && state?.rooms[open] ? open : null;
  const view = inside && state ? projectState(state, inside) : state;
  useEffect(() => {
    // Keyboard focus follows the move: to the way back on entering, to the door just left on returning.
    if (inside) document.querySelector<HTMLElement>(".back")?.focus();
    else if (left.current) [...document.querySelectorAll<HTMLElement>(".door")].find((d) => d.dataset.room === left.current)?.focus();
    left.current = inside;
    if (inside !== notNow) setNotNow(null);
  }, [inside]);

  const empty = state && Object.keys(state.rooms).length === 0;
  return (
    <OnEnded.Provider value={onEnded}>
      <header className="bar">
        <h1>f1rm</h1>
        {open !== null && (
          <button className="back" onClick={() => go(null)}>
            <span aria-hidden>← </span>Lobby
          </button>
        )}
        {inside && state && <p className="crumb">{state.rooms[inside].name}</p>}
        {inside && <button className="hire-btn" onClick={() => setHiring(true)}>Hire</button>}
        {inside && state?.editions && <EditionSelect key={inside} room={inside} edition={state.editions[inside] ?? null} />}
        {down && <p className="offline" role="alert">{down.split("`").map((t, i) => (i % 2 ? <code key={i}>{t}</code> : t))}</p>}
        {state && <Palette state={state} onOpen={go} />}
        {state && <Tray state={state} />}
        {view && <Counter state={view} />}
      </header>
      <main>
        {inside && view ? <Project key={inside} room={inside} state={view} onHire={() => setHiring(true)} /> : <Lobby state={state ?? NOBODY} onOpen={go} />}
        {!state && <p className="note">Connecting…</p>}
        {empty && <p className="note">The office is empty. Start <code>claude</code> in any terminal and an employee arrives.</p>}
        {state && open !== null && !inside && !empty && <p className="note low">That project isn't in the office right now.</p>}
      </main>
      {inside && state?.editions && !state.editions[inside] && notNow !== inside && !hiring && !DEMO && (
        <EditionAsk key={inside} room={inside} name={state.rooms[inside].name} onClose={() => setNotNow(inside)} />
      )}
      {toast && <p className="note low pm-note toast" role="status">{toast}</p>}
      {hiring && inside && state && <HireDialog key={inside} room={inside} name={state.rooms[inside].name} pm={Object.values(state.employees).find((e) => e.room === inside && e.role === "pm") ?? null} teams={teamsIn(state, inside)} onClose={() => setHiring(false)} />}
    </OnEnded.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Office />);
