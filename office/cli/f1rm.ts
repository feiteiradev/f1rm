#!/usr/bin/env bun
// The f1rm CLI: (bare) | install | uninstall | start | service | demo | edition | pm | hire | letgo
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_TIMEOUT_S } from "../server/approvals.ts";
import { agents, claudeEnv, machine } from "../server/machine.ts";
import { startServer } from "../server/server.ts";
import { hire, pmName } from "./hire.ts";
import { letgo } from "./letgo.ts";
import { editionFile, isEdition, projectsDir, readEdition, writeEdition, type Edition } from "../server/editions.ts";
import { roomName } from "../server/board.ts";

const SETTINGS = join(process.env.HOME!, ".claude", "settings.json");
const F1RM_DIR = join(process.env.HOME!, ".f1rm");
// curl reads the secret from here, so it never appears on a command line.
const HEADERS_FILE = join(F1RM_DIR, "ingest-headers");
// What install created, so uninstall removes those containers and no others.
const CREATED_FILE = join(F1RM_DIR, "created.json");
// The running office's tokenized URL, so `f1rm start` can open an office that is already up.
const URL_FILE = join(F1RM_DIR, "office-url");
const URL_TMP = `${URL_FILE}.tmp`; // serve writes here, then renames over URL_FILE
// The token in that URL, kept across restarts until uninstall (or the user) deletes it.
const LINK_KEY_FILE = join(F1RM_DIR, "link-key");
// The `f1rm` command `install` puts on PATH, so a terminal finds this clone.
const BIN = join(process.env.HOME!, ".local", "bin", "f1rm");
const CLI_FILE = join(import.meta.dir, "f1rm.ts");
const binScript = () => `#!/bin/sh\n# f1rm's command, written by \`f1rm install\`.\nexec "${process.execPath}" "${CLI_FILE}" "$@"\n`;
/** A PATH command that runs f1rm's CLI is ours to replace or remove; anything else at that path is left alone. */
const binIsOurs = () => !existsSync(BIN) || readFileSync(BIN, "utf8").includes("office/cli/f1rm.ts");
const SERVICE = "dev.f1rm.office";
const PLIST = join(process.env.HOME!, "Library", "LaunchAgents", `${SERVICE}.plist`);
const DEFAULT_PORT = 4170;
const SECRET_HEADER = "X-F1rm-Secret";

// Session env values each hook carries to the server, as header -> env var. Not the messaging token: Tell works
// without it (spec amendment 2), and curl would carry it on its command line.
const ENV_HEADERS: Record<string, string> = {
  "X-F1rm-Iterm-Session": "ITERM_SESSION_ID",
  "X-F1rm-Term-Program": "TERM_PROGRAM",
  "X-F1rm-Messaging-Socket": "CLAUDE_CODE_MESSAGING_SOCKET",
};
// Installs from before amendment 2 also forwarded the token. They are still f1rm's: install upgrades them, uninstall removes them.
const SHAPES = [ENV_HEADERS, { ...ENV_HEADERS, "X-F1rm-Messaging-Token": "CLAUDE_CODE_MESSAGING_TOKEN" }];
// Seconds; keeps a stuck office from stalling sessions.
const HOOK_TIMEOUT = 5;
// PermissionRequest is held for the browser, so its hook must outlast the broker or Claude Code cancels the hook before the broker answers.
const APPROVAL_HOOK_TIMEOUT = 2 * DEFAULT_TIMEOUT_S;

// Not WorktreeCreate: a hook there replaces git's worktree creation, so observing it would break --worktree.
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "CwdChanged",
];

type Handler = { type: string; url?: string; headers?: Record<string, string>; [k: string]: unknown };
type Settings = { hooks?: Record<string, { matcher?: string; hooks: Handler[] }[]>; [k: string]: unknown };

type Created = { hooks: boolean; events: string[] };

