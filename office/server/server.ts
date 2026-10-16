// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { createBroker, DEFAULT_TIMEOUT_S, DENY_MESSAGE } from "./approvals.ts";
import { boardFile, readBoard, teamBoardFile, type BoardRow } from "./board.ts";
import { isEdition, projectFile, readEdition, writeEdition, type Edition } from "./editions.ts";
import { emptyOffice, normalize, reduce, sweep, type Employee, type F1rmEvent, type Room } from "./office.ts";
import { askStream, MAX_QUESTION } from "./ask.ts";
import { jump } from "./jump.ts";
import { CAP, HireRefused, pmName, planHire, readRoles } from "../cli/hire.ts";
import { ROLE_IDS, ROLES, roleOfAgentType, teamOf } from "../people.ts";
import type { machine as realMachine } from "./machine.ts";

const MAX_MESSAGE = 4000;
// The company limits a hook can hold. Only the PM and the leads hire, and no company employee runs more than INTERNS interns
// at once. Freelancers are the user's own sessions and are never held. With the office down the hooks fail open, and the rules
// in the plugin are what is left.
// ponytail: only `f1rm hire` is held; a specialist that runs `claude --bg` itself gets past it. Match that too if it shows up.
const HIRE_COMMAND = /\bf1rm(?:\.ts)?\s+hire\b/;
const SPECIALISTS = new Set(["designer", "frontend", "backend", "reviewer", "researcher"]);
export const INTERNS = 2;
// An Agent call let through counts as an intern until its SubagentStart, or for this long if that never comes.
const PENDING_MS = 60_000;
const MAX_BRIEF = 8000;
const PM_DECIDES =
  "The user opened the f1rm office's Hire dialog and left the choice of who to hire to you. Decide which roles this need takes, and hire them per the f1rm guidelines (load f1rm:f1rm-guidelines): interview first if the need is unclear, one task per hire, with `f1rm hire`. Tell the user whom you hired.\n\nThe need:\n";
const INTERN =
  "The user asked, from the f1rm office, that you hand a subtask to an intern: spawn a sub-agent for it, give it everything it needs to work alone, and use its result in your own work. Keep going on your own task meanwhile.\n\nThe subtask:\n";

type Options = {
  port: number;
  secret: string;
  token: string;
  machine: typeof realMachine;
  /** The built browser client. */
  clientDir: string;
  /** SQLite file for the append-only event log; the office is rebuilt from it on start. */
  dbPath?: string;
  /** Where the PM's board files live; without it no room has a board. */
  boardsDir?: string;
  /** Where each project's edition file lives (`~/.f1rm/projects`). */
  projectsDir?: string;
  /** How often the board files are checked for edits. */
  boardPollMs?: number;
  /** How long a PermissionRequest hook is held for the browser before the terminal prompt decides. */
  approvalTimeoutMs?: number;
  /** Time source in ms; tests control it. */
  clock?: () => number;
  /** Quiet this long (no event, no transcript write) and an employee goes offline. */
  offlineAfterMs?: number;
  /** Quiet this long and an employee leaves the office. */
  removeAfterMs?: number;
};

