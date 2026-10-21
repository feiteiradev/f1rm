// Seam 2: the real f1rm CLI, run with a temporary HOME.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_S } from "../server/approvals.ts";
import { machine } from "../server/machine.ts";
import { SLUG } from "./hire.ts";
import { hireTask, letgo } from "./letgo.ts";

const CLI = join(import.meta.dir, "f1rm.ts");

function tempHome(settings?: object) {
  const home = mkdtempSync(join(tmpdir(), "f1rm-home-"));
  mkdirSync(join(home, ".claude"));
  if (settings) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  return home;
}
const settingsOf = (home: string) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

function f1rm(home: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, HOME: home } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const userSettings = {
  model: "opus",
  permissions: { allow: ["Bash(git status)"] },
  env: { FOO: "bar" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

const f1rmHandlers = (settings: any) =>
  Object.entries(settings.hooks ?? {}).flatMap(([event, groups]: [string, any]) =>
    groups.flatMap((g: any) =>
      g.hooks
        .filter((h: any) => /X-F1rm-Secret|\.f1rm\/ingest-headers/.test(JSON.stringify(h)))
        .map((h: any) => ({ event, matcher: g.matcher, ...h })),
    ),
  );
const secretOf = (home: string) => readFileSync(join(home, ".f1rm", "ingest-headers"), "utf8").split(": ")[1].trim();

test("install adds a hook with the ingest secret for every observed event, keeping everything else", () => {
  const home = tempHome(userSettings);
  const { code } = f1rm(home, "install");
  expect(code).toBe(0);

  const settings = settingsOf(home);
  expect(settings.model).toBe("opus");
  expect(settings.permissions).toEqual(userSettings.permissions);
  expect(settings.env).toEqual(userSettings.env);
  expect(settings.hooks.PreToolUse[0]).toEqual(userSettings.hooks.PreToolUse[0]);
  expect(settings.hooks.Stop[0]).toEqual(userSettings.hooks.Stop[0]);

  const handlers = f1rmHandlers(settings);
  const secret = secretOf(home);
  expect(secret).toMatch(/^[\w-]{32,}$/);
  const headersFile = join(home, ".f1rm", "ingest-headers");
  expect(readFileSync(headersFile, "utf8")).toBe(`X-F1rm-Secret: ${secret}\n`);
  expect(statSync(headersFile).mode & 0o777).toBe(0o600);

  // Every hook is curl, never an http hook: Claude Code shows an http hook's refused connection as an error whenever the
  // office is stopped, while `|| true` keeps curl silent. curl prints the office's reply, which carries its decisions.
  expect(handlers.map((h) => h.event).sort()).toEqual(
    ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "SubagentStart", "SubagentStop", "CwdChanged"].sort(),
  );
  for (const h of handlers) {
    expect(h.type).toBe("command");
    expect(h.matcher).toBeUndefined(); // every tool, every notification
    expect(h.command).toStartWith("curl -sf ");
    expect(h.command).toContain(`-H @'${headersFile}'`);
    expect(h.command).toEndWith("--data-binary @- http://127.0.0.1:4170/ingest || true");
    expect(h.command).not.toContain(secret); // argv is world-readable via ps
    // a stuck office must not stall sessions, except that the permission hook is held for the browser
    if (h.event === "PermissionRequest") expect(h.timeout).toBeGreaterThan(DEFAULT_TIMEOUT_S);
    else expect(h.timeout).toBeLessThanOrEqual(5);
    expect(h.command).toContain(`-m ${h.timeout} `);
  }

  expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json.f1rm-backup"), "utf8"))).toEqual(userSettings);
});

test("install is idempotent and keeps the same secret", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  const first = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  expect(f1rm(home, "install").code).toBe(0);
  expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(first);
  // the backup still holds the pre-f1rm original
  expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json.f1rm-backup"), "utf8"))).toEqual(userSettings);
});

test("install gives a hook installed with the old 5 s timeout the longer permission timeout, once", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  const old = settingsOf(home);
  old.hooks.PermissionRequest[0].hooks[0].timeout = 5;
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(old, null, 2) + "\n");

  f1rm(home, "install");
  const upgraded = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  const permission = f1rmHandlers(JSON.parse(upgraded)).filter((h) => h.event === "PermissionRequest");
  expect(permission.map((h) => h.timeout)).toEqual([2 * DEFAULT_TIMEOUT_S]);
  f1rm(home, "install");
  expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(upgraded);
});

test("install collects no messaging token, so no hook puts it on curl's command line", () => {
  const home = tempHome();
  f1rm(home, "install");
  expect(JSON.stringify(settingsOf(home))).not.toContain("MESSAGING_TOKEN");
});

