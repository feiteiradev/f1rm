// Seam 2: the real f1rm CLI, run with a temporary HOME.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_S } from "../server/approvals.ts";

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
    // a stuck office must not stall sessions, except that the permission hook is held for the browser
    if (h.event === "PermissionRequest") expect(h.timeout).toBeGreaterThan(DEFAULT_TIMEOUT_S);
    else expect(h.timeout).toBeLessThanOrEqual(5);
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

test("an install that still forwards the messaging token is upgraded in place, then uninstalls exactly", () => {
  const home = tempHome(userSettings);
  f1rm(home, "install");
  const old = settingsOf(home);
  const header = "X-F1rm-Messaging-Token";
  for (const groups of Object.values(old.hooks) as any[]) {
    for (const h of groups.flatMap((g: any) => g.hooks)) {
      if (h.type === "http" && h.headers?.["X-F1rm-Secret"]) {
        h.headers[header] = "$CLAUDE_CODE_MESSAGING_TOKEN";
        h.allowedEnvVars.push("CLAUDE_CODE_MESSAGING_TOKEN");
      }
      if (h.type === "command" && h.command.includes(".f1rm/ingest-headers")) {
        h.command = h.command.replace(" --data-binary", ` -H "${header}: $CLAUDE_CODE_MESSAGING_TOKEN" --data-binary`);
      }
    }
  }
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(old, null, 2) + "\n");

  expect(f1rm(home, "install").code).toBe(0);
  const upgraded = settingsOf(home);
  expect(JSON.stringify(upgraded)).not.toContain("MESSAGING_TOKEN");
  expect(f1rmHandlers(upgraded)).toHaveLength(f1rmHandlers(old).length);
  expect(secretOf(upgraded)).toBe(secretOf(old));
  expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json.f1rm-backup"), "utf8"))).toEqual(userSettings);
  expect(f1rm(home, "uninstall").code).toBe(0);
  expect(settingsOf(home)).toEqual(userSettings);
});

test("start refuses an approval timeout the installed permission hook would not outlast", () => {
  const home = tempHome();
  f1rm(home, "install");
  const refused = Bun.spawnSync(["bun", CLI, "start"], { env: { ...process.env, HOME: home, F1RM_APPROVAL_TIMEOUT: String(2 * DEFAULT_TIMEOUT_S) }, timeout: 5000 });
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
  expect(out.trim()).toBe(`f1rm office: ${url}`);
  expect(stub.calls()).toEqual([`open ${url}`]);
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
