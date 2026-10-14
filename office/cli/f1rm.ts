#!/usr/bin/env bun
// The f1rm CLI: install | uninstall | start
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { machine } from "../server/machine.ts";
import { startServer } from "../server/server.ts";

const SETTINGS = join(process.env.HOME!, ".claude", "settings.json");
const DEFAULT_PORT = 4170;
const SECRET_HEADER = "X-F1rm-Secret";

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

const isF1rm = (h: Handler) => h.type === "http" && !!h.headers?.[SECRET_HEADER];

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

/** The installed f1rm hook handler, if any. */
const installed = (s: Settings) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks).find(isF1rm);

/** Removes f1rm's handlers, and any group, event or hooks object that only held them. */
function withoutF1rm(s: Settings): Settings {
  if (!s.hooks) return { ...s };
  const hooks: NonNullable<Settings["hooks"]> = {};
  for (const [event, groups] of Object.entries(s.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isF1rm(h)) }))
      .filter((g, i) => g.hooks.length > 0 || groups[i].hooks.length === 0);
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = s;
  return Object.keys(hooks).length > 0 || Object.keys(s.hooks).length === 0 ? { ...rest, hooks } : rest;
}

function install() {
  const before = readSettings();
  const secret = installed(before)?.headers?.[SECRET_HEADER] ?? randomBytes(32).toString("base64url");
  const port = Number(process.env.F1RM_PORT ?? DEFAULT_PORT);
  const handler: Handler = {
    type: "http",
    url: `http://127.0.0.1:${port}/ingest`,
    headers: { [SECRET_HEADER]: secret },
  };
  const after = withoutF1rm(before);
  after.hooks ??= {};
  for (const event of EVENTS) (after.hooks[event] ??= []).push({ hooks: [handler] });

  if (JSON.stringify(after) === JSON.stringify(before)) return console.log("f1rm hooks already installed.");
  if (existsSync(SETTINGS) && !installed(before)) copyFileSync(SETTINGS, SETTINGS + ".f1rm-backup");
  writeSettings(after);
  console.log(`f1rm hooks installed in ${SETTINGS}`);
}

function uninstall() {
  const before = readSettings();
  if (!installed(before)) return console.log("f1rm hooks are not installed.");
  writeSettings(withoutF1rm(before));
  console.log(`f1rm hooks removed from ${SETTINGS}`);
}

function start() {
  const hook = installed(readSettings());
  if (!hook) throw new Error("hooks not installed: run `f1rm install` first");
  const port = Number(new URL(hook.url!).port);
  const token = randomBytes(32).toString("base64url");
  const clientDir = join(import.meta.dir, "..", "client", "dist");
  if (!existsSync(clientDir)) console.error("f1rm: client not built, run `bun run build`");

  startServer({ port, secret: hook.headers![SECRET_HEADER], token, machine, clientDir });
  const url = `http://127.0.0.1:${port}/${token}/`;
  console.log(`f1rm office: ${url}`);
  Bun.spawn(["open", url]);
}

const commands: Record<string, () => void | Promise<void>> = { install, uninstall, start };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: f1rm install | uninstall | start");
  process.exit(1);
}
try {
  await command();
} catch (e) {
  console.error(`f1rm: ${(e as Error).message}`);
  process.exit(1);
}