test("an older install's http hooks, with or without the messaging token, become curl hooks in place, then uninstall exactly", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  const secret = secretOf(home);
  // What installs before every hook was curl wrote: SessionStart by curl to /dev/null, every other event an http hook.
  const old = structuredClone(userSettings) as any;
  const headersFile = join(home, ".f1rm", "ingest-headers");
  const env = ["ITERM_SESSION_ID", "TERM_PROGRAM", "CLAUDE_CODE_MESSAGING_SOCKET"];
  const http = (event: string, token: boolean) => ({
    type: "http",
    url: "http://127.0.0.1:4170/ingest",
    headers: {
      "X-F1rm-Secret": secret, "X-F1rm-Iterm-Session": "$ITERM_SESSION_ID", "X-F1rm-Term-Program": "$TERM_PROGRAM", "X-F1rm-Messaging-Socket": "$CLAUDE_CODE_MESSAGING_SOCKET",
      ...(token && { "X-F1rm-Messaging-Token": "$CLAUDE_CODE_MESSAGING_TOKEN" }),
    },
    allowedEnvVars: token ? [...env, "CLAUDE_CODE_MESSAGING_TOKEN"] : env,
    timeout: event === "PermissionRequest" ? 2 * DEFAULT_TIMEOUT_S : 5,
  });
  const events = ["SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "SubagentStart", "SubagentStop", "CwdChanged"];
  old.hooks.SessionStart = [{ hooks: [{ type: "command", command: `curl -s -m 5 -o /dev/null -H 'Content-Type: application/json' -H @'${headersFile}' -H "X-F1rm-Iterm-Session: $ITERM_SESSION_ID" -H "X-F1rm-Term-Program: $TERM_PROGRAM" -H "X-F1rm-Messaging-Socket: $CLAUDE_CODE_MESSAGING_SOCKET" --data-binary @- http://127.0.0.1:4170/ingest || true`, timeout: 5 }] }];
  events.forEach((event, i) => (old.hooks[event] ??= []).push({ hooks: [http(event, i % 2 === 0)] }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(old, null, 2) + "\n");

  expect(f1rm(home, "install").code).toBe(0);
  const upgraded = settingsOf(home);
  expect(JSON.stringify(upgraded)).not.toContain("MESSAGING_TOKEN");
  expect(f1rmHandlers(upgraded).map((h) => h.type)).toEqual(Array(12).fill("command"));
  expect(secretOf(home)).toBe(secret);
  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(settingsOf(home)).toEqual(userSettings);
});

test("serve refuses an approval timeout the installed permission hook would not outlast", () => {
  const home = tempHome();
  f1rm(home, "install");
  const refused = Bun.spawnSync(["bun", CLI, "serve"], { env: { ...process.env, HOME: home, F1RM_APPROVAL_TIMEOUT: String(2 * DEFAULT_TIMEOUT_S) }, timeout: 5000 });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("F1RM_APPROVAL_TIMEOUT must be shorter");
});

test("uninstall removes exactly what install added", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  // the user changes something unrelated while f1rm is installed
  const changed = settingsOf(home);
  changed.theme = "dark";
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(changed));

  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(settingsOf(home)).toEqual({ ...userSettings, theme: "dark" });
});

test("uninstall removes the ingest header file", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  expect(existsSync(join(home, ".f1rm", "ingest-headers"))).toBe(true);
  f1rm(home, "uninstall");
  expect(existsSync(join(home, ".f1rm", "ingest-headers"))).toBe(false);
});

const lookalike = { type: "command", command: "echo X-F1rm-Secret >> /tmp/log" };
test.each([
  ["an empty hooks object", { hooks: {} }],
  ["an empty event list", { hooks: { Stop: [] } }],
  ["an empty group", { hooks: { Stop: [{ hooks: [] }] } }],
  ["a command hook that merely mentions the header", { hooks: { Stop: [{ hooks: [lookalike] }] } }],
  ["an http hook of its own carrying the header", { hooks: { Stop: [{ hooks: [{ type: "http", url: "https://example.com/x", headers: { "X-F1rm-Secret": "mine" } }] }] } }],
])("install then uninstall leaves %s as it was", (_, settings) => {
  const home = tempHome(settings);
  f1rm(home, "install");
  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(settingsOf(home)).toEqual(settings);
});

test("install and uninstall work when there are no settings yet", () => {
  const home = tempHome();
  expect(f1rm(home, "install").code).toBe(0);
  expect(f1rmHandlers(settingsOf(home)).length).toBeGreaterThan(0);
  expect(existsSync(join(home, ".claude", "settings.json.f1rm-backup"))).toBe(false);
  f1rm(home, "uninstall");
  expect(settingsOf(home)).toEqual({});
});

// Runs `serve` once and returns the URL it wrote to office-url (it prints the URL only to a terminal); the office is stopped before this returns.
async function serveOnce(home: string) {
  const urlFile = join(home, ".f1rm", "office-url");
  rmSync(urlFile, { force: true });
  const proc = Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "ignore" });
  try {
    for (let i = 0; i < 200; i++) {
      if (proc.exitCode !== null) throw new Error("serve exited");
      const url = existsSync(urlFile) ? readFileSync(urlFile, "utf8") : "";
      if (url) return url;
      await Bun.sleep(25);
    }
    throw new Error("serve wrote no office-url");
  } finally {
    proc.kill();
    await proc.exited;
  }
}
async function installedOnFreePort() {
  const home = tempHome();
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  Bun.spawnSync(["bun", CLI, "install"], { env: { ...process.env, HOME: home, F1RM_PORT: String(port) } });
  return { home, port };
}
const keyFile = (home: string) => join(home, ".f1rm", "link-key");

test("restarting serve keeps the office URL, so an open tab keeps working", async () => {
  const { home, port } = await installedOnFreePort();
  const first = await serveOnce(home);
  expect(await serveOnce(home)).toBe(first);
});

test("the link key is kept in a file only the user can read", async () => {
  const { home, port } = await installedOnFreePort();
  const url = await serveOnce(home);
  expect(readFileSync(keyFile(home), "utf8").trim()).toBe(url.split("/")[3]);
  expect(statSync(keyFile(home)).mode & 0o777).toBe(0o600);
});