/**
 * Every f1rm hook is curl, not an `http` hook: Claude Code shows a stopped office's refused connection as an error on every
 * http hook, while `|| true` keeps a command hook silent. curl prints the office's reply, which carries a hold or a decision
 * (PermissionRequest, PreToolUse) for Claude Code to read; -f keeps an error page out of that reply.
 */
function curlHook(url: string, event = "", envHeaders = ENV_HEADERS): Handler {
  const timeout = event === "PermissionRequest" ? APPROVAL_HOOK_TIMEOUT : HOOK_TIMEOUT;
  const env = Object.entries(envHeaders).map(([h, v]) => ` -H "${h}: $${v}"`).join("");
  return {
    type: "command",
    command: `curl -sf -m ${timeout} -H 'Content-Type: application/json' -H @'${HEADERS_FILE}'${env} --data-binary @- ${url} || true`,
    timeout,
  };
}

// Installs from before every hook was curl used http hooks. They are still f1rm's: install replaces them, uninstall removes them.
function httpHook(url: string, secret: string, event = "", envHeaders = ENV_HEADERS): Handler {
  return {
    type: "http",
    url,
    headers: { [SECRET_HEADER]: secret, ...Object.fromEntries(Object.entries(envHeaders).map(([h, v]) => [h, `$${v}`])) },
    allowedEnvVars: Object.values(envHeaders),
    timeout: event === "PermissionRequest" ? APPROVAL_HOOK_TIMEOUT : HOOK_TIMEOUT,
  };
}

const handlerFor = (event: string, url: string) => curlHook(url, event);

// A handler is f1rm's only if it is exactly what install writes. The timeout is left out so an install from before it varied per event is still recognised, and replaced.
const isF1rmHttp = (h: Handler) =>
  h.type === "http" &&
  !!h.headers?.[SECRET_HEADER] &&
  SHAPES.some((env) => isDeepStrictEqual({ ...h, timeout: 0 }, { ...httpHook(String(h.url), h.headers![SECRET_HEADER], "", env), timeout: 0 }));
// A curl hook is f1rm's when it posts f1rm's secret file to an /ingest URL; nothing else reads ~/.f1rm/ingest-headers.
const isF1rmCurl = (h: Handler) =>
  h.type === "command" && String(h.command).includes(`-H @'${HEADERS_FILE}'`) && /--data-binary @- http:\/\/127\.0\.0\.1:\d+\/ingest \|\| true$/.test(String(h.command));
const isF1rm = (h: Handler) => isF1rmHttp(h) || isF1rmCurl(h);

function readSettings(): Settings {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch (e) {
    throw new Error(`can't parse ${SETTINGS}, leaving it untouched: ${(e as Error).message}`);
  }
}

function writeSettings(settings: Settings) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

const f1rmHandlers = (s: Settings) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks).filter(isF1rm);
/** Where the installed hooks post, and their secret; null when f1rm's hooks aren't installed. */
function installed(s: Settings): { url: string; secret: string } | null {
  const [h] = f1rmHandlers(s);
  if (!h) return null;
  if (h.type === "http") return { url: String(h.url), secret: h.headers![SECRET_HEADER] };
  const url = /(http:\/\/127\.0\.0\.1:\d+\/ingest) \|\| true$/.exec(String(h.command))?.[1];
  const secret = existsSync(HEADERS_FILE) ? readFileSync(HEADERS_FILE, "utf8").split(": ")[1]?.trim() : undefined;
  return url && secret ? { url, secret } : null;
}
/** Hooks from an older install (http hooks, which show errors while the office is stopped) that install would replace. */
const outdated = (s: Settings) => f1rmHandlers(s).some(isF1rmHttp);

/** Removes f1rm's handlers, and the groups that held only them. */
function withoutF1rm(s: Settings): Settings {
  if (!s.hooks) return { ...s };
  const hooks: NonNullable<Settings["hooks"]> = {};
  for (const [event, groups] of Object.entries(s.hooks)) {
    hooks[event] = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isF1rm(h)) }))
      .filter((g, i) => g.hooks.length > 0 || groups[i].hooks.length === 0);
  }
  return { ...s, hooks };
}

