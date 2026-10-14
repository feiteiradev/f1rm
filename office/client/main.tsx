// Tracer page: rooms and their employees, live from the server's WebSocket.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OfficeState } from "../server/office.ts";

function Office() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    // The page lives under /<ui token>/, so the socket path inherits the token.
    const url = new URL("ws", location.href);
    url.protocol = "ws:";
    const ws = new WebSocket(url);
    ws.onmessage = (m) => setState(JSON.parse(m.data));
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, []);

  if (!connected) return <p>Disconnected. Run <code>f1rm start</code> again and use the new URL.</p>;
  if (!state) return <p>Connecting…</p>;

  const employees = Object.values(state.employees);
  const rooms = Object.values(state.rooms).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <main>
      <h1>f1rm</h1>
      {rooms.length === 0 && <p>No sessions yet. Start <code>claude</code> anywhere.</p>}
      {rooms.map((room) => (
        <section key={room.id}>
          <h2 title={room.id}>{room.name}</h2>
          <ul>
            {employees
              .filter((e) => e.room === room.id)
              .map((e) => (
                <li key={e.sessionId} className={e.status} title={e.cwd}>
                  {e.sessionId.slice(0, 8)} · {e.status}
                  {e.activity && ` · ${e.activity}`}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Office />);