test.each([["empty", ""], ["too short", "abc"], ["not a key", "not a key! ".repeat(6)]])("a %s link key file is replaced by a fresh key", async (_, bad) => {
  const { home, port } = await installedOnFreePort();
  writeFileSync(keyFile(home), bad);
  const url = await serveOnce(home);
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[\\w-]{43}/$`));
  expect(readFileSync(keyFile(home), "utf8").trim()).toBe(url.split("/")[3]);
  expect(await serveOnce(home)).toBe(url);
});

test("a link key file that others can read is made private again, with the same key", async () => {
  const { home, port } = await installedOnFreePort();
  const url = await serveOnce(home);
  chmodSync(keyFile(home), 0o644);
  expect(await serveOnce(home)).toBe(url);
  expect(statSync(keyFile(home)).mode & 0o777).toBe(0o600);
});

test("serve does not print the link key when its output is not a terminal, so a launchd log never holds it", async () => {
  const { home, port } = await installedOnFreePort();
  let key = "";
  const proc = Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  try {
    const urlFile = join(home, ".f1rm", "office-url");
    for (let i = 0; i < 100 && !existsSync(urlFile); i++) await Bun.sleep(50);
    key = readFileSync(keyFile(home), "utf8").trim();
    expect(readFileSync(urlFile, "utf8")).toContain(key); // `f1rm` still opens the right link from this file
    await Bun.sleep(200);
  } finally {
    proc.kill();
    await proc.exited;
  }
  const printed = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(printed).not.toContain(key);
});

test("office-url is replaced in one step, so a reader never sees it empty or half written", async () => {
  const { home } = await installedOnFreePort();
  const urlFile = join(home, ".f1rm", "office-url");
  writeFileSync(urlFile, "http://127.0.0.1:1/stale/");
  const reader = join(home, ".f1rm", "old-office-url"); // a reader holding the old file: it must be swapped out, not truncated and rewritten
  linkSync(urlFile, reader);
  const proc = Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "ignore" });
  try {
    for (let i = 0; i < 200 && readFileSync(urlFile, "utf8").includes("stale"); i++) await Bun.sleep(25);
  } finally {
    proc.kill();
    await proc.exited;
  }
  expect(readFileSync(urlFile, "utf8")).toStartWith("http://127.0.0.1:");
  expect(readFileSync(urlFile, "utf8")).not.toContain("stale");
  expect(readFileSync(reader, "utf8")).toBe("http://127.0.0.1:1/stale/");
  expect(statSync(urlFile).mode & 0o777).toBe(0o600);
});

test("office-url is private even when a stale office-url.tmp with open permissions is left behind", async () => {
  const { home } = await installedOnFreePort();
  writeFileSync(join(home, ".f1rm", "office-url.tmp"), "stale");
  chmodSync(join(home, ".f1rm", "office-url.tmp"), 0o644);
  await serveOnce(home);
  expect(statSync(join(home, ".f1rm", "office-url")).mode & 0o777).toBe(0o600);
});

test("a link planted at office-url.tmp after serve cleared it is not followed: the file it points at is left alone, and no link is published", async () => {
  const { home } = await installedOnFreePort();
  const victim = join(home, "victim");
  writeFileSync(victim, "victim");
  chmodSync(victim, 0o644);
  // Preloaded into serve: right after serve removes office-url.tmp, something puts a link to the victim there.
  const preload = join(home, "plant.ts");
  writeFileSync(preload, `import { mock } from "bun:test";
import * as ns from "node:fs";
const real = { ...ns };
const rmSync = (p: any, o: any) => { real.rmSync(p, o); if (String(p).endsWith("office-url.tmp")) real.symlinkSync(${JSON.stringify(victim)}, p); };
mock.module("node:fs", () => ({ ...real, default: real, rmSync }));`);
  const proc = Bun.spawn(["bun", "--preload", preload, CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
  const urlFile = join(home, ".f1rm", "office-url");
  for (let i = 0; i < 200 && proc.exitCode === null && !existsSync(urlFile); i++) await Bun.sleep(25);
  proc.kill();
  await proc.exited;
  expect(readFileSync(victim, "utf8")).toBe("victim");
  expect(statSync(victim).mode & 0o777).toBe(0o644);
  expect(existsSync(urlFile) && lstatSync(urlFile).isSymbolicLink()).toBe(false);
});

test("the new link key is never written into a malformed file that others can read", async () => {
  const { home, port } = await installedOnFreePort();
  writeFileSync(keyFile(home), "not a key");
  chmodSync(keyFile(home), 0o644);
  const stillReadable = join(home, ".f1rm", "old-link-key"); // whoever had that file open or linked keeps reading the same file
  linkSync(keyFile(home), stillReadable);
  const url = await serveOnce(home);
  expect(readFileSync(keyFile(home), "utf8").trim()).toBe(url.split("/")[3]);
  expect(readFileSync(stillReadable, "utf8")).toBe("not a key");
});

test("serves started together with no link key end with one key, the one the running office uses", async () => {
  for (let round = 0; round < 12; round++) {
    const { home } = await installedOnFreePort();
    const procs = Array.from({ length: 16 }, () => Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" }));
    for (let i = 0; i < 400 && procs.filter((p) => p.exitCode !== null).length < procs.length - 1; i++) await Bun.sleep(25); // the losers fail on the port
    const url = readFileSync(join(home, ".f1rm", "office-url"), "utf8");
    procs.forEach((p) => p.kill());
    await Promise.all(procs.map((p) => p.exited));
    expect(readFileSync(keyFile(home), "utf8").trim()).toBe(url.split("/")[3]);
  }
}, 60_000);

test("uninstall removes the link key with the rest of the install state", async () => {
  const { home, port } = await installedOnFreePort();
  await serveOnce(home);
  expect(existsSync(keyFile(home))).toBe(true);
  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(existsSync(keyFile(home))).toBe(false);
});

test("uninstall removes a link-key.<pid> temp file left by a serve that was killed mid-write, which holds the live key", async () => {
  const { home } = await installedOnFreePort();
  await serveOnce(home);
  const leftover = join(home, ".f1rm", "link-key.12345");
  linkSync(keyFile(home), leftover);
  const backup = join(home, ".f1rm", "link-key.bak"); // the user's own file, not a temp of serve
  writeFileSync(backup, "mine");
  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(existsSync(leftover)).toBe(false);
  expect(existsSync(backup)).toBe(true);
});

test("serve runs the office on loopback with a UI token", async () => {
  const home = tempHome();
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  Bun.spawnSync(["bun", CLI, "install"], { env: { ...process.env, HOME: home, F1RM_PORT: String(port) } });
  const handlers = f1rmHandlers(settingsOf(home));

  const proc = Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, HOME: home }, stdout: "ignore" });
  try {
    const urlFile = join(home, ".f1rm", "office-url");
    for (let i = 0; i < 200 && !existsSync(urlFile); i++) await Bun.sleep(25);
    const url = readFileSync(urlFile, "utf8");
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[\\w-]{32,}/$`));

    // Fire the installed hooks the way Claude Code does, from a session in iTerm2,
    // and watch them reach the office that URL shows.
    const ws = new WebSocket(url.replace("http:", "ws:") + "ws", { headers: { origin: new URL(url).origin } } as any);
    const states: any[] = [];
    ws.onmessage = (m) => states.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    const until = async (pred: (s: any) => boolean) => {
      for (let i = 0; i < 50 && !states.some(pred); i++) await Bun.sleep(20);
      return states.find(pred);
    };
    const sessionEnv: Record<string, string> = { ITERM_SESSION_ID: "w0t1p0:ABCD", TERM_PROGRAM: "iTerm.app" };
    const payload = (hook_event_name: string, extra = {}) =>
      JSON.stringify({ session_id: "s1", transcript_path: "/t.jsonl", cwd: home, hook_event_name, ...extra });

    // SessionStart: a command hook, run by a shell with the payload on stdin
    const start = handlers.find((h) => h.event === "SessionStart");
    const ran = Bun.spawnSync(["sh", "-c", start.command], {
      stdin: Buffer.from(payload("SessionStart", { source: "startup" })),
      env: { PATH: process.env.PATH!, ...sessionEnv },
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe(""); // stdout of a SessionStart hook would land in Claude's context
    const started = await until((s) => s.employees.s1);
    expect(started?.employees.s1).toMatchObject({
      status: "idle",
      cwd: home,
      terminal: { itermSessionId: "w0t1p0:ABCD", termProgram: "iTerm.app" },
    });

    // PreToolUse: the same curl, and its reply is what Claude Code reads. Empty: no decision, Claude Code carries on.
    const run = (event: string, extra = {}) =>
      Bun.spawnSync(["sh", "-c", handlers.find((h) => h.event === event).command], { stdin: Buffer.from(payload(event, extra)), env: { PATH: process.env.PATH!, ...sessionEnv } });
    const pre = run("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/x/notes.md" } });
    expect([pre.exitCode, pre.stdout.toString()]).toEqual([0, ""]);
    const working = await until((s) => s.employees.s1?.status === "working");
    expect(working?.employees.s1).toMatchObject({
      activity: "Read notes.md",
      terminal: { itermSessionId: "w0t1p0:ABCD", termProgram: "iTerm.app" },
    });
    // A decision comes back through curl's output: a Designer may not hire.
    run("UserPromptSubmit", { prompt: "go", agent_type: "f1rm:designer" });
    await until((s) => s.employees.s1?.role === "designer");
    const held = run("PreToolUse", { tool_name: "Bash", tool_input: { command: "f1rm hire designer designer-a a brief" } });
    expect(JSON.parse(held.stdout.toString()).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    ws.close();
  } finally {
    proc.kill();
    await proc.exited;
  }
  // With the office stopped, every hook stays silent: no output, no error, a clean exit. This is what keeps a session quiet.
  for (const h of handlers) {
    const ran = Bun.spawnSync(["sh", "-c", h.command], { stdin: Buffer.from("{}"), env: { PATH: process.env.PATH! } });
    expect([h.event, ran.exitCode, ran.stdout.toString(), ran.stderr.toString()]).toEqual([h.event, 0, "", ""]);
  }
});

