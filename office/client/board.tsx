// A room's board as text: the panel the whiteboard opens, and the keyboard and screen-reader way in. Board text is only ever a React text child.
import { useEffect, useRef } from "react";
import type { OfficeState } from "../server/office.ts";
import { boardSummary } from "./board.ts";
import "./board.css";

export function BoardPanel({ state, id, onClose }: { state: OfficeState; id: string; onClose: () => void }) {
  const rows = state.boards?.[id] ?? [];
  const name = state.rooms[id]?.name ?? "Room";
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [id]);
  return (
    <aside className="board-panel" aria-label={`Board, ${name}`}>
      <header>
        <div>
          <h2>{name} board</h2>
          <p className="summary">{boardSummary(rows)}</p>
        </div>
        <button ref={closeRef} onClick={onClose} aria-label="Close board">
          Close
        </button>
      </header>
      {rows.length > 0 && (
        <div className="rows">
          <table>
            <thead>
              <tr>
                {["Id", "Status", "Owner", "Branch", "Task"].map((h) => (
                  <th key={h} scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} data-board-status={r.status}>
                  <td>{r.id}</td>
                  <td><span className="chip" aria-hidden />{r.status}</td>
                  <td>{r.owner}</td>
                  <td>{r.branch}</td>
                  <td>{r.task}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}

/** One button per room, out of sight until focused, like the roster. */
export function BoardList({ state, onOpen }: { state: OfficeState; onOpen: (id: string) => void }) {
  return (
    <ul className="boards" aria-label="Boards">
      {Object.values(state.rooms).map((room) => (
        <li key={room.id}>
          <button onClick={() => onOpen(room.id)}>
            Board, {room.name}: {boardSummary(state.boards?.[room.id] ?? [])}
          </button>
        </li>
      ))}
    </ul>
  );
}
