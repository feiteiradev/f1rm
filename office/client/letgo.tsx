// Let go: stops and removes a background hire's session. The button is there only when `claude agents` lists the session as background.
import { useEffect, useState } from "react";
import { post } from "./post.ts";
import "./letgo.css";

function useBackground(id: string) {
  const [background, setBackground] = useState(false);
  useEffect(() => {
    if (import.meta.env.MODE === "demo") return;
    let dead = false;
    fetch(new URL(`background/${encodeURIComponent(id)}`, location.href))
      .then((res) => res.json())
      .then((reply: { background?: boolean }) => !dead && setBackground(reply.background === true))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [id]);
  return background;
}

export function LetGo({ id, name }: { id: string; name: string }) {
  const background = useBackground(id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!background) return null;

  async function letGo() {
    setBusy(true);
    setProblem(null);
    // On success the office drops the employee and this panel goes with it.
    const error = await post(`letgo/${encodeURIComponent(id)}`, { confirm: true });
    setBusy(false);
    if (error) (setProblem(error), setConfirming(false));
  }

  return (
    <section className="letgo" aria-label="Let go">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)}>Let go</button>
      ) : (
        <div className="confirm" role="group" aria-label={`Confirm letting ${name} go`}>
          <p>Let {name} go? This stops the session and removes it and its worktree. Claude refuses if the worktree has uncommitted or unpushed work.</p>
          <button type="button" onClick={letGo} disabled={busy}>{busy ? "Letting go…" : "Yes, let go"}</button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </div>
      )}
      <p className="problem" role="alert">{problem}</p>
    </section>
  );
}
