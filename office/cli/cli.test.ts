// Seam 2: the real f1rm CLI, run with a temporary HOME.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const secretOf = (settings: any) => f1rmHandlers(settings).find((h) => h.type === "http").headers["X-F1rm-Secret"];

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
  const secret = secretOf(settings);
  expect(secret).toMatch(/^[\w-]{32,}$/);

  // SessionStart only runs command hooks, so it POSTs with curl; everything else is an http hook.
  const sessionStart = handlers.filter((h) => h.event === "SessionStart");
  expect(sessionStart).toHaveLength(1);
  expect(sessionStart[0].type).toBe("command");
  expect(sessionStart[0].command).toContain("http://127.0.0.1:4170/ingest");
  const headersFile = join(home, ".f1rm", "ingest-headers");
  expect(sessionStart[0].command).toContain(`-H @'${headersFile}'`);
  expect(sessionStart[0].command).not.toContain(secret); // argv is world-readable via ps
  expect(readFileSync(headersFile, "utf8")).toBe(`X-F1rm-Secret: ${secret}\n`);
  expect(statSync(headersFile).mode & 0o777).toBe(0o600);

  const http = handlers.filter((h) => h.event !== "SessionStart");
  expect(http.map((h) => h.event).sort()).toEqual(
    [
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
    ].sort(),
  );
  for (const h of http) {
    expect(h.type).toBe("http");
    expect(h.matcher).toBeUndefined(); // every tool, every notification
    expect(h.url).toBe("http://127.0.0.1:4170/ingest");
    expect(h.headers["X-F1rm-Secret"]).toBe(secret);
    expect(h.timeout).toBeLessThanOrEqual(5); // a stuck office must not stall sessions
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

test("start serves the office on loopback and opens its URL with a fresh UI token", async () => {
  const home = tempHome();
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  Bun.spawnSync(["bun", CLI, "install"], { env: { ...process.env, HOME: home, F1RM_PORT: String(port) } });
  const handlers = f1rmHandlers(settingsOf(home));

  // a stub `open` first on PATH records the URL instead of opening a browser
  const bin = mkdtempSync(join(tmpdir(), "f1rm-bin-"));
  writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$@" >> "${bin}/open.log"\n`, { mode: 0o755 });
  const proc = Bun.spawn(["bun", CLI, "start"], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
  });
  try {
    const reader = proc.stdout.getReader();
    let out = "";
    while (!/http:\/\/\S+/.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("start exited: " + out);
      out += new TextDecoder().decode(value);
    }
    const url = out.match(/http:\/\/\S+/)![0];
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[\\w-]{32,}/$`));
    for (let i = 0; i < 50 && !existsSync(join(bin, "open.log")); i++) await Bun.sleep(20);
    expect(readFileSync(join(bin, "open.log"), "utf8").trim()).toBe(url);

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

    // PreToolUse: an http hook, with allowed env vars interpolated into its headers
    const pre = handlers.find((h) => h.event === "PreToolUse");
    const headers = Object.fromEntries(
      Object.entries<string>(pre.headers).map(([k, v]) => [
        k,
        v.replace(/\$\{?(\w+)\}?/g, (_, name) => (pre.allowedEnvVars.includes(name) ? sessionEnv[name] ?? "" : "")),
      ]),
    );
    const res = await fetch(pre.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: payload("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/x/notes.md" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // empty body: no decision, Claude Code carries on
    const working = await until((s) => s.employees.s1?.status === "working");
    expect(working?.employees.s1).toMatchObject({
      activity: "Read notes.md",
      terminal: { itermSessionId: "w0t1p0:ABCD", termProgram: "iTerm.app" },
    });
    ws.close();
  } finally {
    proc.kill();
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
function stubClaude(exitCode = 0) {
  const bin = mkdtempSync(join(tmpdir(), "f1rm-bin-"));
  const log = join(bin, "claude.log");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nfor a in "$@"; do echo "arg:$a" >> "${log}"; done\nenv | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR)' | sed 's/^/env:/' >> "${log}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  const lines = () => readFileSync(log, "utf8").trim().split("\n");
  return {
    bin,
    args: () => lines().filter((l) => l.startsWith("arg:")).map((l) => l.slice(4)),
    env: () => lines().filter((l) => l.startsWith("env:")).map((l) => l.slice(4)),
  };
}

function pm(extraEnv: Record<string, string>, stub: ReturnType<typeof stubClaude>, ...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, "pm", ...args], {
    env: { ...process.env, HOME: tempHome(), PATH: `${stub.bin}:${process.env.PATH}`, ...extraEnv },
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

test("pm starts the PM role with the grilling slash command as its first prompt", () => {
  const stub = stubClaude();
  expect(pm({}, stub).code).toBe(0);
  const args = stub.args();
  expect(args.slice(0, 2)).toEqual(["--agent", "f1rm:pm"]);
  expect(args).toHaveLength(3);
  expect(args[2]).toStartWith("/mattpocock-skills:grilling ");
});

test("pm passes extra claude flags before the prompt and returns claude's exit code", () => {
  const stub = stubClaude(3);
  expect(pm({}, stub, "--plugin-dir", "/p", "--model", "haiku").code).toBe(3);
  const args = stub.args();
  expect(args.slice(0, 6)).toEqual(["--agent", "f1rm:pm", "--plugin-dir", "/p", "--model", "haiku"]);
  expect(args[6]).toStartWith("/mattpocock-skills:grilling ");
});

test("pm scrubs the Claude Code session variables it inherited", () => {
  const stub = stubClaude();
  pm({ CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "42", CLAUDE_EFFORT: "max", CLAUDE_CONFIG_DIR: "/keep" }, stub);
  expect(stub.env()).toEqual(["CLAUDE_CONFIG_DIR=/keep"]);
});
