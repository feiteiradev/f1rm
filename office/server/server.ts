// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createBroker, DEFAULT_TIMEOUT_S, DENY_MESSAGE } from "./approvals.ts";
import { boardFile, readBoard, teamBoardFile, type BoardRow } from "./board.ts";
import { isEdition, projectFile, readEdition, writeEdition, type Edition } from "./editions.ts";
import { ELSEWHERE, emptyOffice, normalize, reduce, sweep, type Employee, type F1rmEvent, type Room } from "./office.ts";
import { isJunk, junkRoots as defaultJunkRoots, readForgotten, writeForgotten } from "./doors.ts";
import { askStream, MAX_QUESTION } from "./ask.ts";
import { jump } from "./jump.ts";
import { CAP, HireRefused, LOAD_FIRST, parseHireFlags, pmName, SECURITY, planHire, readRoles } from "../cli/hire.ts";
import { hireTask, letGoHire, repoOf } from "../cli/letgo.ts";
import { FOUNDER_ONLY, ROLE_IDS, ROLES, roleOfAgentType, teamOf } from "../people.ts";
import type { machine as realMachine } from "./machine.ts";

const MAX_MESSAGE = 4000;
// The company limits a hook can hold. Only the PM and the leads hire, and no company employee runs more than INTERNS interns
// at once. Freelancers are the user's own sessions and are never held. With the office down the hooks fail open, and the rules
// in the plugin are what is left.
// ponytail: only `f1rm hire` is held; a specialist that runs `claude --bg` itself gets past it. Match that too if it shows up.
// `f1rm hire` counts only in command position (see simpleCommands), so a command that merely mentions it passes.
// The PM and the leads coordinate: they write boards, milestones, memory, evidence and scratch files, and leave code and landing to others.
// While a hire still has skills to load, only these run: reading, loading the skill, and telling someone it can't.
const READING = new Set(["Skill", "Read", "Grep", "Glob", "ToolSearch", "SendMessage"]);
const COORDINATORS = new Set(["pm", "lead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const LANDING = new Set(["commit", "merge", "push", "rebase", "reset", "cherry-pick", "pull", "am", "revert"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
// What can stand in front of a command: shell keywords and wrappers that run the next word.
const BEFORE_COMMAND = new Set(["bun", "if", "then", "do", "else", "elif", "while", "until", "!", "{", "time", "env", "command", "exec", "nohup", "xargs", "sudo"]);
/** The words of each simple command in a shell line, split on `; & | ( )`, backticks and newlines outside quotes, past `VAR=x` prefixes, shell keywords, wrappers such as `env` and `bun`, and their flags. */
// ponytail: not a shell parser; a command inside double quotes (`"$(git push)"`) or an alias is not seen. A heredoc body is split into commands too,
// so a body line `git push` is refused (it fails closed; write the file with the Write tool); a wrapper's flag value (`sudo -u x git push`) is taken for the command.
const simpleCommands = (command: string) => {
  const out: string[][] = [[]];
  for (const [, op, word] of command.matchAll(/([;&|()`\n])|((?:[^\s"';&|()`]|"(?:\\.|[^"\\])*"|'[^']*')+)/g)) op ? out.push([]) : out.at(-1)!.push(word);
  return out.map((words) => {
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || BEFORE_COMMAND.has(words[i]) || (i > 0 && words[i].startsWith("-")))) i++;
    return words.slice(i);
  });
};
// A `f1rm`/`f1rm.ts` word followed by `hire` at any position, so `bun run f1rm.ts hire` and `npx f1rm hire` count; a quoted message is one word, so it doesn't.
// ponytail: `bash -c "f1rm hire …"` is one quoted word and is not seen.
const unquoted = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");
/** The words after `hire` of a simple command that runs `f1rm hire`, unquoted, or null. */
const hireArgs = (words: string[]) => {
  const i = words.findIndex((w, i) => ["f1rm", "f1rm.ts"].includes(basename(unquoted(w))) && unquoted(words[i + 1] ?? "") === "hire");
  return i < 0 ? null : words.slice(i + 2).map(unquoted);
};
/** The role and `--team` of the words after `f1rm hire`, read with the CLI's own flag parser so the two can't drift; `--help` hires nobody. */
const hireOf = (args: string[] | null) => {
  if (!args) return null;
  const { team, args: [role] } = parseHireFlags(args);
  return role === "--help" || role === "-h" ? null : { role, team };
};
/** Where the words after the options start: a flag that takes a value takes the next word with it. */
const skipOptions = (args: string[], i: number, withValue: Set<string>) => {
  while (args[i]?.startsWith("-")) i += withValue.has(args[i]) ? 2 : 1;
  return i;
};
/** The git subcommand a simple command runs, past global options such as `-C <dir>`, with the words after it and the options before it. */
const gitCall = ([program, ...words]: string[]) => {
  if (basename(unquoted(program ?? "")) !== "git") return null;
  const args = words.map(unquoted);
  const i = skipOptions(args, 0, GIT_OPTIONS_WITH_VALUE);
  return { sub: args[i] ?? "", rest: args.slice(i + 1), options: args.slice(0, i) };
};
const GH_OPTIONS_WITH_VALUE = new Set(["-R", "--repo"]);
/** `gh pr merge`, past options such as `-R <repo>` before or after `pr`. */
const ghMerge = ([program, ...words]: string[]) => {
  if (basename(unquoted(program ?? "")) !== "gh") return false;
  const args = words.map(unquoted);
  const i = skipOptions(args, 0, GH_OPTIONS_WITH_VALUE);
  return args[i] === "pr" && args[skipOptions(args, i + 1, GH_OPTIONS_WITH_VALUE)] === "merge";
};
// What a Reviewer may not run: it merges with --no-ff or --ff-only and removes its worktrees, and rewrites nothing.
const REVIEWER_NEVER = new Set(["reset", "rebase", "cherry-pick", "revert", "am", "pull", "clean", "update-ref"]);
// A short-flag cluster with `f` is a force only for these; `git log -Sfoo` and `git diff -Uf` are not. A bare `-f` and `--force*` are refused everywhere.
const FORCE_SHORT = new Set(["checkout", "switch", "branch", "worktree", "tag", "merge", "clean", "push", "fetch", "reset", "add", "update-ref"]);
const RED_WORKTREE = /^\.claude\/worktrees\/red-[^/]+\/?$/;
// ponytail: a dev task whose slug starts `red-` has its worktree removable by a Reviewer too; tighten it if that ever matters.
/** Whether a git call is one a Reviewer may not run. The one force it needs is removing its red-<task> scratch worktree. */
const reviewerRefused = (call: ReturnType<typeof gitCall>) => {
  if (!call) return false;
  const { sub, rest, options } = call;
  const any = (re: RegExp) => rest.some((a) => re.test(a));
  if (REVIEWER_NEVER.has(sub)) return true;
  if ((sub === "branch" && any(/^-[A-Za-z]*[DM]/)) || (sub === "checkout" && any(/^-[A-Za-z]*B/)) || (sub === "switch" && any(/^-[A-Za-z]*C/))) return true;
  if ((sub === "stash" && ["drop", "clear"].includes(rest[0])) || ((sub === "checkout" || sub === "restore") && rest.includes("."))) return true;
  if (!any(/^--force/) && !rest.includes("-f") && !(FORCE_SHORT.has(sub) && any(/^-[A-Za-z]*f/))) return false;
  const flags = rest.filter((a) => a.startsWith("-")), paths = rest.filter((a) => !a.startsWith("-"));
  const here = !options.some((o) => /^(-C|--git-dir|--work-tree)/.test(o));
  return !(sub === "worktree" && here && paths[0] === "remove" && flags.every((a) => a === "--force" || a === "-f") && paths.length === 2 && RED_WORKTREE.test(paths[1]));
};
const SPECIALISTS = new Set(["designer", "frontend", "backend", "reviewer", "researcher", "marketer", "seo", "social", "sales", "strategist"]);
export const INTERNS = 2;
// A Founder role drafts and never puts anything out: a connector tool with one of these words in its name is held.
const PUTS_OUT = new Set(["send", "publish", "post", "schedule"]);
/** The words of a tool's name, split on separators and camelCase, so `postgres` and `compost` are not `post`. */
const wordsOf = (tool: string) => tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
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
  /** The folders that never get a door: the office's own, Claude's and temp folders. Tests inject them. */
  junkRoots?: string[];
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
  /** A background hire done this long, with its branch merged, is let go with its worktree and branch. */
  letGoAfterMs?: number;
  /** True while the process with this id runs; tests swap it. Default: a signal-0 call. */
  isAlive?: (pid: number) => boolean;
};

