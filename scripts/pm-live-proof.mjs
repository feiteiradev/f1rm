// Live proof of Start PM: this branch's server (temp HOME, its own port, the real machine) serves the office; headless Chrome
// presses Start PM in the Hire dialog of a room whose cwd is a throwaway git repo; one real iTerm tab opens and runs `f1rm pm`
// there. The proof reads the process (command line, cwd, parent), then stops claude before the PM does anything, closes only that
// tab (found by its tty, with the other tabs' ids checked before and after), and removes the agent-memory folder it created.
// Run `bun run build` first, then:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome OUT=/some/dir bun scripts/pm-live-proof.mjs
// iTerm2 must be running. The tab's shell is a login shell, so it runs the `f1rm` on your PATH and, like any claude there, reports to
// the office your settings.json points at. Nothing else of yours is touched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { machine } from "../office/server/machine.ts";
import { junkRoots } from "../office/server/doors.ts";
import { startServer } from "../office/server/server.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const OUT = resolve(process.env.OUT ?? "pm-live-proof-out");
mkdirSync(OUT, { recursive: true });
const REAL_HOME = homedir();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-pm-live-")));
const repo = join(tmp, `pmlive${Math.random().toString(36).slice(2, 6)}`);
const PM = `pm-${basename(repo)}`;
process.env.HOME = join(tmp, "home");
const memory = join(REAL_HOME, ".claude/agent-memory");
const memoryBefore = new Set(existsSync(memory) ? readdirSync(memory) : []);

const sh = (...cmd) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const ITERM = 'application id "com.googlecode.iterm2"';
const osa = (script, ...args) => sh("osascript", "-e", script, ...args);
const tabIds = () =>
  osa(`tell ${ITERM}
  set out to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set end of out to unique id of s
      end repeat
    end repeat
  end repeat
  return out
end tell`).split(", ").filter(Boolean).sort();
// Only the session whose tty is the PM's; it must be alone in its tab. Returns its text, and closes the tab when `close` is set.
const tabOfTty = (tty, close) =>
  osa(
    `on run argv
  tell ${ITERM}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then
            if (count of sessions of t) is not 1 then return "shared"
            set txt to text of s
            if item 2 of argv is "close" then tell t to close
            return txt
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "none"
end run`,
    "/dev/" + tty,
    close ? "close" : "read",
  );
const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
};

let pid;
const cleanup = () => {
  if (pid) Bun.spawnSync(["kill", "-9", String(pid)]);
  if (existsSync(memory)) for (const d of readdirSync(memory)) if (d.startsWith("f1rm-") && !memoryBefore.has(d)) rmSync(join(memory, d), { recursive: true, force: true });
};
process.on("SIGINT", () => (cleanup(), process.exit(130)));

mkdirSync(repo, { recursive: true });
for (const cmd of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "seed"]]) Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...cmd]);
assert.ok(existsSync(join(repo, ".git")), "the throwaway repo exists");

const SECRET = "live-secret", TOKEN = "live-token";
const server = startServer({ port: 41900 + Math.floor(Math.random() * 100), secret: SECRET, token: TOKEN, machine, clientDir: resolve(import.meta.dir, "../office/client/dist"), junkRoots: junkRoots(process.env.HOME, "") }); // the repo is under tmpdir(), which is no door otherwise
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
try {
  const seed = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-f1rm-secret": SECRET },
    body: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", transcript_path: join(tmp, "seed.jsonl"), cwd: repo, hook_event_name: "SessionStart", source: "startup" }),
  });
  assert.equal(seed.status, 200);

  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/${TOKEN}/`);
  await page.locator(".door").first().click();
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  const dialog = page.locator("dialog.hire");
  await dialog.locator(".role").first().waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Let the PM decide", exact: true }).count(), 0, "no PM, so no Let the PM decide");
  await page.screenshot({ path: join(OUT, "live-1-dialog.png") });

  const before = tabIds();
  assert.equal(sh("pgrep", "-f", `claude.* --name ${PM}`), "", "no such PM is running yet");
  await dialog.getByRole("button", { name: "Start PM", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  console.log(`pressed Start PM in the browser for ${repo}`);

  // The PM's claude carries the `--name` that `f1rm pm` derives from its cwd, so finding it proves where the tab ran.
  pid = Number(await until(() => sh("pgrep", "-f", `claude.* --name ${PM}`).split("\n")[0], 30_000, "claude to start in the new tab"));
  const command = sh("ps", "-o", "command=", "-p", String(pid));
  const cwd = sh("lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn").split("\n").find((l) => l.startsWith("n"))?.slice(1);
  const parent = sh("ps", "-o", "command=", "-p", sh("ps", "-o", "ppid=", "-p", String(pid)));
  const tty = sh("ps", "-o", "tty=", "-p", String(pid));
  // Stopped at once: whatever the PM was about to do, it does not do it.
  Bun.spawnSync(["kill", "-9", String(pid)]);
  const tab = tabOfTty(tty, false);
  console.log(`claude started: ${command.slice(0, 150)}`);
  console.log(`its cwd: ${cwd}`);
  console.log(`its parent: ${parent}`);
  console.log(`its tab (tty ${tty}) shows:\n${tab.split("\n").filter((l) => l.trim()).slice(0, 12).join("\n")}`);
  assert.match(command, /--agent f1rm:pm /, "it is the PM");
  assert.equal(cwd, repo, "it runs in the project's folder");
  assert.match(parent, /f1rm\.ts pm$/, "its parent is `f1rm pm`");
  assert.ok(tab !== "none" && tab !== "shared", "its tab is its own");

  await until(() => !sh("pgrep", "-f", `claude.* --name ${PM}`), 10_000, "claude to be gone");
  pid = undefined;
  await until(() => !sh("pgrep", "-f", `f1rm.ts pm`).split("\n").some((p) => p && sh("ps", "-o", "tty=", "-p", p) === tty), 10_000, "`f1rm pm` to exit");
  assert.notEqual(tabOfTty(tty, true), "none", "the tab was found and closed");
  await until(() => tabOfTty(tty, false) === "none", 10_000, "the tab to be gone");
  assert.deepEqual(tabIds(), before, "every other iTerm tab is exactly as it was");
  console.log(`closed only that tab; ${before.length} other sessions untouched`);
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS Start PM live: one iTerm tab opened in the throwaway repo running `f1rm pm`, then claude was stopped and the tab closed");
} finally {
  cleanup();
  await browser.close();
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