const readCreated = (): Created => {
  try {
    return JSON.parse(readFileSync(CREATED_FILE, "utf8"));
  } catch {
    return { hooks: false, events: [] };
  }
};

/** Adds f1rm's hooks, and the `f1rm` command to `~/.local/bin`. Returns what it did, a line each. */
function install(): string[] {
  const done = [installBin()];
  const before = readSettings();
  const secret = installed(before)?.secret ?? randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:${Number(process.env.F1RM_PORT ?? DEFAULT_PORT)}/ingest`;
  const after = withoutF1rm(before);
  const created: Created = installed(before)
    ? readCreated()
    : { hooks: !before.hooks, events: EVENTS.filter((e) => !before.hooks?.[e]) };
  after.hooks ??= {};
  for (const event of EVENTS) (after.hooks[event] ??= []).push({ hooks: [handlerFor(event, url)] });

  mkdirSync(F1RM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HEADERS_FILE, `${SECRET_HEADER}: ${secret}\n`, { mode: 0o600 });
  chmodSync(HEADERS_FILE, 0o600); // mode only applies to a file being created
  writeFileSync(CREATED_FILE, JSON.stringify(created));

  if (JSON.stringify(after) === JSON.stringify(before)) return ["f1rm hooks already installed.", ...done];
  if (existsSync(SETTINGS) && !installed(before)) copyFileSync(SETTINGS, SETTINGS + ".f1rm-backup");
  writeSettings(after);
  return [`f1rm hooks installed in ${SETTINGS}`, ...done];
}

function installBin(): string {
  if (!binIsOurs()) return `${BIN} exists and isn't f1rm's, so it was left alone.`;
  mkdirSync(dirname(BIN), { recursive: true });
  writeFileSync(BIN, binScript(), { mode: 0o755 });
  chmodSync(BIN, 0o755);
  const onPath = (process.env.PATH ?? "").split(":").includes(dirname(BIN));
  return onPath ? `f1rm command installed in ${BIN}.` : `f1rm command installed in ${BIN}. Add ${dirname(BIN)} to your PATH to run it from anywhere.`;
}

function uninstall() {
  const before = readSettings();
  if (!installed(before)) return console.log("f1rm hooks are not installed.");
  const after = withoutF1rm(before);
  const created = readCreated();
  for (const event of created.events) if (after.hooks![event]?.length === 0) delete after.hooks![event];
  if (created.hooks && Object.keys(after.hooks!).length === 0) delete after.hooks;
  writeSettings(after);
  if (existsSync(PLIST)) stopService();
  // The event log, the boards and the editions stay: they are the user's history, not install state.
  for (const f of [HEADERS_FILE, CREATED_FILE, LINK_KEY_FILE]) rmSync(f, { force: true });
  removeOfficeFiles();
  if (existsSync(BIN) && binIsOurs()) rmSync(BIN);
  console.log(`f1rm hooks removed from ${SETTINGS}`);
}

function seconds(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!(n > 0)) throw new Error(`${name} must be a positive number of seconds`);
  return n;
}

/** The office's UI token. It lives in a private file, so a restart keeps the URL and open tabs keep working; a missing or malformed file gets a new key. */
function linkKey(): string {
  mkdirSync(F1RM_DIR, { recursive: true, mode: 0o700 });
  const saved = () => {
    const key = existsSync(LINK_KEY_FILE) ? readFileSync(LINK_KEY_FILE, "utf8").trim() : "";
    return /^[\w-]{43}$/.test(key) ? key : "";
  };
  const kept = saved();
  if (kept) {
    chmodSync(LINK_KEY_FILE, 0o600); // a file others could read is made private again
    return kept;
  }
  // The new key goes into a private temp file first, so it is never in a file others can read, then is put in place whole.
  const key = randomBytes(32).toString("base64url");
  const tmp = `${LINK_KEY_FILE}.${process.pid}`;
  rmSync(tmp, { force: true }); // a leftover of an earlier serve with this pid would keep its mode
  writeFileSync(tmp, key + "\n", { mode: 0o600, flag: "wx" }); // wx: never opens a file or link that appeared since the rm
  try {
    linkSync(tmp, LINK_KEY_FILE); // fails when the file exists, e.g. another start got there first
    return key;
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    // ponytail: two starts that both find a malformed file may each replace it; only a missing file is raced safely
    const other = saved();
    if (other) return other;
    renameSync(tmp, LINK_KEY_FILE);
    return key;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function serve() {
  const settings = readSettings();
  const hook = installed(settings);
  if (!hook) throw new Error("hooks not installed: run `f1rm install` first");
  const port = Number(new URL(hook.url).port);
  const token = linkKey();
  const clientDir = join(import.meta.dir, "..", "client", "dist");
  if (!existsSync(clientDir)) console.error("f1rm: client not built, run `bun run build`");

  const offlineAfterMs = seconds("F1RM_OFFLINE_AFTER", 5 * 60) * 1000;
  const removeAfterMs = seconds("F1RM_REMOVE_AFTER", 15 * 60) * 1000;
  if (removeAfterMs <= offlineAfterMs) throw new Error("F1RM_REMOVE_AFTER must be longer than F1RM_OFFLINE_AFTER");

  const approvalTimeout = seconds("F1RM_APPROVAL_TIMEOUT", DEFAULT_TIMEOUT_S);
  const approvalHook = (settings.hooks?.PermissionRequest ?? []).flatMap((g) => g.hooks).find(isF1rm);
  if (!(Number(approvalHook?.timeout) > approvalTimeout)) throw new Error("F1RM_APPROVAL_TIMEOUT must be shorter than the installed PermissionRequest hook timeout: run `f1rm install` again, or lower it");

  startServer({ port, secret: hook.secret, token, machine, clientDir, dbPath: join(F1RM_DIR, "events.db"), boardsDir: join(F1RM_DIR, "boards"), projectsDir: projectsDir(), offlineAfterMs, removeAfterMs, approvalTimeoutMs: approvalTimeout * 1000 });
  const url = `http://127.0.0.1:${port}/${token}/`;
  rmSync(URL_TMP, { force: true }); // a stale one would keep its old mode
  writeFileSync(URL_TMP, url, { mode: 0o600, flag: "wx" }); // wx: never opens a file or link that appeared since the rm
  renameSync(URL_TMP, URL_FILE); // one step, so a reader never sees the file empty
  // Under launchd stdout is office.log, which is not private: the link stays in office-url (0600), which `f1rm` reads.
  announce(url);
  return url;
}