test("start refuses to run before install", () => {
  const { code, err } = f1rm(tempHome(), "start");
  expect(code).not.toBe(0);
  expect(err).toContain("f1rm install");
});

test("install refuses to touch a settings file it cannot parse", () => {
  const home = tempHome();
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  const { code, err } = f1rm(home, "install");
  expect(code).not.toBe(0);
  expect(err).toContain("settings.json");
  expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json");
});

// A stub `claude` first on PATH records its argv and the session-identifying part of its env.
/** `claude agents --json` lists `sessions`; any other call is logged. */
function stubClaude(exitCode = 0, sessions: object[] = []) {
  const bin = mkdtempSync(join(tmpdir(), "f1rm-bin-"));
  const log = join(bin, "claude.log");
  writeFileSync(join(bin, "agents.json"), JSON.stringify(sessions));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = agents ]; then cat "${bin}/agents.json"; exit 0; fi\nfor a in "$@"; do echo "arg:$a" >> "${log}"; done\nenv | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR)' | sed 's/^/env:/' >> "${log}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return {
    bin,
    args: () => lines().filter((l) => l.startsWith("arg:")).map((l) => l.slice(4)),
    env: () => lines().filter((l) => l.startsWith("env:")).map((l) => l.slice(4)),
  };
}

function pm(extraEnv: Record<string, string>, stub: ReturnType<typeof stubClaude>, ...args: string[]) {
  return pmIn(process.cwd(), extraEnv, stub, ...args);
}

function pmIn(cwd: string, extraEnv: Record<string, string>, stub: ReturnType<typeof stubClaude>, ...args: string[]) {
  const { stdin, HOME = tempHome(), ...env } = extraEnv;
  const r = Bun.spawnSync(["bun", CLI, "pm", ...args], {
    cwd,
    env: { ...process.env, HOME, PATH: `${stub.bin}:${process.env.PATH}`, ...env },
    ...(stdin !== undefined && { stdin: Buffer.from(stdin) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const repoDir = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), "f1rm-repo-")), name);
  mkdirSync(dir);
  return dir;
};

test("pm starts the PM role, named for its repo, with the grilling slash command first in its prompt", () => {
  const stub = stubClaude();
  expect(pmIn(repoDir("shop"), {}, stub).code).toBe(0);
  const args = stub.args();
  expect(args.slice(0, 4)).toEqual(["--agent", "f1rm:pm", "--name", "pm-shop"]);
  expect(args).toHaveLength(5);
  expect(args[4]).toStartWith("/mattpocock-skills:grilling ");
});

test("pm refuses a second PM for a repo whose PM is running, and starts one when only other repos have theirs", () => {
  const running = stubClaude(0, [{ kind: "interactive", name: "pm-shop" }]);
  const r = pmIn(repoDir("shop"), {}, running);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("pm-shop is already running for this repo");
  expect(running.args()).toEqual([]);
  const elsewhere = stubClaude(0, [{ kind: "interactive", name: "pm-blog" }, { kind: "background", name: "lead-shop" }]);
  expect(pmIn(repoDir("shop"), {}, elsewhere).code).toBe(0);
  expect(elsewhere.args().slice(0, 4)).toEqual(["--agent", "f1rm:pm", "--name", "pm-shop"]);
});

test("the PM's first prompt gives its session name, after the slash command", () => {
  const stub = stubClaude();
  pmIn(repoDir("shop"), {}, stub);
  const prompt = stub.args()[4];
  expect(prompt.indexOf("pm-shop")).toBeGreaterThan(prompt.indexOf("/mattpocock-skills:grilling"));
  expect(prompt).toContain("Your session name is pm-shop.");
});