// A stat and never a parse: the transcript format isn't a public contract, and its mtime is all liveness needs.
const transcriptMtime = (path?: string) => {
  try {
    return path ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
};

/** Constant-time credential check. */
function same(given: string | null | undefined, expected: string) {
  const a = Buffer.from(given ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer({
  port, secret, token, machine, clientDir,
  dbPath = ":memory:",
  boardsDir,
  projectsDir,
  boardPollMs = 500,
  approvalTimeoutMs = DEFAULT_TIMEOUT_S * 1000,
  clock = Date.now,
  offlineAfterMs = 5 * 60_000,
  removeAfterMs = 15 * 60_000,
}: Options) {
  clientDir = resolve(clientDir);

  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  const append = db.prepare("INSERT INTO events (at, event) VALUES (?, ?)");

  // ponytail: replays the whole log on every start; add snapshots or pruning when startup gets slow.
  let state = emptyOffice();
  // Agent calls let through and not started yet, by session: parallel calls all reach PreToolUse before any SubagentStart.
  const pendingInterns = new Map<string, number[]>();
  /** Why the company's rules stop this tool call, or null to let it run. */
  function refusal(sessionId: string, payload: Record<string, any>): string | null {
    const role = state.employees[sessionId]?.role;
    if (!role) return null;
    const tool = String(payload.tool_name ?? "");
    if (tool === "Bash" && SPECIALISTS.has(role) && HIRE_COMMAND.test(String(payload.tool_input?.command ?? ""))) {
      return "Only the PM and team leads hire. Send what you need to the session named in your brief's Report to.";
    }
    if (tool === "Agent" || tool === "Task") {
      const now = clock();
      const pending = (pendingInterns.get(sessionId) ?? []).filter((t) => now - t < PENDING_MS);
      const running = Object.values(state.interns).filter((i) => i.parent === sessionId).length;
      if (running + pending.length >= INTERNS) return `You already have ${INTERNS} interns working, the most an employee runs at once. Wait for one to finish, or do this step yourself.`;
      pendingInterns.set(sessionId, [...pending, now]);
    }
    return null;
  }
  for (const row of db.query("SELECT event FROM events ORDER BY id").all() as { event: string }[]) {
    try {
      state = reduce(state, JSON.parse(row.event));
    } catch {} // a row this build can't read must not stop the office from starting
  }

  // ponytail: cached per cwd for the server's lifetime; a folder that later gets `git init` needs a restart.
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

  const employeeOf = (id: string) => (Object.hasOwn(state.employees, id) ? state.employees[id] : undefined);
  // The folder comes from the room the office holds, never from the request. A repo's room id is its git common dir.
  // ponytail: a submodule's common dir lives under .git/modules, so its room resolves to the wrong folder; use an employee's cwd there if it is felt.
  const folderOf = (room: string) => (basename(room) === ".git" ? dirname(room) : room);
  const pmOf = (room: string) => Object.values(state.employees).find((e) => e.room === room && e.role === "pm");
  const tellEmployee = (employee: Employee, message: string) => {
    // No socket header yet: messaging is off for the session, or it has not reported since f1rm started.
    if (!employee.socket) return Promise.resolve(Response.json({ ok: false, error: "This session has no inbox to tell." }, { status: 409 }));
    return machine.tell(employee.socket, employee.sessionId, message).then(
      () => Response.json({ ok: true }),
      (err: Error) => Response.json({ ok: false, error: `Tell failed: ${err.message}` }, { status: 409 }),
    );
  };

  // What the office records when a session is gone, so a replay shows the same departure.
  const departure = (e: Employee): F1rmEvent => ({ sessionId: e.sessionId, kind: "SessionEnd", cwd: e.cwd, room: state.rooms[e.room], terminal: e.terminal, at: clock() });

  let boards: Record<string, BoardRow[]> = {};
  let teamBoards: Record<string, Record<string, BoardRow[]>> = {};
  let editions: Record<string, Edition> = {};
  const approvals = createBroker(approvalTimeoutMs, () => push());
  const snapshot = () => JSON.stringify({ ...state, boards, teamBoards, editions, approvals: approvals.list() });
  const push = () => server.publish("office", snapshot());

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // The fork can be silent for a while (starting up, reading files) before its first words.
    idleTimeout: 120,
    async fetch(req, server) {
      await ready;
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
        const event = normalize(payload, req.headers, roomOf, clock());
        if (event) {
          append.run(event.at, JSON.stringify(event));
          state = reduce(state, event);
          // ponytail: any later event drops the session's hand, so a parallel tool call can drop it early and the prompt falls back to the terminal; correlate by tool_use_id if that is felt.
          // The exception is the notification about the very prompt being held.
          if (!event.kind.startsWith("Notification/")) approvals.release(event.sessionId);
          push();
          if (event.kind === "PreToolUse") {
            const why = refusal(event.sessionId, payload);
            if (why) return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
          }
          if (event.kind === "SubagentStart" || (event.kind === "PostToolUseFailure" && ["Agent", "Task"].includes(String(payload.tool_name)))) {
            pendingInterns.get(event.sessionId)?.shift();
          }
          if (event.kind === "PermissionRequest") {
            server.timeout(req, 0); // the hold outlasts the idle timeout
            const decision = await approvals.hold(event.sessionId, String(payload.tool_name ?? ""), payload.tool_input, event.at, req.signal);
            if (decision) return Response.json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
          }
        }
        return new Response(null, { status: 200 });
      }
      // Everything for the browser lives under /<ui token>/, so every request carries the token.
      const [, given, ...rest] = url.pathname.split("/");
      if (!same(given, token)) return new Response("unauthorized", { status: 401 });
      if (rest.length === 0) return new Response(null, { status: 307, headers: { location: `/${given}/` } });
      const path = rest.join("/");
      if (rest.length === 2 && ["jump", "approve", "deny", "ask", "tell", "letgo", "intern"].includes(rest[0]) && req.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      }
      if (rest[0] === "jump" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const result = await jump(machine, employee);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if ((rest[0] === "approve" || rest[0] === "deny") && rest.length === 2) {
        const decided = approvals.answer(rest[1], rest[0] === "approve" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE });
        return decided
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "That request is no longer waiting; the terminal has it." }, { status: 404 });
      }
      if (rest[0] === "ask" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ error: "No such employee." }, { status: 404 });
        const question = ((await req.json().catch(() => null)) as { question?: unknown } | null)?.question;
        if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
          return Response.json({ error: `Ask a question of 1 to ${MAX_QUESTION} characters.` }, { status: 400 });
        }
        return new Response(askStream(machine, employee, question.trim()), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }
      if (rest[0] === "tell" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const message = ((await req.json().catch(() => null)) as { message?: unknown } | null)?.message;
        if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) {
          return Response.json({ ok: false, error: `Tell a message of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
        }
        return tellEmployee(employee, message.trim());
      }
      if (rest[0] === "intern" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const subtask = ((await req.json().catch(() => null)) as { subtask?: unknown } | null)?.subtask;
        if (typeof subtask !== "string" || !subtask.trim() || subtask.length > MAX_MESSAGE) {
          return Response.json({ ok: false, error: `Name a subtask of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
        }
        return tellEmployee(employee, INTERN + subtask.trim());
      }
      if (rest[0] === "background" && rest.length === 2) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        const employee = employeeOf(rest[1]);
        return Response.json({ background: !!employee && (await machine.backgroundId(employee.sessionId)) !== null });
      }
      if (rest[0] === "letgo" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ error: "No such employee." }, { status: 404 });
        if (((await req.json().catch(() => null)) as { confirm?: unknown } | null)?.confirm !== true) {
          return Response.json({ error: "Letting someone go needs an explicit confirm." }, { status: 400 });
        }
        const id = await machine.backgroundId(employee.sessionId);
        if (!id) return Response.json({ error: "Only a background hire can be let go." }, { status: 409 });
        try {
          await machine.letGo(id);
        } catch (err) {
          return Response.json({ error: `Let go failed: ${(err as Error).message}` }, { status: 502 });
        }
        // The session may never send its own SessionEnd, so the office records the departure itself.
        const gone = departure(employee);
        append.run(gone.at, JSON.stringify(gone));
        state = reduce(state, gone);
        push();
        return Response.json({ ok: true });
      }
      if (rest[0] === "roles" && rest.length === 1) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        const room = url.searchParams.get("room");
        const staff = Object.values(state.employees);
        // Company order, like the desks, but the specialists first: they are the usual hire, so the first one is preselected. Then the lead, then a role file the office doesn't know.
        const order = (id: string) => {
          const known = roleOfAgentType(`f1rm:${id}`);
          return known === "lead" ? ROLE_IDS.length : known ? ROLE_IDS.indexOf(known) : ROLE_IDS.length + 1;
        };
        // The cap counts every working background hire on the machine, as `claude agents` lists them, not this project's. Null when it can't be counted.
        const hires = await machine.workingHires();
        return Response.json({
          roles: readRoles()
            .sort((a, b) => order(a.id) - order(b.id))
            .map((r) => {
              const known = roleOfAgentType(`f1rm:${r.id}`);
              const working = staff.filter((e) => known && e.role === known && e.room === room && (e.status === "working" || e.status === "waiting")).length;
              return { ...r, title: known ? ROLES[known].title : r.id, working };
            }),
          hires: { working: hires, cap: CAP },
        });
      }
      if (rest[0] === "edition" && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const { room, edition } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if (typeof room !== "string" || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        if (!isEdition(edition)) return Response.json({ error: "The edition is work or founder." }, { status: 400 });
        if (!projectsDir) return Response.json({ error: "This office keeps no project settings." }, { status: 500 });
        writeEdition(projectFile(projectsDir, room), edition);
        editions = { ...editions, [room]: edition };
        push();
        return Response.json({ ok: true });
      }
      if (rest[0] === "hire" && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const { room, role, task, team, brief, model, override } = body ?? {};
        if (typeof room !== "string" || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        if (typeof role !== "string" || typeof task !== "string" || typeof brief !== "string" || !brief.trim() || brief.length > MAX_BRIEF || (model != null && typeof model !== "string") || (team != null && typeof team !== "string") || (override != null && typeof override !== "boolean")) {
          return Response.json({ error: `Hire needs a role, a task name, a model and a team that are strings, an override that is true or false, and a brief of 1 to ${MAX_BRIEF} characters.` }, { status: 400 });
        }
        const folder = folderOf(room);
        let argv: string[];
        try {
          argv = await planHire({ role, task, team: team ?? null, cwd: folder, brief: brief.trim(), reportTo: pmOf(room) ? pmName(folder, machine) : null, model, override: override === true }, machine);
        } catch (err) {
          if (err instanceof HireRefused) return Response.json({ error: err.message, working: err.working }, { status: 409 });
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
        // ponytail: two hires posted at the same instant can both pass the count before either shows in `claude agents`; serialize them if that is felt.
        return machine.spawnBackground(argv, folder).then(
          () => Response.json({ ok: true }),
          (err: Error) => Response.json({ error: `Hire failed: ${err.message}` }, { status: 502 }),
        );
      }
      if ((rest[0] === "decide" || rest[0] === "start-pm") && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const { room, need } = body ?? {};
        if (typeof room !== "string" || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        const pm = pmOf(room);
        if (rest[0] === "start-pm") {
          if (pm) return Response.json({ error: "This project already has a PM." }, { status: 409 });
          return machine.startPmInIterm(folderOf(room)).then(
            () => Response.json({ ok: true }),
            (err: Error) => Response.json({ error: `Start PM failed: ${err.message}` }, { status: 502 }),
          );
        }
        if (typeof need !== "string" || !need.trim() || need.length > MAX_BRIEF) {
          return Response.json({ error: `Describe the need in 1 to ${MAX_BRIEF} characters.` }, { status: 400 });
        }
        if (!pm) return Response.json({ error: "This project has no PM." }, { status: 409 });
        return tellEmployee(pm, PM_DECIDES + need.trim());
      }
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
        ws.send(snapshot());
      },
      message() {},
    },
  });

  const timeouts = { offlineAfter: offlineAfterMs, removeAfter: removeAfterMs };
  const lastActive = (e: Employee) => Math.max(e.lastEventAt, transcriptMtime(e.transcript));
  let sweeping = false;
  async function sweepOnce() {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = clock();
      // ponytail: asks `claude agents --json` on every tick while anyone is quiet; cache it if that gets heavy.
      const quiet = Object.values(state.employees).some((e) => now - lastActive(e) >= offlineAfterMs);
      const alive = quiet ? await machine.liveSessions() : new Set<string>();
      if (!alive) return;
      const next = sweep(state, clock(), timeouts, lastActive, alive);
      if (next !== state) {
        // Replay must see the same departures, or a dead session keeps its name and the next arrival is renamed.
        for (const e of Object.values(state.employees)) {
          if (next.employees[e.sessionId]) continue;
          const gone = departure(e);
          append.run(gone.at, JSON.stringify(gone));
        }
        state = next;
        push();
      }
    } finally {
      sweeping = false;
    }
  }
  // ponytail: polls and rereads each room's board every tick; swap in fs.watch if many rooms make that heavy.
  let reading = false;
  async function readBoards() {
    if (reading) return;
    reading = true;
    try {
      const nextEditions: Record<string, Edition> = {};
      for (const id of projectsDir ? Object.keys(state.rooms) : []) {
        const edition = readEdition(projectFile(projectsDir!, id));
        if (edition) nextEditions[id] = edition;
      }
      if (JSON.stringify(nextEditions) !== JSON.stringify(editions)) {
        editions = nextEditions;
        push();
      }
      if (!boardsDir) return;
      const next: Record<string, BoardRow[]> = {};
      const nextTeams: Record<string, Record<string, BoardRow[]>> = {};
      for (const id of Object.keys(state.rooms)) {
        const rows = await readBoard(boardFile(boardsDir, id));
        if (rows.length) next[id] = rows;
        // Only the boards of teams someone in the room works in.
        const teams = new Set(Object.values(state.employees).filter((e) => e.room === id).map(teamOf).filter((t) => t !== null));
        for (const team of teams) {
          const teamRows = await readBoard(teamBoardFile(boardsDir, id, team));
          if (teamRows.length) (nextTeams[id] ??= {})[team] = teamRows;
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(boards) || JSON.stringify(nextTeams) !== JSON.stringify(teamBoards)) {
        boards = next;
        teamBoards = nextTeams;
        push();
      }
    } finally {
      reading = false;
    }
  }
  const ready = Promise.all([sweepOnce(), readBoards()]);
  const timer = setInterval(sweepOnce, Math.min(15_000, offlineAfterMs / 4));
  const boardTimer = setInterval(readBoards, boardPollMs);
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    clearInterval(timer);
    clearInterval(boardTimer);
    approvals.releaseAll();
    await stop(closeActiveConnections);
    db.close();
  };
  return server;
}
