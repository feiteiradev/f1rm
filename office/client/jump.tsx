// Jump: the panel's button and the ⌘K palette. Both ask the server to bring an employee's terminal forward.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OfficeState } from "../server/office.ts";
import { rosterOf } from "./layout.ts";
import { roleTitle } from "../people.ts";
import { post } from "./post.ts";
import { search, type Entry } from "./search.ts";
import "./jump.css";

/** Null when the terminal came forward, otherwise why it didn't. */
async function jumpTo(id: string): Promise<string | null> {
  if (import.meta.env.MODE === "demo") return "Jump needs a live office; this is a recording.";
  return post(`jump/${encodeURIComponent(id)}`);
}

/** Runs a jump and tracks its outcome, for a button or the palette. */
function useJump() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function jump(id: string) {
    setBusy(true);
    setError(null);
    const failure = await jumpTo(id);
    setBusy(false);
    setError(failure);
    return failure === null;
  }
  return { error, busy, jump, clear: () => setError(null) };
}

export function JumpButton({ id, label = "Jump to terminal" }: { id: string; label?: string }) {
  const { error, busy, jump } = useJump();
  return (
    <div className="jump">
      <button onClick={() => jump(id)} disabled={busy}>{label}</button>
      <p role="status">{error}</p>
    </div>
  );
}

export function Palette({ state, onOpen }: { state: OfficeState; onOpen: (roomId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const { error, busy, jump, clear } = useJump();
  const opener = useRef<Element | null>(null);
  const listId = useId();

  const entries = useMemo<Entry[]>(
    () => rosterOf(state).map((e) => ({ id: e.sessionId, name: e.name, role: roleTitle(e.role), room: state.rooms[e.room]?.name ?? "", task: e.activity, title: e.title })),
    [state],
  );
  const results = useMemo(() => search(entries, query), [entries, query]);
  // By id, not position: the list changes as the office does, and Enter must go to who was highlighted.
  const current = results.find((r) => r.id === activeId) ?? results[0];
  const optionId = (id: string) => `${listId}-${id}`;

  function show() {
    opener.current = document.activeElement;
    setQuery("");
    setActiveId(null);
    clear();
    setOpen(true);
  }
  function hide() {
    setOpen(false);
    (opener.current as HTMLElement | null)?.focus?.();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) hide();
        else show();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (open && current) document.getElementById(optionId(current.id))?.scrollIntoView({ block: "nearest" });
  }, [open, current?.id]);

  async function go(id: string) {
    if (busy) return;
    // Someone in another project: that project's office opens first, wherever the jump itself ends up.
    onOpen(state.employees[id].room);
    if (await jump(id)) hide();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && results.length) {
      e.preventDefault();
      setActiveId(results[(results.indexOf(current) + step + results.length) % results.length].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) go(current.id);
    } else if (e.key === "Escape") {
      // Closes only the palette; the page's own Escape handler must not also close the panel behind it.
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  return (
    <>
      <button className="palette-hint" onClick={show}>
        Jump to… <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className="palette-backdrop" onMouseDown={hide}>
          <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to an employee" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={current ? optionId(current.id) : undefined}
              aria-label="Name, role, room or task"
              placeholder="Name, role, room or task"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveId(null);
                clear();
              }}
              onKeyDown={onKeyDown}
            />
            <ul id={listId} role="listbox" aria-label="Employees">
              {results.map((r) => {
                const e = state.employees[r.id];
                return (
                  <li
                    key={r.id}
                    id={optionId(r.id)}
                    role="option"
                    aria-selected={r === current}
                    data-status={e.status}
                    onMouseMove={() => setActiveId(r.id)}
                    onClick={() => go(r.id)}
                  >
                    <span className="swatch" aria-hidden />
                    <span className="who">{r.name}</span>
                    <span className="where">{r.role}, {r.room}</span>
                    <span className="task">{r.task || e.status}</span>
                  </li>
                );
              })}
            </ul>
            {results.length === 0 && <p className="none">{entries.length ? "No one matches." : "No one is in the office."}</p>}
            <p className="problem" role="status">{error}</p>
          </div>
        </div>
      )}
    </>
  );
}
