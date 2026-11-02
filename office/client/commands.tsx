// The "Commands for <project>" card: the commands the office derived for a project, ticked as it suggests, approved once by the user. It shows in the top-bar tray and in the PM's panel, from the same state, until approved.
import { useState } from "react";
import type { Cmd } from "../server/projectcmds.ts";
import { approveCommands, commandOf, groupsOf, isOn } from "./commands.ts";
import "./commands.css";

export function CommandsCard({ room, name, list }: { room: string; name: string; list: Cmd[] }) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function approve() {
    setBusy(true);
    setError(await approveCommands(room, list, ticks));
    setBusy(false);
  }
  return (
    <article className="commands" aria-label={`Commands for ${name}`}>
      <h3>Commands for <span className="project">{name}</span></h3>
      <p className="lede">Approve once and this project's hires run these without asking. A command outside the list still asks you, as before.</p>
      {groupsOf(list).map((g) => (
        <fieldset key={g.group} data-group={g.group}>
          <legend>{g.title}</legend>
          <ul>
            {g.items.map((c) => (
              <li key={c.id} data-excluded={c.excluded ? "" : undefined}>
                <label>
                  <input type="checkbox" checked={isOn(c, ticks)} disabled={!!c.excluded || busy} onChange={(e) => setTicks({ ...ticks, [c.id]: e.target.checked })} />
                  <code>{commandOf(c.id)}</code>
                </label>
                {c.excluded && <span className="why">Left out: {c.excluded}</span>}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      <button className="approve" disabled={busy} onClick={approve}>Approve these commands</button>
      {error && <p className="problem" role="alert">{error}</p>}
    </article>
  );
}