/** Prints the link to a terminal, else only the port: under launchd stdout is a log. */
function announce(url: string) {
  console.log(process.stdout.isTTY ? `f1rm office: ${url}` : `f1rm office: running on port ${new URL(url).port}`);
}

async function runningOffice(): Promise<string | null> {
  const url = existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8").trim() : "";
  if (!url) return null;
  const up = await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  return up ? url : null;
}

/** Opens the running office, starting the background one first when none is up, and exits. `f1rm serve` runs one in this terminal. */
async function start() {
  const url = (await runningOffice()) ?? (await startBackgroundOffice());
  announce(url);
  Bun.spawn(["open", url]);
}

/** Starts the background office and waits for its URL; throws when it doesn't come up. */
async function startBackgroundOffice(): Promise<string> {
  startService();
  const url = await officeWithin(Number(process.env.F1RM_WAIT_MS ?? 15_000));
  if (!url) throw new Error(`the office didn't start; see ${join(F1RM_DIR, "office.log")}`);
  return url;
}

const launchctl = (...args: string[]) => Bun.spawnSync(["launchctl", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Runs the office at login and keeps it running, so the hooks always reach it. Running it again restarts it. */
function service() {
  if (process.argv[3] === "off") return serviceOff();
  startService();
  console.log("f1rm office now runs in the background and at login. `f1rm start` opens it.");
}

function startService() {
  if (!installed(readSettings())) throw new Error("hooks not installed: run `f1rm install` first");
  const log = join(F1RM_DIR, "office.log");
  const args = [process.execPath, join(import.meta.dir, "f1rm.ts"), "serve"].map((a) => `<string>${xml(a)}</string>`).join("");
  // launchd starts with a bare PATH; the office needs this one to find claude, git and osascript.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "")}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
  const domain = `gui/${process.getuid!()}`;
  launchctl("bootout", `${domain}/${SERVICE}`);
  // bootout returns before launchd has finished stopping a running office; bootstrap fails until it has.
  let tries = 20;
  while (launchctl("bootstrap", domain, PLIST) !== 0) {
    if (--tries === 0) throw new Error(`launchctl could not load ${PLIST}; see ${log}`);
    Bun.sleepSync(250);
  }
}

function serviceOff() {
  stopService();
  removeOfficeFiles();
  console.log("f1rm background office stopped and removed.");
}

function stopService() {
  launchctl("bootout", `gui/${process.getuid!()}/${SERVICE}`);
  rmSync(PLIST, { force: true });
}

/** What a serve leaves behind: its URL, the temp it writes the URL to, and a link-key.<pid> temp, which is a hard link to the live key when serve was killed mid-write. */
function removeOfficeFiles() {
  for (const f of [URL_FILE, URL_TMP]) rmSync(f, { force: true });
  if (existsSync(F1RM_DIR)) for (const f of readdirSync(F1RM_DIR)) if (f.startsWith("link-key.")) rmSync(join(F1RM_DIR, f), { force: true });
}

/** The running office's URL, once it answers, or null after `ms`. */
async function officeWithin(ms: number): Promise<string | null> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) {
    const url = await runningOffice();
    if (url) return url;
  }
  return null;
}

