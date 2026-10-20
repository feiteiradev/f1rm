// The page's live connection to the office: it keeps trying until the office is back, and the office's first message on each connection is the whole state.

import { OUT_OF_DATE } from "./post.ts";

/** The banner while the connection is down. */
export const OFFICE_DOWN = "Office is down — run `f1rm`";

/** Why the connection is down, from one look at the page's own address: the office answers a link it doesn't know with 401, and an office that's down answers nothing. */
export async function whyDown(get: typeof fetch = fetch, href: string = location.href): Promise<string> {
  const res = await get(href, { cache: "no-store" }).catch(() => null);
  return res?.status === 401 ? OUT_OF_DATE : OFFICE_DOWN;
}

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
    ws.onopen = () => onUp(true);
    // Only the office's first message proves the connection works, so a socket that opens and drops again keeps backing off.
    ws.onmessage = (m) => {
      failures = 0;
      onMessage(JSON.parse(m.data));
    };
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
