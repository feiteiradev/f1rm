// The machine module: the only code that touches the OS. Seam 1 tests swap it for a fake.

const ITERM = 'application id "com.googlecode.iterm2"';
const SAFE_ID = /^[\w-]+$/;

// A claude launched from a Claude Code session would inherit that session's messaging socket and token.
const claudeEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)));

/** `claude agents --json`'s sessions, or null if it can't say. `all` adds finished background sessions. */
async function agents(all: boolean): Promise<any[] | null> {
  try {
    const proc = Bun.spawn(["claude", "agents", "--json", ...(all ? ["--all"] : [])], {
      env: claudeEnv(), stdout: "pipe", stderr: "ignore", timeout: 10_000,
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const list = JSON.parse(out);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Runs AppleScript; the arguments reach `on run argv`, so nothing is spliced into the script text. */
async function osascript(script: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script, ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(err.trim() || "osascript failed");
  return out.trim();
}

// ponytail: scans every tab with one Apple event per property (40 tabs measured under a second); cache window and tab positions if that is felt.
const FOCUS_ITERM = `on run argv
  if not (${ITERM} is running) then return "missing"
  tell ${ITERM}
    set wids to id of windows
    repeat with n from 1 to count of wids
      -- Windows are addressed by id: selecting one moves it to index 1, which would repoint an index reference.
      set w to window id (item n of wids)
      repeat with i from 1 to count of tabs of w
        repeat with k from 1 to count of sessions of tab i of w
          if unique id of session k of tab i of w is item 1 of argv then
            tell tab i of w to select
            tell session k of tab i of w to select
            tell w to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// A new tab in the current window, or a window if there is none; the shell stays open after the command exits.
// ponytail: always iTerm2's current window; pick the window of the employee's room if people mind.
const RUN_IN_NEW_TAB = `on run argv
  tell ${ITERM}
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window to write text (item 1 of argv)
    activate
  end tell
end run`;

export const machine = {
  /** Absolute git common dir for `cwd` (shared by a repo and all its worktrees), or null outside git. */
  gitCommonDir(cwd: string): string | null {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      stderr: "ignore",
    });
    return r.success ? r.stdout.toString().trim() : null;
  },

  /** Ids of the sessions Claude Code lists as live (`claude agents --json`); null if it can't say. */
  async liveSessions(): Promise<Set<string> | null> {
    const list = await agents(false);
    return list && new Set(list.map((a) => a?.sessionId).filter((id): id is string => typeof id === "string"));
  },

  /** The short id `claude attach` takes for a background session, or null if Claude Code lists none. */
  async backgroundId(sessionId: string): Promise<string | null> {
    const found = (await agents(true))?.find((a) => a?.kind === "background" && a.sessionId === sessionId);
    return typeof found?.id === "string" && SAFE_ID.test(found.id) ? found.id : null;
  },

  /** Brings the iTerm2 tab with this `$ITERM_SESSION_ID` to the front. False if no such tab is open. */
  async focusIterm(itermSessionId: string): Promise<boolean> {
    // The env var is `w0t1p0:<session guid>`; the guid is what iTerm2's scripting calls the session's unique id.
    const guid = itermSessionId.slice(itermSessionId.indexOf(":") + 1);
    if (!SAFE_ID.test(guid)) return false;
    return (await osascript(FOCUS_ITERM, guid)) === "ok";
  },

  /** Opens a new iTerm2 tab running `claude attach` for a background session. */
  async attachInIterm(backgroundId: string): Promise<void> {
    if (!SAFE_ID.test(backgroundId)) throw new Error("bad background session id");
    await osascript(RUN_IN_NEW_TAB, `claude attach ${backgroundId}`);
  },

  /** Focuses the VS Code window open on `folder` (VS Code opens one if there is none). */
  async openVsCode(folder: string): Promise<void> {
    const run = async (cmd: string[]) => (await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited) === 0;
    // ponytail: the folder is the session's cwd, so a session in a subfolder of an open workspace gets a new window; match by workspace if that bites.
    // `code` is only on PATH if the user installed the shell command; `open -a` always works.
    if (!(await run(["code", folder]).catch(() => false))) {
      if (!(await run(["open", "-a", "Visual Studio Code", folder]))) throw new Error("couldn't open VS Code");
    }
  },
};
