// The Hire dialog: the plugin's roles, read live, a brief, a task name and a model. It hires into the open project.
import { useEffect, useId, useRef, useState } from "react";
import { MODELS } from "../people.ts";
import { TASK_NAME, taskFrom } from "./hire.ts";
import { post } from "./post.ts";
import "./hire.css";

type Role = { id: string; name: string; title: string; description: string; skills: string[]; model: string; working: number };

const DEMO = import.meta.env.MODE === "demo";

/** The plugin's roles for this project, or why they couldn't be read. */
function useRoles(room: string) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (DEMO) return;
    let dead = false;
    fetch(new URL(`roles?room=${encodeURIComponent(room)}`, location.href))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed (${res.status}).`))))
      .then((list) => !dead && setRoles(list))
      .catch((err: Error) => !dead && setError(`Couldn't read the roles. ${err.message}`));
    return () => {
      dead = true;
    };
  }, [room]);
  return { roles, error };
}

export function HireDialog({ room, name, onClose }: { room: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { roles, error: loadError } = useRoles(room);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [task, setTask] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => opener?.focus?.();
  }, []);

  const role = roles?.find((r) => r.id === (roleId ?? roles[0]?.id));
  // The task name follows the brief until it is edited by hand.
  const taskName = task ?? taskFrom(brief);
  const ready = !!role && !!brief.trim() && TASK_NAME.test(taskName) && !busy;

  async function hire() {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const failure = await post("hire", { room, role: role.id, task: taskName, brief: brief.trim(), model: model || null });
    if (failure === null) return onClose();
    setBusy(false);
    setProblem(failure);
  }

  return (
    <dialog
      ref={dialog}
      className="hire"
      aria-labelledby={`${id}-title`}
      onCancel={(e) => (e.preventDefault(), onClose())}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <header>
        <h2 id={`${id}-title`}>Hire into {name}</h2>
        <button type="button" onClick={onClose} aria-label="Close hire dialog">Close</button>
      </header>
      {DEMO ? (
        <p className="note-demo" role="status">Hiring needs a live office; this is a recording.</p>
      ) : loadError ? (
        <p className="problem" role="alert">{loadError}</p>
      ) : !roles ? (
        <p className="loading" role="status">Reading the roles…</p>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), hire())}>
          <fieldset className="roles">
            <legend>Role</legend>
            {roles.map((r) => (
              <label key={r.id} className="role" data-chosen={r.id === role?.id || undefined}>
                <input type="radio" name={`${id}-role`} value={r.id} checked={r.id === role?.id} onChange={() => setRoleId(r.id)} />
                <span className="who">
                  <span className="name">{r.name}</span> <span className="title">{r.title}</span>
                </span>
                <span className="working">{r.working} working</span>
                <span className="what">{r.description}</span>
                <span className="kit">{r.model}{r.skills.length > 0 && `, ${r.skills.join(", ")}`}</span>
              </label>
            ))}
          </fieldset>
          <div className="fields">
            <label htmlFor={`${id}-brief`}>Brief</label>
            <textarea
              id={`${id}-brief`}
              autoFocus
              rows={7}
              maxLength={8000}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), hire())}
              placeholder="Design the login page. Acceptance criteria: ..."
            />
            <label htmlFor={`${id}-task`}>Task name</label>
            <input
              id={`${id}-task`}
              value={taskName}
              onChange={(e) => setTask(e.target.value)}
              aria-describedby={`${id}-task-help`}
              aria-invalid={taskName !== "" && !TASK_NAME.test(taskName)}
              autoComplete="off"
              spellCheck={false}
            />
            <p id={`${id}-task-help`} className="help">Lowercase words joined by hyphens. It names the worktree and its branch.</p>
            <label htmlFor={`${id}-model`}>Model</label>
            <select id={`${id}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{role ? `${role.model} (the role's own)` : "The role's own"}</option>
              {MODELS.filter((m) => m !== role?.model).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button type="submit" disabled={!ready}>{busy ? "Hiring…" : role ? `Hire ${role.name}` : "Hire"}</button>
            <p className="problem" role="alert">{problem}</p>
          </div>
        </form>
      )}
    </dialog>
  );
}
