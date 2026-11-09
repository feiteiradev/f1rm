// The top bar's usage gauges (5-hour and weekly), after Stop all. Read-only: it states the reading and the pause that follows from it; hiring is held elsewhere.
import { useEffect, useRef, useState } from "react";
import type { UsageView } from "../server/gauges.ts";
import { announce, gaugesOf, type Gauge } from "./gauges.ts";
import "./gauges.css";

function GaugeCell({ g }: { g: Gauge }) {
  return (
    <div className="gauge" role="group" aria-label={g.label} data-state={g.state}>
      <span className="name">{g.name}</span>
      <span className="track" aria-hidden="true">
        {g.pct !== null && <i className="fill" style={{ width: `${g.pct}%` }} />}
        {g.ticks.map((t) => <i key={t} className="tick" style={{ left: `${t}%` }} />)}
        {g.pace !== null && <i className="pace" style={{ left: `${g.pace.toFixed(1)}%` }} />}
      </span>
      <b className="pct">{g.pct !== null && `${g.pct}%`}</b>
      <span className="meta">
        {g.state === "none" ? (
          <span>no reading yet</span>
        ) : g.state === "paused" ? (
          <span className="chip" title={g.hold!}>Paused until <time dateTime={g.resetIso!}>{g.reset}</time></span>
        ) : (
          <>
            {g.state === "warn" && <span className="chip">Near limit</span>}
            <span className="reset">resets <time dateTime={g.resetIso!}>{g.reset}</time></span>
          </>
        )}
        {g.ahead && <span className="pace-note">Ahead of pace</span>}
      </span>
    </div>
  );
}

/** `usage` is the snapshot's reading, null with none (the gauges stay, saying so). The recording has no office to read. */
export function Gauges({ usage, now = Date.now() / 1000 }: { usage: UsageView | null | undefined; now?: number }) {
  // Starts empty, so a first reading that is already paused is announced.
  const before = useRef<UsageView | null | undefined>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const text = announce(before.current, usage, now);
    before.current = usage;
    if (text) setSaid(text);
  }, [usage]);
  if (import.meta.env.MODE === "demo") return null;
  return (
    <div className="usage" role="group" aria-label="Claude usage">
      {gaugesOf(usage, now).map((g) => <GaugeCell key={g.kind} g={g} />)}
      <span className="sr-only" role="status">{said}</span>
    </div>
  );
}
