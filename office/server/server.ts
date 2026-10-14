// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { basename, dirname } from "node:path";
import { emptyOffice, normalize, reduce, type Room } from "./office.ts";
import type { machine as realMachine } from "./machine.ts";

type Options = {
  port: number;
  secret: string;
  token: string;
  machine: Pick<typeof realMachine, "gitCommonDir">;
};

export function startServer({ port, secret, token, machine }: Options) {
  let state = emptyOffice();

  const rooms = new Map<string, Room>();
  const roomOf = (cwd: string): Room => {
    let room = rooms.get(cwd);
    if (!room) {
      const common = machine.gitCommonDir(cwd);
      // A repo's room is its git common dir, so worktrees share it; a non-git folder is its own room.
      room = common
        ? { id: common, name: basename(basename(common) === ".git" ? dirname(common) : common).replace(/\.git$/, "") }
        : { id: cwd, name: basename(cwd) || cwd };
      rooms.set(cwd, room);
    }
    return room;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ingest" && req.method === "POST") {
        const payload = await req.json().catch(() => null);
        const event = normalize(payload, roomOf(String(payload?.cwd ?? "")));
        if (event) {
          state = reduce(state, event);
          server.publish("office", JSON.stringify(state));
        }
        return new Response(null, { status: 200 });
      }
      if (url.pathname === `/${token}/ws` && server.upgrade(req)) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("office");
        ws.send(JSON.stringify(state));
      },
      message() {},
    },
  });
  return server;
}
