#!/usr/bin/env bun
// The f1rm CLI: install | uninstall | start | pm
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { claudeEnv, machine } from "../server/machine.ts";
import { startServer } from "../server/server.ts";

const SETTINGS = join(process.env.HOME!, ".claude", "settings.json");
const F1RM_DIR = join(process.env.HOME!, ".f1rm");
// curl reads the secret from here, so it never appears on a command line.
const HEADERS_FILE = join(F1RM_DIR, "ingest-headers");
// What install created, so uninstall removes those containers and no others.
const CREATED_FILE = join(F1RM_DIR, "created.json");
const DEFAULT_PORT = 4170;
const SECRET_HEADER = "X-F1rm-Secret";

// Session env values each hook carries to the server, as header -> env var.
const ENV_HEADERS: Record<string, string> = {
  "X-F1rm-Iterm-Session": "ITERM_SESSION_ID",
  "X-F1rm-Term-Program": "TERM_PROGRAM",
  "X-F1rm-Messaging-Socket": "CLAUDE_CODE_MESSAGING_SOCKET",
  "X-F1rm-Messaging-Token": "CLAUDE_CODE_MESSAGING_TOKEN",
};
// Seconds; keeps a stuck office from stalling sessions. A dead office is a connection error, which Claude Code ignores.
const HOOK_TIMEOUT = 5;

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

function curlHook(url: string): Handler {
  const env = Object.entries(ENV_HEADERS).map(([h, v]) => ` -H "${h}: $${v}"`).join("");
  return {
    type: "command",
    command: `curl -s -m ${HOOK_TIMEOUT} -o /dev/null -H 'Content-Type: application/json' -H @'${HEADERS_FILE}'${env} --data-binary @- ${url} || true`,
    timeout: HOOK_TIMEOUT,
  };
}

function httpHook(url: string, secret: string): Handler {
  return {
    type: "http",
    url,
    headers: { [SECRET_HEADER]: secret, ...Object.fromEntries(Object.entries(ENV_HEADERS).map(([h, v]) => [h, `$${v}`])) },
    allowedEnvVars: Object.values(ENV_HEADERS),
    timeout: HOOK_TIMEOUT,
  };
}

// SessionStart only runs command hooks, so that one event POSTs with curl instead.
const handlerFor = (event: string, url: string, secret: string) => (event === "SessionStart" ? curlHook(url) : httpHook(url, secret));

// A handler is f1rm's only if it is exactly what install writes.
const isF1rmHttp = (h: Handler) =>
  h.type === "http" && !!h.headers?.[SECRET_HEADER] && isDeepStrictEqual(h, httpHook(String(h.url), h.headers[SECRET_HEADER]));
const isF1rmCurl = (h: Handler) => {
  const url = /--data-binary @- (\S+) \|\| true$/.exec(String(h.command))?.[1];
  return h.type === "command" && !!url && isDeepStrictEqual(h, curlHook(url));
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
  rmSync(F1RM_DIR, { recursive: true, force: true });
  console.log(`f1rm hooks removed from ${SETTINGS}`);
}

function seconds(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!(n > 0)) throw new Error(`${name} must be a positive number of seconds`);
  return n;
}

function start() {
  const hook = installed(readSettings());
  if (!hook) throw new Error("hooks not installed: run `f1rm install` first");
  const port = Number(new URL(hook.url!).port);
  const token = randomBytes(32).toString("base64url");
  const clientDir = join(import.meta.dir, "..", "client", "dist");
  if (!existsSync(clientDir)) console.error("f1rm: client not built, run `bun run build`");

  const dbPath = join(process.env.HOME!, ".f1rm", "events.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const offlineAfterMs = seconds("F1RM_OFFLINE_AFTER", 5 * 60) * 1000;
  const removeAfterMs = seconds("F1RM_REMOVE_AFTER", 15 * 60) * 1000;
  if (removeAfterMs <= offlineAfterMs) throw new Error("F1RM_REMOVE_AFTER must be longer than F1RM_OFFLINE_AFTER");

  startServer({ port, secret: hook.headers![SECRET_HEADER], token, machine, clientDir, dbPath, offlineAfterMs, removeAfterMs });
  const url = `http://127.0.0.1:${port}/${token}/`;
  console.log(`f1rm office: ${url}`);
  Bun.spawn(["open", url]);
}

// The plugin's roles ignore `skills:` as a session agent, so the PM's first prompt loads grilling as a slash command.
const PM_PROMPT =
  "/mattpocock-skills:grilling I am about to describe work for this repo. Open the interview now by asking what I want done, before you explore the repo. Make no plan until I confirm we share an understanding.";

// ponytail: extra args go to claude as given, so a variadic flag such as --allowedTools would swallow the prompt.
async function pm() {
  const proc = Bun.spawn(["claude", "--agent", "f1rm:pm", ...process.argv.slice(3), PM_PROMPT], {
    env: claudeEnv(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}

const commands: Record<string, () => void | Promise<void>> = { install, uninstall, start, pm };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: f1rm install | uninstall | start | pm [claude flags]");
  process.exit(1);
}
try {
  await command();
} catch (e) {
  console.error(`f1rm: ${(e as Error).message}`);
  process.exit(1);
}
