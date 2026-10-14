// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { timingSafeEqual } from "node:crypto";
import { basename, dirname, resolve, sep } from "node:path";
import { emptyOffice, normalize, reduce, type Room } from "./office.ts";
import type { machine as realMachine } from "./machine.ts";

type Options = {
  port: number;
  secret: string;
  token: string;
  machine: typeof realMachine;
  /** The built browser client. */
  clientDir: string;
};

/** Constant-time credential check. */
function same(given: string | null | undefined, expected: string) {
  const a = Buffer.from(given ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer({ port, secret, token, machine, clientDir }: Options) {
  clientDir = resolve(clientDir);
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
      // Host defeats DNS rebinding; Origin defeats other sites (hooks send none).
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const origin = req.headers.get("origin");
      if (!hosts.includes(req.headers.get("host") ?? "") || (origin !== null && !hosts.some((h) => origin === `http://${h}`))) {
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ingest" && req.method === "POST") {
        if (!same(req.headers.get("x-f1rm-secret"), secret)) return new Response("unauthorized", { status: 401 });
        const payload = await req.json().catch(() => null);
        const event = normalize(payload, roomOf(String(payload?.cwd ?? "")));
        if (event) {
          state = reduce(state, event);
          server.publish("office", JSON.stringify(state));
        }
        return new Response(null, { status: 200 });
      }
      // Everything for the browser lives under /<ui token>/, so every request carries the token.
      const [, given, ...rest] = url.pathname.split("/");
      if (!same(given, token)) return new Response("unauthorized", { status: 401 });
      const path = rest.join("/");
      if (path === "ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      const file = resolve(clientDir, path || "index.html");
      if (!file.startsWith(clientDir + sep) || !(await Bun.file(file).exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file));
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