/** A bare `f1rm`, typed in a project's folder. Prints one line, and never the office's token. */
async function open() {
  const room = machine.gitCommonDir(process.cwd()) ?? process.cwd();
  const name = roomName(room);
  const notes: string[] = [];
  const settings = readSettings();
  if (!installed(settings)) {
    install();
    notes.push("installed f1rm's hooks after backing up your settings; restart Claude Code sessions that are already open so they appear");
  } else if (outdated(settings)) {
    install();
    notes.push("updated f1rm's hooks, so a stopped office no longer shows hook errors");
  }
  let url = await runningOffice();
  if (!url) {
    try {
      url = await startBackgroundOffice();
    } catch (e) {
      // What was changed in settings.json is still worth saying when the office then fails to start.
      if (notes.length) console.error(`f1rm: ${notes.join("; ")}.`);
      throw e;
    }
    notes.push("started it in the background");
  }
  // An office page already open moves to this project; only with none open does a new tab open on it.
  const shown = await fetch(new URL("show", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room }) })
    .then(async (r) => r.ok && ((await r.json()) as { pages: number }).pages > 0)
    .catch(() => false);
  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  if (shown) {
    console.log(`Your office tab now shows ${name}${suffix}.`);
  } else {
    Bun.spawn(["open", `${url}#/project/${encodeURIComponent(room)}`]);
    console.log(`Opened the f1rm office on ${name}${suffix}.`);
  }
}

// The recorded office on its own static build: no hooks, no database, no session of yours involved.
function demo() {
  const dir = join(import.meta.dir, "..", "demo", "dist");
  if (!existsSync(dir)) throw new Error("demo not built, run `bun run build`");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.F1RM_DEMO_PORT ?? 4171),
    async fetch(req) {
      const file = resolve(dir, "." + decodeURIComponent(new URL(req.url).pathname).replace(/\/$/, "/index.html"));
      if (!file.startsWith(dir + sep) || !(await Bun.file(file).exists())) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file));
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`f1rm demo: ${url}`);
  Bun.spawn(["open", url]);
}