// Dead only on ESRCH (no such process). EPERM means it belongs to someone else, so it is alive; so does any error that does not say it is gone.
// ponytail: a pid the system has handed to another program since reads as alive, so that ghost waits for the quiet path; compare process start times if that is felt.
export const processRuns = (pid: number) => {
  // 0 and -1 would signal a whole process group.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
// How often `claude agents --json` is asked for the pids of employees whose pid is not known yet.
const PID_REFRESH_MS = 30_000;

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
  junkRoots = defaultJunkRoots(),
  boardPollMs = 500,
  approvalTimeoutMs = DEFAULT_TIMEOUT_S * 1000,
  clock = Date.now,
  offlineAfterMs = 5 * 60_000,
  removeAfterMs = 15 * 60_000,
  letGoAfterMs = 15 * 60_000,
  isAlive = processRuns,
}: Options) {
  clientDir = resolve(clientDir);

  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  const append = db.prepare("INSERT INTO events (at, event) VALUES (?, ?)");

  // ponytail: replays the whole log on every start; add snapshots or pruning when startup gets slow.
  let state = emptyOffice();
  // Agent calls let through and not started yet, by session: parallel calls all reach PreToolUse before any SubagentStart.
  const pendingInterns = new Map<string, number[]>();
  // The skills a hire's first prompt names, and the ones its Skill calls have loaded, by session. The prompt itself is never kept.
  // ponytail: in memory, so an office restart empties it and the gate fails open; persist it if hires outlive restarts in practice.
  const skillGates = new Map<string, { required: string[]; security: boolean; loaded: Set<string> }>();
  /** Why the company's rules stop this tool call, or null to let it run. */
  function refusal(sessionId: string, payload: Record<string, any>): string | null {
    const role = state.employees[sessionId]?.role;
    if (!role) return null;
    const tool = String(payload.tool_name ?? "");
    const input = payload.tool_input ?? {};
    // Each refusal is logged (stdout is ~/.f1rm/office.log) with who, which tool and which rule, never the command or the contents.
    const refuse = (rule: string, why: string) => (console.log(`refused ${role} ${state.employees[sessionId]?.title ?? sessionId} ${tool} ${rule}`), why);
    // Only the hire itself is held: a sub-agent, such as the one its first slash command forks, works at once.
    const gate = payload.agent_id ? undefined : skillGates.get(sessionId);
    if (gate) {
      const has = (name: string) => gate.loaded.has(name);
      const missing = gate.required.filter((r) => !has(r));
      if (missing.length && !READING.has(tool)) return refuse("skills", `Load these first with the Skill tool: ${missing.join(", ")}. If one isn't installed, send \`BLOCKED <task>\` with its name to the session in your Report to.`);
      if (gate.security && !has("security-review") && tool === "SendMessage" && String(input.message ?? "").trimStart().startsWith("APPROVED")) {
        return refuse("security", "Run security-review with the Skill tool on the merge before you send APPROVED.");
      }
    }
    const commands = tool === "Bash" ? simpleCommands(String(input.command ?? "")) : [];
    const hires = commands.flatMap((c) => hireOf(hireArgs(c)) ?? []);
    if (SPECIALISTS.has(role) && commands.some((c) => hireArgs(c))) {
      return refuse("hire", "Only the PM and team leads hire. Send what you need to the session named in your brief's Report to.");
    }
    if (role === "pm" && hires.some((h) => h.role !== "lead")) return refuse("hire", "PMs hire leads; send this to a lead. A lead hires the specialists of its team.");
    if (role === "lead") {
      const team = teamOf(state.employees[sessionId]);
      if (hires.some((h) => h.role === "lead")) return refuse("hire", "A lead hires specialists for its own team, never another lead. Ask the PM for a new team.");
      if (hires.some((h) => !team || h.team !== team)) return refuse("hire", `A lead hires only into its own team: add --team ${team ?? "<your team>"}.`);
    }
    if (COORDINATORS.has(role) && WRITE_TOOLS.has(tool)) {
      const file = resolve(String(payload.cwd ?? "/"), String(input.file_path ?? input.notebook_path ?? ""));
      const home = process.env.HOME ?? "";
      const dirs = [boardsDir, home && join(home, ".f1rm", "milestones"), home && join(home, ".claude", "agent-memory"), home && join(home, ".f1rm", "evidence")];
      const scratch = ["/private/tmp/claude-", "/tmp/claude-"];
      if (!dirs.some((d) => d && file.startsWith(resolve(d) + sep)) && !scratch.some((p) => file.startsWith(p))) {
        return refuse("write", "The PM and leads write only boards, milestones, memory, evidence and scratch files. Put this work on the board and hire for it.");
      }
    }
    if (COORDINATORS.has(role) && commands.some((w) => LANDING.has(gitCall(w)?.sub ?? "") || ghMerge(w))) {
      return refuse("landing", "Landing, merging and pushing belong to the Reviewer and the user. Hire for it, or ask the user to run it with `!`.");
    }
    if (commands.some((w) => gitCall(w)?.sub === "push" || ghMerge(w))) return refuse("push", "Only the user pushes, and merges pull requests. Tell the session in your Report to that the work is ready.");
    if (role === "reviewer" && commands.some((w) => reviewerRefused(gitCall(w)))) {
      return refuse("history", "A Reviewer merges with --no-ff or --ff-only and rewrites nothing: no reset, rebase, cherry-pick, revert, am, pull, clean, branch -D or force. Only `git worktree remove --force .claude/worktrees/red-<task>` may force.");
    }
    if (FOUNDER_ONLY.has(role) && tool.startsWith("mcp__") && wordsOf(tool).some((w) => PUTS_OUT.has(w))) {
      return refuse("founder", "Drafts only: a Founder role never posts, publishes, sends or schedules. Save it as a draft and hand it to the session in your brief's Report to; the founder puts it out.");
    }
    if (tool === "Agent" || tool === "Task") {
      if (COORDINATORS.has(role) && String(input.subagent_type ?? "").startsWith("f1rm:")) return refuse("intern-role", "A role is hired with `f1rm hire`, never started as an intern.");
      const now = clock();
      const pending = (pendingInterns.get(sessionId) ?? []).filter((t) => now - t < PENDING_MS);
      const running = Object.values(state.interns).filter((i) => i.parent === sessionId).length;
      if (running + pending.length >= INTERNS) return refuse("interns", `You already have ${INTERNS} interns working, the most an employee runs at once. Wait for one to finish, or do this step yourself.`);
      pendingInterns.set(sessionId, [...pending, now]);
    }
    return null;
  }
  // The folder comes from the room the office holds, never from the request. A repo's room id is its git common dir.
  // ponytail: a submodule's common dir lives under .git/modules, so its room resolves to the wrong folder; use an employee's cwd there if it is felt.
  const folderOf = (room: string) => (basename(room) === ".git" ? dirname(room) : room);
  // A door is a git repo's main working directory or a folder with a settings file, and never a junk folder; any other cwd is Elsewhere.
  // ponytail: cached per cwd for the server's lifetime; a folder that later gets `git init` or a settings file needs a restart.
  const rooms = new Map<string, Room>();
  const roomOf = (cwd: string): Room => {
    let room = rooms.get(cwd);
    if (!room) {
      const common = machine.gitCommonDir(cwd);
      // A repo's room is its git common dir, so worktrees share it; a non-git folder is its own room.
      room = common
        ? { id: common, name: basename(basename(common) === ".git" ? dirname(common) : common).replace(/\.git$/, "") }
        : { id: cwd, name: basename(cwd) || cwd };
      if (isJunk(folderOf(room.id), junkRoots) || (!common && !(projectsDir && existsSync(projectFile(projectsDir, room.id))))) room = ELSEWHERE;
      rooms.set(cwd, room);
    }
    return room;
  };

  // The doors the user removed, by when: the events before that no longer build the room.
  const forgottenFile = projectsDir && join(dirname(projectsDir), "forgotten-doors.json");
  const forgotten = readForgotten(forgottenFile);
  // The log keeps the rooms it was written with; they are decided again here, so a rule change reaches the old events.
  for (const row of db.query("SELECT event FROM events ORDER BY id").all() as { event: string }[]) {
    try {
      const e: F1rmEvent = JSON.parse(row.event);
      e.room = roomOf(e.cwd);
      if (e.at >= (forgotten[e.room.id] ?? 0)) state = reduce(state, e);
    } catch {} // a row this build can't read must not stop the office from starting
  }

  const employeeOf = (id: string) => (Object.hasOwn(state.employees, id) ? state.employees[id] : undefined);
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

  // The process id of each session `claude agents --json` has listed, so a dead process can be told from a quiet session without spawning `claude` every few seconds.
  const pids = new Map<string, number>();
  let listedAt = -Infinity;
  // Counts SessionStarts, so a listing begun before one is not kept: its pids may be the ones a resumed session just left.
  let starts = 0;
  /** Asks `claude agents --json` for the live sessions and keeps their pids; null if it can't say. */
  async function listSessions() {
    const before = starts;
    const listed = await machine.liveSessions();
    if (before === starts) {
      listedAt = clock();
      for (const [id, pid] of listed ?? []) if (typeof pid === "number") pids.set(id, pid);
    }
    return listed;
  }
  /** The employee leaves as if its SessionEnd had come: logged, so a replay shows it, and its interns go too. The caller pushes. */
  function endSession(e: Employee) {
    if (!employeeOf(e.sessionId)) return;
    const gone = departure(e);
    append.run(gone.at, JSON.stringify(gone));
    state = reduce(state, gone);
    pids.delete(e.sessionId);
    approvals.release(e.sessionId);
  }
  const processEnded = (e: Employee) => pids.has(e.sessionId) && !isAlive(pids.get(e.sessionId)!);

  let boards: Record<string, BoardRow[]> = {};
  let teamBoards: Record<string, Record<string, BoardRow[]>> = {};
  let editions: Record<string, Edition> = {};
  const approvals = createBroker(approvalTimeoutMs, () => push());
  // Without a settings folder there is nowhere to keep an edition, so the page isn't told about editions at all and never asks.
  const snapshot = () => JSON.stringify({ ...state, boards, teamBoards, ...(projectsDir && { editions }), approvals: approvals.list() });
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
          // A new process (a resumed session keeps its id) has no known pid: ask `claude agents` for it at the next check.
          if (event.kind === "SessionStart") {
            pids.delete(event.sessionId);
            listedAt = -Infinity;
            starts++;
          }
          // ponytail: any later event drops the session's hand, so a parallel tool call can drop it early and the prompt falls back to the terminal; correlate by tool_use_id if that is felt.
          // The exception is the notification about the very prompt being held.
          if (!event.kind.startsWith("Notification/")) approvals.release(event.sessionId);
          push();
          // A company employee's first prompt may name skills to load; a successful Skill call from the session itself loads one.
          if (event.kind === "UserPromptSubmit" && state.employees[event.sessionId]?.role) {
            const prompt = String(payload.prompt ?? "");
            const at = prompt.indexOf(LOAD_FIRST);
            const required = at < 0 ? [] : prompt.slice(at + LOAD_FIRST.length).split(/\.(?:\s|$)/)[0].split(",").map((s) => s.trim()).filter(Boolean);
            const security = prompt.includes(SECURITY);
            if (required.length || security) skillGates.set(event.sessionId, { required, security, loaded: new Set() });
          }
          if (event.kind === "PostToolUse" && payload.tool_name === "Skill" && !payload.agent_id) skillGates.get(event.sessionId)?.loaded.add(String(payload.tool_input?.skill ?? ""));
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
      if (!same(given, token)) return new Response("<!doctype html><title>f1rm</title><p>Open the office with <code>f1rm</code>.", { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      if (rest.length === 0) return new Response(null, { status: 307, headers: { location: `/${given}/` } });
      const path = rest.join("/");
      if (rest.length === 2 && ["jump", "approve", "deny", "ask", "tell", "letgo", "intern", "remove"].includes(rest[0]) && req.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      }
      if (rest[0] === "jump" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        if (!pids.has(employee.sessionId) && clock() - listedAt >= PID_REFRESH_MS) await listSessions();
        if (processEnded(employee)) {
          endSession(employee);
          push();
          return Response.json({ ok: false, ended: true, error: "This session has ended" }, { status: 410 });
        }
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
      if (rest[0] === "remove" && rest.length === 2) {
        // Forgets an empty door and its edition; boards, evidence and the repo are never touched. A new session there brings the door back.
        let room = "";
        try {
          room = decodeURIComponent(rest[1]);
        } catch {} // a malformed escape names no door
        if (room === ELSEWHERE.id) return Response.json({ error: "The Elsewhere door can't be removed." }, { status: 409 });
        if (!Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such door." }, { status: 404 });
        if (Object.values(state.employees).some((e) => e.room === room)) return Response.json({ error: "That door isn't empty." }, { status: 409 });
        forgotten[room] = clock();
        if (forgottenFile) writeForgotten(forgottenFile, forgotten);
        if (projectsDir) rmSync(projectFile(projectsDir, room), { force: true });
        for (const [cwd, r] of rooms) if (r.id === room) rooms.delete(cwd); // a folder with no settings file is Elsewhere from now on
        const { [room]: _, ...kept } = state.rooms;
        state = { ...state, rooms: kept };
        const { [room]: _e, ...left } = editions;
        editions = left;
        delete boards[room];
        delete teamBoards[room];
        push();
        return Response.json({ ok: true });
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
        endSession(employee);
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
            // A Work project hires no founder role; a project with no edition chosen counts as Work.
            .filter((r) => editions[room ?? ""] === "founder" || !FOUNDER_ONLY.has(roleOfAgentType(`f1rm:${r.id}`)!))
            .sort((a, b) => order(a.id) - order(b.id))
            .map((r) => {
              const known = roleOfAgentType(`f1rm:${r.id}`);
              const working = staff.filter((e) => known && e.role === known && e.room === room && (e.status === "working" || e.status === "waiting")).length;
              return { ...r, title: known ? ROLES[known].title : r.id, working };
            }),
          hires: { working: hires, cap: CAP },
        });
      }
      if (rest[0] === "show" && rest.length === 1) {
        // A bare `f1rm` asks the open office pages to show a project, so it opens a new tab only when none is open.
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const { room } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if (typeof room !== "string" || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        const pages = server.subscriberCount("office");
        if (pages) server.publish("office", JSON.stringify({ show: room }));
        return Response.json({ pages });
      }
      if (rest[0] === "edition" && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const { room, edition } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
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
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        if (typeof role !== "string" || typeof task !== "string" || typeof brief !== "string" || !brief.trim() || brief.length > MAX_BRIEF || (model != null && typeof model !== "string") || (team != null && typeof team !== "string") || (override != null && typeof override !== "boolean")) {
          return Response.json({ error: `Hire needs a role, a task name, a model and a team that are strings, an override that is true or false, and a brief of 1 to ${MAX_BRIEF} characters.` }, { status: 400 });
        }
        const folder = folderOf(room);
        let argv: string[];
        try {
          argv = await planHire({ role, task, team: team ?? null, cwd: folder, edition: editions[room] ?? null, brief: brief.trim(), reportTo: pmOf(room) ? pmName(folder, machine) : null, model, override: override === true }, machine);
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
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
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
      const listed = quiet ? await listSessions() : new Map();
      if (!listed) return;
      const next = sweep(state, clock(), timeouts, lastActive, new Set(listed.keys()));
      if (next !== state) {
        // Replay must see the same departures, or a dead session keeps its name and the next arrival is renamed.
        for (const e of Object.values(state.employees)) {
          if (next.employees[e.sessionId]) continue;
          const gone = departure(e);
          append.run(gone.at, JSON.stringify(gone));
          approvals.release(e.sessionId);
        }
        state = next;
        push();
      }
    } finally {
      sweeping = false;
    }
  }
  // Every few seconds: sessions whose process has ended leave, whether or not their SessionEnd came (a closed terminal, `claude stop`, a crash).
  // A session claude agents never listed has no pid and keeps the quiet path of sweep().
  let checking = false;
  async function checkProcesses() {
    if (checking) return;
    checking = true;
    try {
      const employees = Object.values(state.employees);
      if (employees.some((e) => !pids.has(e.sessionId)) && clock() - listedAt >= PID_REFRESH_MS) await listSessions();
      const ended = Object.values(state.employees).filter(processEnded);
      ended.forEach(endSession);
      if (ended.length) push();
    } finally {
      checking = false;
    }
  }
  // ponytail: polls and rereads each room's board every tick; swap in fs.watch if many rooms make that heavy.
  let reading = false;
  async function readBoards() {
    if (reading) return;
    reading = true;
    try {
      const nextEditions: Record<string, Edition> = {};
      const projects = Object.keys(state.rooms).filter((id) => id !== ELSEWHERE.id); // Elsewhere has no edition and no board
      for (const id of projectsDir ? projects : []) {
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
      for (const id of projects) {
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
  // The safety net for hires nobody let go: a done f1rm hire whose branch is merged goes, with its worktree and branch.
  // ponytail: idleness is counted from when this office first saw the session done, so a restart waits another stretch; it also asks `claude agents --json --all` every tick.
  const doneSince = new Map<string, number>();
  let letting = false;
  async function letGoDone() {
    if (letting) return;
    letting = true;
    try {
      const now = clock();
      const all = (await machine.sessions()) ?? [];
      const seen = new Set<string>();
      for (const s of all) {
        const hire = s.kind === "background" && s.state === "done" ? hireTask(s.name) : null;
        if (!hire) continue;
        seen.add(s.id);
        const since = doneSince.get(s.id) ?? now;
        doneSince.set(s.id, since);
        const repo = repoOf(s.cwd);
        if (now - since < letGoAfterMs || !machine.mergedBranch(repo, `worktree-${hire.task}`)) continue;
        doneSince.set(s.id, now); // a session that can't be let go (uncommitted work) is tried again a stretch later, not every tick
        await letGoHire(machine, s, repo).catch(() => {});
      }
      for (const id of doneSince.keys()) if (!seen.has(id)) doneSince.delete(id);
    } catch {} // `claude agents` failing, or a machine without it: try again next tick
    finally {
      letting = false;
    }
  }
  const ready = Promise.all([sweepOnce(), readBoards()]);
  void letGoDone(); // not awaited: a hanging `claude agents` must not hold the office's start
  const timer = setInterval(sweepOnce, Math.min(15_000, offlineAfterMs / 4));
  const processTimer = setInterval(checkProcesses, Math.min(5_000, offlineAfterMs / 4));
  const letGoTimer = setInterval(letGoDone, Math.min(60_000, letGoAfterMs / 4));
  const boardTimer = setInterval(readBoards, boardPollMs);
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    clearInterval(timer);
    clearInterval(processTimer);
    clearInterval(letGoTimer);
    clearInterval(boardTimer);
    approvals.releaseAll();
    await stop(closeActiveConnections);
    db.close();
  };
  return server;
}
