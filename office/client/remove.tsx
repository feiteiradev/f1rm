// The Remove button on an empty door. The first click arms it, a second within a few seconds removes the door.
import { useEffect, useState } from "react";
import { CONFIRM_MS, isConfirm, removeDoor } from "./remove.ts";

const DEMO = import.meta.env.MODE === "demo";

/** `onProblem` gets why the office refused. On success the office's next push drops the door and this button with it. */
export function RemoveDoor({ roomId, name, style, onProblem }: { roomId: string; name: string; style: React.CSSProperties; onProblem: (problem: string | null) => void }) {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  async function click() {
    onProblem(null);
    if (!isConfirm(armedAt, Date.now())) return setArmedAt(Date.now());
    setArmedAt(null);
    if (DEMO) return onProblem("Doors are removed in a live office; this is a recording.");
    setBusy(true);
    const error = await removeDoor(roomId);
    setBusy(false);
    if (error) onProblem(error);
  }

  return (
    <button
      type="button"
      className="remove"
      data-armed={armedAt !== null || undefined}
      style={style}
      disabled={busy}
      aria-label={armedAt === null ? `Remove ${name}` : `Confirm: remove ${name} and forget its settings`}
      onClick={click}
    >
      {busy ? "Removing…" : armedAt === null ? "Remove" : "Sure?"}
    </button>
  );
}
