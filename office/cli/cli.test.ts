// Seam 2: the real f1rm CLI, run with a temporary HOME.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    groups.flatMap((g: any) => g.hooks.filter((h: any) => h.type === "http").map((h: any) => ({ event, ...h }))),
  );

test("install adds an http hook with the ingest secret for every observed event, keeping everything else", () => {
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
  expect(handlers.map((h) => h.event).sort()).toEqual(
    [
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
    ].sort(),
  );
  const secret = handlers[0].headers["X-F1rm-Secret"];
  expect(secret).toMatch(/^[\w-]{32,}$/);
  for (const h of handlers) {
    expect(h.url).toBe("http://127.0.0.1:4170/ingest");
    expect(h.headers["X-F1rm-Secret"]).toBe(secret);
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

test("install and uninstall work when there are no settings yet", () => {
  const home = tempHome();
  expect(f1rm(home, "install").code).toBe(0);
  expect(f1rmHandlers(settingsOf(home)).length).toBeGreaterThan(0);
  expect(existsSync(join(home, ".claude", "settings.json.f1rm-backup"))).toBe(false);
  f1rm(home, "uninstall");
  expect(settingsOf(home)).toEqual({});
});

test("install refuses to touch a settings file it cannot parse", () => {
  const home = tempHome();
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  const { code, err } = f1rm(home, "install");
  expect(code).not.toBe(0);
  expect(err).toContain("settings.json");
  expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json");
});
