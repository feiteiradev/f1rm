// Jump: the panel's button and the ⌘K palette. Both ask the server to bring an employee's terminal forward.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OfficeState } from "../server/office.ts";
import { rosterOf } from "./layout.ts";
import { roleTitle } from "../people.ts";
import { search, type Entry } from "./search.ts";
import "./jump.css";

/** Null when the terminal came forward, otherwise why it didn't. */
async function jumpTo(id: string): Promise<string | null> {
  try {
    // The page lives under /<ui token>/, so a relative URL carries the token.
    const res = await fetch(new URL(`jump/${encodeURIComponent(id)}`, location.href), { method: "POST" });
    if (res.ok) return null;
    return (await res.json().catch(() => null))?.error ?? `Jump failed (${res.status}).`;
  } catch {
    return "The office isn't reachable.";
  }
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

export function JumpButton({ id }: { id: string }) {
  const { error, busy, jump } = useJump();
  return (
    <div className="jump">
      <button onClick={() => jump(id)} disabled={busy}>Jump to terminal</button>
      <p role="status">{error}</p>
    </div>
  );
}

export function Palette({ state }: { state: OfficeState }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { error, busy, jump, clear } = useJump();
  const opener = useRef<Element | null>(null);
  const listId = useId();

  const entries = useMemo<Entry[]>(
    () => rosterOf(state).map((e) => ({ id: e.sessionId, name: e.name, role: roleTitle(e.role), room: state.rooms[e.room]?.name ?? "", task: e.activity })),
    [state],
  );
  const results = useMemo(() => search(entries, query), [entries, query]);
  const current = results[Math.min(active, results.length - 1)];
  const optionId = (id: string) => `${listId}-${id}`;

  function show() {
    opener.current = document.activeElement;
    setQuery("");
    setActive(0);
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
    if (await jump(id)) hide();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && results.length) {
      e.preventDefault();
      setActive((Math.min(active, results.length - 1) + step + results.length) % results.length);
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
                setActive(0);
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
                    onMouseMove={() => setActive(results.indexOf(r))}
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