test("the PM's first prompt asks it to pick up from the board and the live sessions before the interview", () => {
  const stub = stubClaude();
  pmIn(repoDir("shop"), {}, stub);
  const prompt = stub.args()[4];
  for (const s of ["claude agents --json", "claude logs", "`doing` or `review`"]) expect(prompt).toContain(s);
  expect(prompt.indexOf("claude agents --json")).toBeLessThan(prompt.indexOf("interview"));
});

test("pm names the session for the repo's main directory, from a subdirectory or a worktree", () => {
  const repo = repoDir("shop");
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  mkdirSync(join(repo, "src"));
  const wt = join(repoDir("elsewhere"), "wt");
  Bun.spawnSync(["git", "-C", repo, "worktree", "add", "-q", wt]);
  for (const cwd of [join(repo, "src"), wt]) {
    const stub = stubClaude();
    pmIn(cwd, {}, stub);
    expect(stub.args()[3]).toBe("pm-shop");
  }
});

test("pm passes extra claude flags before the prompt and returns claude's exit code", () => {
  const stub = stubClaude(3);
  expect(pmIn(repoDir("shop"), {}, stub, "--plugin-dir", "/p", "--model", "haiku").code).toBe(3);
  const args = stub.args();
  expect(args.slice(0, 8)).toEqual(["--agent", "f1rm:pm", "--name", "pm-shop", "--plugin-dir", "/p", "--model", "haiku"]);
  expect(args[8]).toStartWith("/mattpocock-skills:grilling ");
});

test("pm scrubs the Claude Code session variables it inherited", () => {
  const stub = stubClaude();
  pm({ CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "42", CLAUDE_EFFORT: "max", CLAUDE_CONFIG_DIR: "/keep" }, stub);
  expect(stub.env()).toEqual(["CLAUDE_CONFIG_DIR=/keep"]);
});

function stubBin() {
  const bin = mkdtempSync(join(tmpdir(), "f1rm-bin-"));
  for (const tool of ["launchctl", "open"]) writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> "${bin}/calls.log"\n`, { mode: 0o755 });
  const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
  const run = (home: string, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { bin, calls, run };
}

test("service writes a login agent that runs `f1rm serve` with this PATH, and reloads it", () => {
  const home = tempHome();
  const stub = stubBin();
  expect(stub.run(home, "service").code).toBe(1);
  stub.run(home, "install");
  const { code } = stub.run(home, "service");
  expect(code).toBe(0);
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "dev.f1rm.office.plist"), "utf8");
  expect(plist).toContain(`<string>${process.execPath}</string><string>${CLI}</string><string>serve</string>`);
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain(`<key>PATH</key><string>${stub.bin}:`);
  const uid = process.getuid!();
  expect(stub.calls()).toEqual([
    `launchctl bootout gui/${uid}/dev.f1rm.office`,
    `launchctl bootstrap gui/${uid} ${join(home, "Library", "LaunchAgents", "dev.f1rm.office.plist")}`,
  ]);
});

test("service restarts a running office: it retries the load while launchd is still unloading the old one", () => {
  const home = tempHome();
  const stub = stubBin();
  writeFileSync(join(stub.bin, "launchctl"), `#!/bin/sh\necho "launchctl $@" >> "${stub.bin}/calls.log"\n[ "$1" = bootstrap ] && [ ! -e "${stub.bin}/gone" ] && touch "${stub.bin}/gone" && exit 5\nexit 0\n`, { mode: 0o755 });
  stub.run(home, "install");
  expect(stub.run(home, "service").code).toBe(0);
  expect(stub.calls().filter((c) => c.startsWith("launchctl bootstrap"))).toHaveLength(2);
});

test("service off, and uninstall, unload the login agent and remove it", () => {
  for (const off of [["service", "off"], ["uninstall"]]) {
    const home = tempHome();
    const stub = stubBin();
    stub.run(home, "install");
    stub.run(home, "service");
    expect(stub.run(home, ...off).code).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", "dev.f1rm.office.plist"))).toBe(false);
    expect(stub.calls().at(-1)).toBe(`launchctl bootout gui/${process.getuid!()}/dev.f1rm.office`);
  }
});

test("start opens the office that is already running instead of starting another", async () => {
  const home = tempHome();
  const stub = stubBin();
  const office = Bun.serve({ port: 0, fetch: () => new Response("office") });
  const url = `http://127.0.0.1:${office.port}/tok/`;
  mkdirSync(join(home, ".f1rm"));
  writeFileSync(join(home, ".f1rm", "office-url"), url);
  // async spawn: a sync one would block this process, and with it the office that has to answer
  const proc = Bun.spawn(["bun", CLI, "start"], { env: { ...process.env, HOME: home, PATH: `${stub.bin}:${process.env.PATH}` }, stdout: "pipe" });
  const [code, out] = [await proc.exited, await new Response(proc.stdout).text()];
  office.stop(true);
  expect(code).toBe(0);
  expect(out.trim()).toBe(`f1rm office: running on port ${new URL(url).port}`); // piped stdout: no link, so no key
  expect(stub.calls()).toEqual([`open ${url}`]);
});

test("a link on the scheme's default port still says which port when its output is not a terminal", async () => {
  const home = tempHome();
  const stub = stubBin();
  mkdirSync(join(home, ".f1rm"));
  writeFileSync(join(home, ".f1rm", "office-url"), "http://127.0.0.1/tok/"); // F1RM_PORT=80: URL.port is "" for it
  const preload = join(home, "up.ts"); // nothing can listen on port 80 here, so the office is faked as answering
  writeFileSync(preload, `globalThis.fetch = (async () => new Response("office")) as any;`);
  const proc = Bun.spawn(["bun", "--preload", preload, CLI, "start"], { env: { ...process.env, HOME: home, PATH: `${stub.bin}:${process.env.PATH}` }, stdout: "pipe" });
  const [code, out] = [await proc.exited, await new Response(proc.stdout).text()];
  expect(code).toBe(0);
  expect(out.trim()).toBe("f1rm office: running on port 80");
});

