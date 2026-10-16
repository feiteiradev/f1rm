// The demo page: the office client with its WebSocket replaced by the recorded session, so a plain static host is enough.
import type { F1rmEvent } from "../server/office.ts";
import fixture from "./fixture.json";
import { EXTRAS } from "./extras.ts";
import { frames, play } from "./replay.ts";

const recording = frames(fixture as F1rmEvent[]);

class ReplaySocket {
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private stop = () => {};
  constructor() {
    // Starts after the client has attached its handlers.
    const start = setTimeout(() => (this.stop = play(recording, (s) => this.onmessage?.({ data: JSON.stringify({ ...s, ...EXTRAS }) }))));
    this.stop = () => clearTimeout(start);
  }
  close() {
    this.stop();
  }
}
globalThis.WebSocket = ReplaySocket as unknown as typeof WebSocket;

document.body.append(Object.assign(document.createElement("p"), { className: "demo-note", textContent: "Recorded demo. Nothing here is live." }));
import("../client/main.tsx");
