#!/usr/bin/env bun
// The f1rm CLI: install | uninstall | start | demo | pm | hire
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_TIMEOUT_S } from "../server/approvals.ts";
import { claudeEnv, machine } from "../server/machine.ts";
import { startServer } from "../server/server.ts";
import { hire, pmName } from "./hire.ts";

const SETTINGS = join(process.env.HOME!, ".claude", "settings.json");
const F1RM_DIR = join(process.env.HOME!, ".f1rm");
// curl reads the secret from here, so it never appears on a command line.
const HEADERS_FILE = join(F1RM_DIR, "ingest-headers");
// What install created, so uninstall removes those containers and no others.
const CREATED_FILE = join(F1RM_DIR, "created.json");
// The running office's tokenized URL, so `f1rm start` can open an office that is already up.
const URL_FILE = join(F1RM_DIR, "office-url");
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
// Seconds; keeps a stuck office from stalling sessions. A dead office is a connection error, which Claude Code ignores.
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

function curlHook(url: string, envHeaders = ENV_HEADERS): Handler {
  const env = Object.entries(envHeaders).map(([h, v]) => ` -H "${h}: $${v}"`).join("");
  return {
    type: "command",
    command: `curl -s -m ${HOOK_TIMEOUT} -o /dev/null -H 'Content-Type: application/json' -H @'${HEADERS_FILE}'${env} --data-binary @- ${url} || true`,
    timeout: HOOK_TIMEOUT,
  };
}

function httpHook(url: string, secret: string, event = "", envHeaders = ENV_HEADERS): Handler {
  return {
    type: "http",
    url,
    headers: { [SECRET_HEADER]: secret, ...Object.fromEntries(Object.entries(envHeaders).map(([h, v]) => [h, `$${v}`])) },
    allowedEnvVars: Object.values(envHeaders),
    timeout: event === "PermissionRequest" ? APPROVAL_HOOK_TIMEOUT : HOOK_TIMEOUT,
  };
}

// SessionStart only runs command hooks, so that one event POSTs with curl instead.
const handlerFor = (event: string, url: string, secret: string) => (event === "SessionStart" ? curlHook(url) : httpHook(url, secret, event));

// A handler is f1rm's only if it is exactly what install writes. The timeout is left out so an install from before it varied per event is still recognised, and replaced.
const isF1rmHttp = (h: Handler) =>
  h.type === "http" &&
  !!h.headers?.[SECRET_HEADER] &&
  SHAPES.some((env) => isDeepStrictEqual({ ...h, timeout: 0 }, { ...httpHook(String(h.url), h.headers![SECRET_HEADER], "", env), timeout: 0 }));
const isF1rmCurl = (h: Handler) => {
  const url = /--data-binary @- (\S+) \|\| true$/.exec(String(h.command))?.[1];
  return h.type === "command" && !!url && SHAPES.some((env) => isDeepStrictEqual(h, curlHook(url, env)));
};
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

/** An installed f1rm http hook handler (holding the URL and secret), if any. */
const installed = (s: Settings) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks).find(isF1rmHttp);

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