test("start prints the full link when its output is a terminal", async () => {
  const home = tempHome();
  const stub = stubBin();
  const office = Bun.serve({ port: 0, fetch: () => new Response("office") });
  const url = `http://127.0.0.1:${office.port}/tok/`;
  mkdirSync(join(home, ".f1rm"));
  writeFileSync(join(home, ".f1rm", "office-url"), url);
  // `script` runs start on a pseudo-terminal, so stdout.isTTY is true; this is the BSD form (macOS-only, like the CLI: launchctl)
  const proc = Bun.spawn(["script", "-q", "/dev/null", "bun", CLI, "start"], { env: { ...process.env, HOME: home, PATH: `${stub.bin}:${process.env.PATH}` }, stdout: "pipe", stdin: "ignore" });
  const [code, out] = [await proc.exited, await new Response(proc.stdout).text()];
  office.stop(true);
  expect(code).toBe(0);
  expect(out).toContain(`f1rm office: ${url}`); // script adds a stray ^D of its own
  expect(stub.calls()).toEqual([`open ${url}`]);
});

test("start with no office running starts the background office, opens it, and exits", async () => {
  const home = tempHome();
  const stub = stubBin();
  const office = Bun.serve({ port: 0, fetch: () => new Response("office") });
  const url = `http://127.0.0.1:${office.port}/tok/`;
  Bun.spawnSync(["bun", CLI, "install"], { env: { ...process.env, HOME: home, F1RM_PORT: String(office.port) } });
  // launchd loading the office: the office writes its URL once it is up.
  writeFileSync(join(stub.bin, "launchctl"), `#!/bin/sh\necho "launchctl $@" >> "${stub.bin}/calls.log"\n[ "$1" = bootstrap ] && printf '%s' '${url}' > "${home}/.f1rm/office-url"\nexit 0\n`, { mode: 0o755 });
  const proc = Bun.spawn(["bun", CLI, "start"], { env: { ...process.env, HOME: home, PATH: `${stub.bin}:${process.env.PATH}`, F1RM_WAIT_MS: "5000" }, stdout: "pipe", timeout: 8000 });
  const [code, out] = [await proc.exited, await new Response(proc.stdout).text()];
  office.stop(true);
  expect(code).toBe(0);
  expect(out.trim()).toBe(`f1rm office: running on port ${new URL(url).port}`); // piped stdout: no link, so no key
  expect(stub.calls().filter((c) => c.startsWith("launchctl bootstrap"))).toHaveLength(1);
  expect(stub.calls().at(-1)).toBe(`open ${url}`);
}, 10_000);

test("service off, and uninstall, remove an office-url.tmp left by a serve that died before its rename", () => {
  for (const off of [["service", "off"], ["uninstall"]]) {
    const home = tempHome();
    const stub = stubBin();
    stub.run(home, "install"); // no login agent: removeOfficeFiles does the cleaning for both commands
    writeFileSync(join(home, ".f1rm", "office-url.tmp"), "http://127.0.0.1:1/key/");
    expect(stub.run(home, ...off).code).toBe(0);
    expect(existsSync(join(home, ".f1rm", "office-url.tmp"))).toBe(false);
  }
});

test("uninstall keeps the event log and the PM's boards", () => {
  const home = tempHome();
  const stub = stubBin();
  stub.run(home, "install");
  mkdirSync(join(home, ".f1rm", "boards"));
  writeFileSync(join(home, ".f1rm", "boards", "shop.md"), "| T1 | pm | todo | - | x |\n");
  writeFileSync(join(home, ".f1rm", "events.db"), "");
  stub.run(home, "uninstall");
  expect(existsSync(join(home, ".f1rm", "boards", "shop.md"))).toBe(true);
  expect(existsSync(join(home, ".f1rm", "events.db"))).toBe(true);
  expect(existsSync(join(home, ".f1rm", "ingest-headers"))).toBe(false);
});

const edition = (cwd: string, home: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, "edition", ...args], { cwd, env: { ...process.env, HOME: home } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
};

test("f1rm edition prints a repo's edition, sets it outside the repo, and refuses anything but work or founder", () => {
  const home = tempHome(), repo = repoDir("shop");
  expect(edition(repo, home).out).toBe("none chosen yet (counts as work)");
  expect(edition(repo, home, "founder")).toMatchObject({ code: 0, out: "edition: founder" });
  expect(edition(repo, home).out).toBe("founder");
  expect(readdirSync(repo)).toEqual([]);
  const files = readdirSync(join(home, ".f1rm", "projects"));
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(home, ".f1rm", "projects", files[0]), "utf8"))).toEqual({ edition: "founder" });
  expect(edition(repoDir("blog"), home).out).toBe("none chosen yet (counts as work)");
  const bad = edition(repo, home, "startup");
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain("usage: f1rm edition [work|founder]");
});

test("pm asks a repo's edition the first time, saves it, and tells the PM; with no answer it starts as Work and asks again", () => {
  const home = tempHome(), repo = repoDir("shop");
  const silent = stubClaude();
  const first = pmIn(repo, { HOME: home }, silent);
  expect(first.out).toContain("Is shop a Work or a Founder project? [w/f]");
  expect(silent.args()[4]).toContain("This is a Work project");
  expect(edition(repo, home).out).toBe("none chosen yet (counts as work)");

  const answered = stubClaude();
  expect(pmIn(repo, { HOME: home, stdin: "f\n" }, answered).code).toBe(0);
  expect(answered.args()[4]).toContain("This is a Founder project: follow the founder playbook in the guidelines.");
  expect(edition(repo, home).out).toBe("founder");

  const again = stubClaude();
  expect(pmIn(repo, { HOME: home }, again).out).not.toContain("Work or a Founder");
  expect(again.args()[4]).toContain("This is a Founder project");
});

// A bare `f1rm` in a folder: one line back, and the office's token never in it.
const f1rmIn = (cwd: string, home: string, bin: string, ...args: string[]) => f1rmEnv({}, cwd, home, bin, ...args);
async function f1rmEnv(env: Record<string, string>, cwd: string, home: string, bin: string, ...args: string[]) {
  // async spawn: a sync one would block this process, and with it the office that has to answer
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, F1RM_WAIT_MS: "5000", ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = [await proc.exited, await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code, out: out.trim(), err };
}

