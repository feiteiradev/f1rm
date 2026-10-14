// Seam 1: the f1rm server, in-process, with the machine module faked.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";

const fakeMachine = (repos: Record<string, string> = {}) => ({
  // cwd -> git common dir, canned
  gitCommonDir: (cwd: string) => repos[cwd] ?? null,
});

let server: ReturnType<typeof startServer>;
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  server?.stop(true);
});

// Stand-in for the built client.
const clientDir = mkdtempSync(join(tmpdir(), "f1rm-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>f1rm</title>");

function start(repos?: Record<string, string>) {
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: fakeMachine(repos), clientDir });
  return server;
}
const base = () => `http://127.0.0.1:${server.port}`;

function hook(payload: object, headers: Record<string, string> = {}) {
  return fetch(`${base()}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET, ...headers },
    body: JSON.stringify(payload),
  });
}

// Connects like the browser does and resolves with the first state matching `until`.
function office(until: (s: OfficeState) => boolean, timeout = 1000) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, {
    headers: { origin: base() },
  } as any);
  sockets.push(ws);
  return new Promise<OfficeState>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no matching state within " + timeout + "ms")), timeout);
    ws.onmessage = (m) => {
      const state = JSON.parse(String(m.data)) as OfficeState;
      if (until(state)) {
        clearTimeout(timer);
        resolve(state);
      }
    };
  });
}

const sessionStart = (session_id: string, cwd: string) => ({
  session_id,
  transcript_path: `/Users/me/.claude/projects/x/${session_id}.jsonl`,
  cwd,
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-5-5",
});

test("a new session appears as an idle employee in its repo's room", async () => {
  start({ "/code/shop": "/code/shop/.git" });
  const seen = office((s) => Object.keys(s.employees).length === 1);
  expect((await hook(sessionStart("s1", "/code/shop"))).status).toBe(200);

  const state = await seen;
  expect(state.employees.s1).toMatchObject({ status: "idle", room: "/code/shop/.git", cwd: "/code/shop" });
  expect(state.rooms["/code/shop/.git"]).toEqual({ id: "/code/shop/.git", name: "shop" });
});

test("hook events without the right ingest secret are rejected and change nothing", async () => {
  start();
  expect((await hook(sessionStart("fake", "/x"), { "x-f1rm-secret": "wrong" })).status).toBe(401);
  const res = await fetch(`${base()}/ingest`, { method: "POST", body: JSON.stringify(sessionStart("fake", "/x")) });
  expect(res.status).toBe(401);

  await hook(sessionStart("real", "/y"));
  const state = await office((s) => "real" in s.employees);
  expect(Object.keys(state.employees)).toEqual(["real"]);
});

test("the page and the WebSocket need the per-launch UI token", async () => {
  start();
  expect((await fetch(`${base()}/${TOKEN}/`)).status).toBe(200);
  expect(await (await fetch(`${base()}/${TOKEN}/`)).text()).toContain("<title>f1rm</title>");
  for (const path of ["/", "/wrong/", "/wrong/ws", `/${TOKEN}x/`]) {
    expect((await fetch(base() + path)).status).toBe(401);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/wrong/ws`, { headers: { origin: base() } } as any);
  sockets.push(ws);
  const outcome = await new Promise((r) => {
    ws.onmessage = () => r("message");
    ws.onerror = () => r("rejected");
  });
  expect(outcome).toBe("rejected");
});

test("a foreign Origin or an unexpected Host is rejected, even with valid credentials", async () => {
  start();
  const page = `${base()}/${TOKEN}/`;
  const bad = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: `http://127.0.0.1:${server.port + 1}` },
    { host: `evil.example:${server.port}` }, // DNS rebinding
    { host: "127.0.0.1" },
  ];
  for (const headers of bad) {
    expect((await fetch(page, { headers })).status).toBe(403);
    expect((await hook(sessionStart("x", "/x"), headers)).status).toBe(403);
  }
  // The browser's own origins are fine, as are hook requests with no Origin.
  for (const origin of [base(), `http://localhost:${server.port}`]) {
    expect((await fetch(page, { headers: { origin } })).status).toBe(200);
  }
  expect((await fetch(page, { headers: { host: `localhost:${server.port}` } })).status).toBe(200);

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, {
    headers: { origin: "https://evil.example" },
  } as any);
  sockets.push(ws);
  const outcome = await new Promise((r) => {
    ws.onmessage = () => r("message");
    ws.onerror = () => r("rejected");
  });
  expect(outcome).toBe("rejected");
  expect(Object.keys((await office(() => true)).employees)).toEqual([]);
});

test("the server sends no CORS headers", async () => {
  start();
  const origin = "https://evil.example";
  const responses = [
    await fetch(`${base()}/${TOKEN}/`, { headers: { origin } }),
    await fetch(`${base()}/${TOKEN}/`),
    await fetch(`${base()}/ingest`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    }),
    await hook(sessionStart("s", "/s")),
  ];
  for (const res of responses) {
    expect([...res.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
  }
});