function install() {
  const before = readSettings();
  const secret = installed(before)?.headers?.[SECRET_HEADER] ?? randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:${Number(process.env.F1RM_PORT ?? DEFAULT_PORT)}/ingest`;
  const after = withoutF1rm(before);
  const created: Created = installed(before)
    ? readCreated()
    : { hooks: !before.hooks, events: EVENTS.filter((e) => !before.hooks?.[e]) };
  after.hooks ??= {};
  for (const event of EVENTS) (after.hooks[event] ??= []).push({ hooks: [handlerFor(event, url, secret)] });

  mkdirSync(F1RM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HEADERS_FILE, `${SECRET_HEADER}: ${secret}\n`, { mode: 0o600 });
  chmodSync(HEADERS_FILE, 0o600); // mode only applies to a file being created
  writeFileSync(CREATED_FILE, JSON.stringify(created));

  if (JSON.stringify(after) === JSON.stringify(before)) return console.log("f1rm hooks already installed.");
  if (existsSync(SETTINGS) && !installed(before)) copyFileSync(SETTINGS, SETTINGS + ".f1rm-backup");
  writeSettings(after);
  console.log(`f1rm hooks installed in ${SETTINGS}`);
}

function uninstall() {
  const before = readSettings();
  if (!installed(before)) return console.log("f1rm hooks are not installed.");
  const after = withoutF1rm(before);
  const created = readCreated();
  for (const event of created.events) if (after.hooks![event]?.length === 0) delete after.hooks![event];
  if (created.hooks && Object.keys(after.hooks!).length === 0) delete after.hooks;
  writeSettings(after);
  if (existsSync(PLIST)) serviceOff();
  // The event log and the PM's boards stay: they are the user's history, not install state.
  for (const f of [HEADERS_FILE, CREATED_FILE, URL_FILE]) rmSync(f, { force: true });
  console.log(`f1rm hooks removed from ${SETTINGS}`);
}

function seconds(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!(n > 0)) throw new Error(`${name} must be a positive number of seconds`);
  return n;
}

function serve() {
  const settings = readSettings();
  const hook = installed(settings);
  if (!hook) throw new Error("hooks not installed: run `f1rm install` first");
  const port = Number(new URL(hook.url!).port);
  const token = randomBytes(32).toString("base64url");
  const clientDir = join(import.meta.dir, "..", "client", "dist");
  if (!existsSync(clientDir)) console.error("f1rm: client not built, run `bun run build`");

  mkdirSync(F1RM_DIR, { recursive: true });
  const offlineAfterMs = seconds("F1RM_OFFLINE_AFTER", 5 * 60) * 1000;
  const removeAfterMs = seconds("F1RM_REMOVE_AFTER", 15 * 60) * 1000;
  if (removeAfterMs <= offlineAfterMs) throw new Error("F1RM_REMOVE_AFTER must be longer than F1RM_OFFLINE_AFTER");

  const approvalTimeout = seconds("F1RM_APPROVAL_TIMEOUT", DEFAULT_TIMEOUT_S);
  const approvalHook = (settings.hooks?.PermissionRequest ?? []).flatMap((g) => g.hooks).find(isF1rmHttp);
  if (!(Number(approvalHook?.timeout) > approvalTimeout)) throw new Error("F1RM_APPROVAL_TIMEOUT must be shorter than the installed PermissionRequest hook timeout: run `f1rm install` again, or lower it");

  startServer({ port, secret: hook.headers![SECRET_HEADER], token, machine, clientDir, dbPath: join(F1RM_DIR, "events.db"), boardsDir: join(F1RM_DIR, "boards"), offlineAfterMs, removeAfterMs, approvalTimeoutMs: approvalTimeout * 1000 });
  const url = `http://127.0.0.1:${port}/${token}/`;
  writeFileSync(URL_FILE, url, { mode: 0o600 });
  chmodSync(URL_FILE, 0o600);
  console.log(`f1rm office: ${url}`);
  return url;
}

async function runningOffice(): Promise<string | null> {
  const url = existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8").trim() : "";
  if (!url) return null;
  const up = await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  return up ? url : null;
}

/** Opens the office that is already running (the background service), or runs one here. */
async function start() {
  const running = await runningOffice();
  if (running) console.log(`f1rm office: ${running}`);
  Bun.spawn(["open", running ?? serve()]);
}

const launchctl = (...args: string[]) => Bun.spawnSync(["launchctl", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Runs the office at login and keeps it running, so the hooks always reach it. Running it again restarts it. */
function service() {
  if (process.argv[3] === "off") return serviceOff();
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
  console.log("f1rm office now runs in the background and at login. `f1rm start` opens it.");
}

function serviceOff() {
  launchctl("bootout", `gui/${process.getuid!()}/${SERVICE}`);
  rmSync(PLIST, { force: true });
  rmSync(URL_FILE, { force: true });
  console.log("f1rm background office stopped and removed.");
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
const pmPrompt = (name: string) =>
  `/mattpocock-skills:grilling Your session name is ${name}. Hires report to it. I am about to describe work for this repo. Open the interview now by asking what I want done, before you explore the repo. Make no plan until I confirm we share an understanding.`;

// ponytail: extra args go to claude as given, so a variadic flag such as --allowedTools would swallow the prompt.
async function pm() {
  const name = pmName(process.cwd());
  const proc = Bun.spawn(["claude", "--agent", "f1rm:pm", "--name", name, ...process.argv.slice(3), pmPrompt(name)], {
    env: claudeEnv(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}

const commands: Record<string, () => void | Promise<void>> = {
  install,
  uninstall,
  start,
  serve: () => void serve(),
  service,
  demo,
  pm,
  hire: async () => process.exit(await hire(process.argv.slice(3))),
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: f1rm install | uninstall | start | service [off] | serve | demo | pm [claude flags] | hire <role> <name> <task> <brief>");
  process.exit(1);
}
try {
  await command();
} catch (e) {
  console.error(`f1rm: ${(e as Error).message}`);
  process.exit(1);
}