test("a bare f1rm on a fresh machine installs the hooks, starts the background office, waits for it, and opens this folder's project", async () => {
  const home = tempHome(), folder = realpathSync(repoDir("shop"));
  const stub = stubBin();
  const office = Bun.serve({ port: 0, fetch: () => new Response("office") });
  const url = `http://127.0.0.1:${office.port}/secret-token/`;
  // launchd loading the office: the office writes its URL once it is up.
  writeFileSync(join(stub.bin, "launchctl"), `#!/bin/sh\necho "launchctl $@" >> "${stub.bin}/calls.log"\n[ "$1" = bootstrap ] && printf '%s' '${url}' > "${home}/.f1rm/office-url"\nexit 0\n`, { mode: 0o755 });
  const r = await f1rmIn(folder, home, stub.bin);
  office.stop(true);
  expect(r.code).toBe(0);
  expect(r.out).toBe("Opened the f1rm office on shop (installed f1rm's hooks after backing up your settings; restart Claude Code sessions that are already open so they appear; started it in the background).");
  expect(r.out).not.toContain("secret-token");
  expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toContain("/ingest");
  expect(stub.calls().at(-1)).toBe(`open ${url}#/project/${encodeURIComponent(folder)}`);
});

test("a bare f1rm that installed the hooks and then can't start the office prints those notes and the error to stderr, nothing to stdout, and exits 1, as start does", async () => {
  const home = tempHome(), folder = realpathSync(repoDir("shop"));
  const stub = stubBin(); // its launchctl loads nothing, so no office ever writes its URL
  const r = await f1rmEnv({ F1RM_WAIT_MS: "500" }, folder, home, stub.bin);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toContain("installed f1rm's hooks after backing up your settings");
  expect(r.err.indexOf("installed f1rm's hooks")).toBeLessThan(r.err.indexOf("the office didn't start; see"));
  expect(r.err).toContain("the office didn't start; see");
  expect(stub.calls().some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
  expect(stub.calls().some((c) => c.startsWith("open "))).toBe(false);
});

test("start exits 1 with the message on stderr when the background office does not start", async () => {
  const home = tempHome();
  const stub = stubBin(); // its launchctl loads nothing, so no office ever writes its URL
  stub.run(home, "install");
  const r = await f1rmEnv({ F1RM_WAIT_MS: "500" }, process.cwd(), home, stub.bin, "start");
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toContain(`the office didn't start; see ${join(home, ".f1rm", "office.log")}`);
  expect(stub.calls().some((c) => c.startsWith("open "))).toBe(false);
});

test("a bare f1rm with the office running just opens this folder's project, in one line", async () => {
  const home = tempHome(), folder = realpathSync(repoDir("blog"));
  const stub = stubBin();
  stub.run(home, "install");
  const office = Bun.serve({ port: 0, fetch: () => new Response("office") });
  const url = `http://127.0.0.1:${office.port}/tok/`;
  writeFileSync(join(home, ".f1rm", "office-url"), url);
  const r = await f1rmIn(folder, home, stub.bin);
  office.stop(true);
  expect(r.out).toBe("Opened the f1rm office on blog.");
  expect(stub.calls()).toEqual([`open ${url}#/project/${encodeURIComponent(folder)}`]);
});

test("help prints the usage line and exits 0; an unknown command, here included, prints it and exits 1", async () => {
  const home = tempHome(), folder = repoDir("shop");
  const stub = stubBin();
  for (const arg of ["help", "-h", "--help"]) {
    const r = await f1rmIn(folder, home, stub.bin, arg);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("usage: f1rm | install | uninstall");
  }
  for (const arg of ["here", "nonsense", "toString", "constructor", "__proto__"]) {
    const r = await f1rmIn(folder, home, stub.bin, arg);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("usage: f1rm | install | uninstall");
    expect(r.err).not.toContain("here");
  }
});

test("install puts the f1rm command in ~/.local/bin, and uninstall removes it only when it is f1rm's", () => {
  const home = tempHome();
  const stub = stubBin();
  const bin = join(home, ".local", "bin", "f1rm");
  expect(stub.run(home, "install").out).toContain(`f1rm command installed in ${bin}.`);
  expect(readFileSync(bin, "utf8")).toContain(`"${CLI}" "$@"`);
  expect(statSync(bin).mode & 0o111).toBeTruthy();
  stub.run(home, "uninstall");
  expect(existsSync(bin)).toBe(false);
  writeFileSync(bin, "#!/bin/sh\necho mine\n");
  expect(stub.run(home, "install").out).toContain("isn't f1rm's, so it was left alone");
  stub.run(home, "uninstall");
  expect(readFileSync(bin, "utf8")).toBe("#!/bin/sh\necho mine\n");
});

test("a bare f1rm with an office page open moves that page to this folder's project and opens no new tab", async () => {
  const home = tempHome(), folder = realpathSync(repoDir("blog"));
  const stub = stubBin();
  stub.run(home, "install");
  const asked: unknown[] = [];
  const office = Bun.serve({
    port: 0,
    fetch: async (req) => (req.method === "POST" && new URL(req.url).pathname === "/tok/show" ? (asked.push(await req.json()), Response.json({ pages: 1 })) : new Response("office")),
  });
  writeFileSync(join(home, ".f1rm", "office-url"), `http://127.0.0.1:${office.port}/tok/`);
  const r = await f1rmIn(folder, home, stub.bin);
  office.stop(true);
  expect(r.out).toBe("Your office tab now shows blog.");
  expect(asked).toEqual([{ room: folder }]);
  expect(stub.calls()).toEqual([]);
});

// f1rm letgo: a fake claude (the sessions it lists, stop and rm) over a real temp repo, so the branch and worktree clean-up is real git.
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
/** A repo on main with two hires' worktrees: `done` merged into main, `open` with a commit main lacks. */
function repoWithHires() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-letgo-")));
  git(repo, "init", "-b", "main");
  git(repo, "commit", "--allow-empty", "-m", "start");
  for (const task of ["done", "open"]) {
    git(repo, "worktree", "add", "-b", `worktree-${task}`, join(repo, ".claude", "worktrees", task));
    git(join(repo, ".claude", "worktrees", task), "commit", "--allow-empty", "-m", task);
  }
  git(repo, "merge", "--no-ff", "-m", "merge done", "worktree-done");
  return repo;
}
function fakeClaude(sessions: { id: string; name: string; kind?: string; state?: string; cwd: string }[], failRm = new Set<string>()) {
  const live = sessions.map((s) => ({ kind: "background", state: "done", ...s }));
  const calls: string[] = [];
  return {
    calls,
    sessions: async () => live.slice(),
    letGo: async (id: string) => {
      if (failRm.has(id)) throw new Error("rm refused: uncommitted work");
      calls.push(`letgo ${id}`);
      live.splice(live.findIndex((s) => s.id === id), 1);
    },
    gitCommonDir: machine.gitCommonDir,
    mergedBranch: machine.mergedBranch,
    removeWorktree: machine.removeWorktree,
  };
}
const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
const worktreeOf = (repo: string, task: string) => join(repo, ".claude", "worktrees", task);