// The plugin's roles ignore `skills:` as a session agent, so the PM's first prompt loads grilling as a slash command.
// The name comes after it so hires can address their reports to it.
const EDITION_LINE: Record<Edition, string> = {
  work: "This is a Work project: an engineering company.",
  founder: "This is a Founder project: follow the founder playbook in the guidelines.",
};
const pmPrompt = (name: string, edition: Edition) =>
  `/mattpocock-skills:grilling Your session name is ${name}. Hires report to it. Hire only leads with \`f1rm hire lead\`, one or two per milestone even for one task, and answer each \`PLAN <team>\` with \`GO <team>\` without telling me, unless the plan changes agreed scope or a decision. Speak to me only for a decision I must make, something only I can do (a permission, spend, credentials or inputs, a git push, a dirty main checkout), and one report at the end of the milestone; the rest stays on the board. ${EDITION_LINE[edition]} First pick up: read this repo's board and \`claude agents --json\`, run \`claude logs <id>\` for each hire on a \`doing\` or \`review\` row, update the rows, say nothing, and answer when I ask "status?"; with no board, skip this. Then open the interview by asking what I want done, before you explore the repo. Make no plan until I confirm we share an understanding.`;

/** `f1rm edition` prints this repo's edition; `f1rm edition work|founder` sets it. */
function edition() {
  const want = process.argv[3];
  if (want === undefined) return console.log(readEdition(editionFile(process.cwd())) ?? "none chosen yet (counts as work)");
  if (!isEdition(want)) throw new Error("usage: f1rm edition [work|founder]");
  writeEdition(editionFile(process.cwd()), want);
  console.log(`edition: ${want}`);
}

// ponytail: extra args go to claude as given, so a variadic flag such as --allowedTools would swallow the prompt.
async function pm() {
  const name = pmName(process.cwd());
  // One PM per repo: two would write one board. If Claude Code can't list its sessions, the user still gets a PM.
  if ((await agents(false))?.some((a) => a?.name === name)) throw new Error(`${name} is already running for this repo. Talk to it, or stop it before starting another.`);
  // The first PM in a repo sets its edition. With no answer (no terminal), it starts as Work and asks again next time.
  let chosen = readEdition(editionFile(process.cwd()));
  if (!chosen) {
    const answer = prompt(`Is ${name.slice(3)} a Work or a Founder project? [w/f]`)?.trim().toLowerCase() ?? "";
    chosen = answer.startsWith("f") ? "founder" : answer.startsWith("w") ? "work" : null;
    if (chosen) writeEdition(editionFile(process.cwd()), chosen);
  }
  const proc = Bun.spawn(["claude", "--agent", "f1rm:pm", "--name", name, ...process.argv.slice(3), pmPrompt(name, chosen ?? "work")], {
    env: claudeEnv(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}

const commands: Record<string, () => void | Promise<void>> = {
  install: () => install().forEach((line) => console.log(line)),
  uninstall,
  start,
  serve: () => void serve(),
  service,
  demo,
  edition,
  "": open,
  pm,
  hire: async () => process.exit(await hire(process.argv.slice(3))),
  letgo: async () => {
    const names = process.argv.slice(3);
    if (!names.length) throw new Error("usage: f1rm letgo <name>...");
    const r = await letgo(names, machine, process.cwd());
    console.log(r.lines.join("\n"));
    process.exit(r.ok ? 0 : 1);
  },
};
const USAGE = "usage: f1rm | install | uninstall | start | service [off] | serve | demo | edition [work|founder] | pm [claude flags] | hire <role> <name> <task> <brief> | letgo <name>...";
const arg = process.argv[2] ?? "";
if (["help", "-h", "--help"].includes(arg)) {
  console.log(USAGE);
  process.exit(0);
}
const command = Object.hasOwn(commands, arg) ? commands[arg] : undefined;
if (!command) {
  console.error(USAGE);
  process.exit(1);
}
try {
  await command();
} catch (e) {
  console.error(`f1rm: ${(e as Error).message}`);
  process.exit(1);
}
