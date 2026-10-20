// The page's live connection to the office: it keeps trying until the office is back, and the office's first message on each connection is the whole state.

/** The banner while the connection is down. */
export const OFFICE_DOWN = "Office is down — run `f1rm`";

type Socket = Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "close">;

/** Opens the connection and returns the function that ends it for good. `onUp(false)` is the office going away; the next `onUp(true)` and message are it coming back. */
export function connectLive({ url, onMessage, onUp, open = (u) => new WebSocket(u), after = (run, ms) => { const t = setTimeout(run, ms); return () => clearTimeout(t); } }: {
  url: string;
  onMessage: (message: any) => void;
  onUp: (up: boolean) => void;
  open?: (url: string) => Socket;
  after?: (run: () => void, ms: number) => () => void;
}): () => void {
  let socket: Socket | null = null;
  let cancel: (() => void) | null = null;
  let failures = 0;
  let stopped = false;
  const connect = () => {
    const ws = (socket = open(url));
    ws.onopen = () => {
      failures = 0;
      onUp(true);
    };
    ws.onmessage = (m) => onMessage(JSON.parse(m.data));
    ws.onclose = () => {
      if (stopped) return;
      onUp(false);
      // 1 s, 2 s, 4 s, then every 5 s for as long as it takes.
      cancel = after(connect, Math.min(1000 * 2 ** failures++, 5000));
    };
  };
  connect();
  return () => {
    stopped = true;
    cancel?.();
    socket?.close();
  };
}