test("letgo lets a named hire go and removes its merged worktree and branch", async () => {
  const repo = repoWithHires();
  const fake = fakeClaude([{ id: "a1", name: "frontend-dev-done", cwd: worktreeOf(repo, "done") }]);
  const r = await letgo(["frontend-dev-done"], fake, repo);
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual(["frontend-dev-done: let go, removed its worktree and branch worktree-done"]);
  expect(fake.calls).toEqual(["letgo a1"]);
  expect(existsSync(worktreeOf(repo, "done"))).toBe(false);
  expect(branches(repo)).toEqual(["main", "worktree-open"]);
});

test("letgo does not stop a hire whose branch is not merged, and fails", async () => {
  const repo = repoWithHires();
  const fake = fakeClaude([{ id: "b2", name: "checkout.backend-dev-open", cwd: worktreeOf(repo, "open") }]);
  const r = await letgo(["checkout.backend-dev-open"], fake, repo);
  expect(r.ok).toBe(false);
  expect(r.lines).toEqual(["checkout.backend-dev-open: not let go: worktree-open is not merged into the base branch"]);
  expect(fake.calls).toEqual([]);
  expect(existsSync(worktreeOf(repo, "open"))).toBe(true);
  expect(branches(repo)).toContain("worktree-open");
});

test("letgo does not stop a hire with no commits of its own: a branch at a base commit is waiting, not landed", async () => {
  const repo = repoWithHires();
  git(repo, "worktree", "add", "-b", "worktree-fresh", worktreeOf(repo, "fresh"));
  const fake = fakeClaude([{ id: "f1", name: "frontend-dev-fresh", cwd: worktreeOf(repo, "fresh") }]);
  const r = await letgo(["frontend-dev-fresh"], fake, repo);
  expect(r.ok).toBe(false);
  expect(r.lines).toEqual(["frontend-dev-fresh: not let go: worktree-fresh is not merged into the base branch"]);
  expect(fake.calls).toEqual([]);
});

test("letgo does not stop a merged hire whose worktree has uncommitted files, and fails", async () => {
  const repo = repoWithHires();
  writeFileSync(join(worktreeOf(repo, "done"), "notes.txt"), "unsaved thoughts");
  const fake = fakeClaude([{ id: "a1", name: "frontend-dev-done", cwd: worktreeOf(repo, "done") }]);
  const r = await letgo(["frontend-dev-done"], fake, repo);
  expect(r.ok).toBe(false);
  expect(r.lines).toEqual(["frontend-dev-done: not let go: its worktree has uncommitted files"]);
  expect(fake.calls).toEqual([]);
  expect(existsSync(join(worktreeOf(repo, "done"), "notes.txt"))).toBe(true);
});

test("letgo prints a line per name, and fails if a name isn't a background session of this repo or can't be let go", async () => {
  const repo = repoWithHires();
  const fake = fakeClaude(
    [
      { id: "a1", name: "frontend-dev-done", cwd: worktreeOf(repo, "done") },
      { id: "c3", name: "designer-done", cwd: worktreeOf(repo, "done") },
      { id: "d4", name: "designer-other", cwd: "/elsewhere/.claude/worktrees/other" },
      { id: "e5", name: "frontend-dev-open", kind: "interactive", cwd: worktreeOf(repo, "open") },
    ],
    new Set(["c3"]),
  );
  const r = await letgo(["designer-done", "frontend-dev-done", "designer-other", "frontend-dev-open", "ghost"], fake, repo);
  expect(r.ok).toBe(false);
  expect(r.lines).toEqual([
    "designer-done: could not be let go: rm refused: uncommitted work",
    "frontend-dev-done: let go, removed its worktree and branch worktree-done",
    "designer-other: no background session with this name in this repo",
    "frontend-dev-open: no background session with this name in this repo",
    "ghost: no background session with this name in this repo",
  ]);
  expect(fake.calls).toEqual(["letgo a1"]);
});

test("letgo lets every session with a reused name go, a stale stopped one too, and cleans up once", async () => {
  const repo = repoWithHires();
  const fake = fakeClaude([
    { id: "a1", name: "frontend-dev-done", cwd: worktreeOf(repo, "done"), state: "stopped" },
    { id: "a2", name: "frontend-dev-done", cwd: worktreeOf(repo, "done") },
  ]);
  const r = await letgo(["frontend-dev-done"], fake, repo);
  expect(r.ok).toBe(true);
  expect(r.lines).toEqual(["frontend-dev-done: let go", "frontend-dev-done: let go, removed its worktree and branch worktree-done"]);
  expect(fake.calls).toEqual(["letgo a1", "letgo a2"]);
  expect(branches(repo)).toEqual(["main", "worktree-open"]);
});

test("hireTask takes exactly the task names that hire.ts's SLUG takes", () => {
  for (const task of ["a", "a-b", "a1-b2-c3", "a--b", "-a", "a-", "A", "a b", "a.b", ""]) {
    expect([task, hireTask(`frontend-dev-${task}`) !== null]).toEqual([task, SLUG.test(task)]);
  }
});

test("letgo lets a Reviewer or a lead go without touching any branch", async () => {
  const repo = repoWithHires();
  const fake = fakeClaude([
    { id: "r1", name: "reviewer-review-done", cwd: repo },
    { id: "l1", name: "lead-checkout", cwd: repo },
  ]);
  const r = await letgo(["reviewer-review-done", "lead-checkout"], fake, repo);
  expect(r.lines).toEqual(["reviewer-review-done: let go", "lead-checkout: let go"]);
  expect(branches(repo)).toEqual(["main", "worktree-done", "worktree-open"]);
});
