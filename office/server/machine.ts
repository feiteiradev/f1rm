// The machine module: the only code that touches the OS. Seam 1 tests swap it for a fake.
import { lstatSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute } from "node:path";

/** The environment for a spawned `claude`, without the session variables of a Claude Code session that launched f1rm: they would make the child look like that session's own child. */
export function claudeEnv(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)));
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop()!;
    yield* parts.filter(Boolean);
  }
  if (buf) yield buf;
}

const ITERM ='application id "com.googlecode.iterm2"';
// A leading "-" would let an id be read as a flag.
const SAFE_ID = /^\w[\w-]*$/;

/** One shell word that holds `s` literally, in sh, bash, zsh and fish alike. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `claude agents --json`'s sessions, or null if it can't say. `all` adds finished background sessions. */
export async function agents(all: boolean): Promise<any[] | null> {
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

/** Runs `claude` with `args` and no stdin; the exit code and what it printed. */
async function claude(...args: string[]) {
  const proc = Bun.spawn(["claude", ...args], { env: claudeEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, text: (err || out).trim() };
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

const ASK_PREAMBLE =
  "This is a side question from the user, not a new task. Answer it from this conversation so far. Do not continue or redo the work, and do not change anything. Be brief.\n\n";

export const machine = {
  /**
   * Streams the answer to a side question from a read-only Haiku fork of the session. The fork runs in the
   * session's cwd with every hook off (so it never reaches the office), no transcript of its own, and only
   * Read, Grep and Glob. It sees what is in the transcript, not a turn still being written. Throws if it can't answer; aborting `signal` kills it.
   */
  async *askFork(sessionId: string, cwd: string, question: string, signal?: AbortSignal): AsyncGenerator<string> {
    if (!SAFE_ID.test(sessionId)) throw new Error("bad session id");
    const proc = Bun.spawn(
      [
        "claude", "-p", "--resume", sessionId, "--fork-session", "--no-session-persistence",
        "--model", "haiku", "--tools", "Read,Grep,Glob", "--disallowedTools", "mcp__*", "--permission-mode", "dontAsk",
        "--settings", '{"disableAllHooks":true}',
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ],
      // The question goes in on stdin, where a leading "-" can't be read as a flag.
      { cwd, env: claudeEnv(), stdin: new Blob([ASK_PREAMBLE + question]), stdout: "pipe", stderr: "pipe", timeout: 180_000, signal },
    );
    const stderr = new Response(proc.stderr).text();
    try {
      let streamed = false, final: any;
      for await (const line of lines(proc.stdout)) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const ev = msg?.type === "stream_event" && !msg.parent_tool_use_id ? msg.event : null;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "text" && streamed) yield "\n\n";
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          streamed = true;
          yield ev.delta.text;
        }
        if (msg?.type === "result") final = msg;
      }
      const code = await proc.exited;
      if (final?.is_error || (!final && code !== 0)) {
        throw new Error(String(final?.result || (await stderr).trim().slice(-300) || `claude exited with ${code}`));
      }
      // Without token deltas the whole answer still arrives, in the result.
      if (!streamed && typeof final?.result === "string") yield final.result;
    } finally {
      proc.kill();
    }
  },

  /**
   * Writes a message into a session's inbox socket; Claude Code reads it at the session's next step, never mid-tool. Resolves once the frame is written.
   * Throws unless `socketPath` is an absolute path to a socket file (a symlink is refused: the path came from a hook header).
   */
  async tell(socketPath: string, sessionId: string, message: string): Promise<void> {
    // Claude Code keeps every session's inbox in a cc-socks folder; anything else could be another program's socket.
    if (basename(dirname(socketPath)) !== "cc-socks") throw new Error("that isn't a Claude Code inbox socket");
    if (!isAbsolute(socketPath) || !lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) {
      throw new Error("its inbox socket is gone, so the session has ended");
    }
    // ponytail: Claude Code answers nothing on this socket, so a message a bypassPermissions receiver holds for approval reads as "sent"; the panel says to approve it in the terminal. Watch the receiver's hooks or `claude agents --json` (waitingFor) if a real "pending" state is wanted.
    // No auth line: the token can't come from a hook header, and without it a bypassPermissions receiver holds the message.
    const frame = JSON.stringify({ type: "user", session_id: sessionId, from: "f1rm", message: { role: "user", content: message } });
    await new Promise<void>((resolve, reject) => {
      const c = connect(socketPath, () => c.end(frame + "\n"));
      c.setTimeout(5000, () => c.destroy(new Error("its inbox didn't answer")));
      c.on("close", () => resolve());
      c.on("error", (err: NodeJS.ErrnoException) => reject(new Error(err.code === "ECONNREFUSED" ? "its inbox socket is gone, so the session has ended" : err.message)));
    });
  },

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

  /** How many background hires hold a slot, or null if `claude agents --json` can't say. A blocked hire waits on a person and still holds its slot; interactive sessions are the user's, not hires. */
  async workingHires(): Promise<number | null> {
    const list = await agents(false);
    return list && list.filter((a) => a?.kind === "background" && (a.state === "working" || a.state === "blocked")).length;
  },

  /** Runs `argv` (a `claude --bg` start) in `cwd` with no stdin and no shell. Resolves with what it printed; throws with its error output if it fails. */
  async spawnBackground(argv: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(argv, { cwd, env: claudeEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) throw new Error((err || out).trim().slice(-300) || `claude exited with ${code}`);
    return out.trim();
  },

  /** The short id `claude attach` takes for a background session, or null if Claude Code lists none. */
  async backgroundId(sessionId: string): Promise<string | null> {
    const found = (await agents(true))?.find((a) => a?.kind === "background" && a.sessionId === sessionId);
    return typeof found?.id === "string" && SAFE_ID.test(found.id) ? found.id : null;
  },

  /**
   * Stops a background session and removes it with its worktree. `rm` right after `stop` can exit 0 and leave the session, so it
   * is repeated until `claude agents --json --all` no longer lists the id. Throws what claude said if `rm` refuses (uncommitted or unpushed work), or if the session is still listed after `tries`.
   */
  async letGo(id: string, { tries = 10, waitMs = 1000 } = {}): Promise<void> {
    if (!SAFE_ID.test(id)) throw new Error("bad background session id");
    // A session that already ended makes `stop` fail, and `rm` works on it all the same.
    await claude("stop", id);
    // ponytail: a refused `rm` is final and unpushed work is never discarded; offer `--discard-unpushed` behind its own confirm if refusals are felt.
    for (let i = 0; i < tries; i++) {
      const rm = await claude("rm", id);
      if (rm.code !== 0) throw new Error(rm.text.slice(-300) || `claude rm exited with ${rm.code}`);
      const list = await agents(true);
      if (list && !list.some((a) => a?.id === id)) return;
      await Bun.sleep(waitMs);
    }
    throw new Error(`${id} is still listed after ${tries} tries`);
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

  /** Opens a new iTerm2 tab in `folder` running `f1rm pm`. The folder reaches a shell line, so it is single-quoted and anything that could act as a keystroke is refused. */
  async startPmInIterm(folder: string): Promise<void> {
    if (!isAbsolute(folder) || /[\x00-\x1f\x7f]/.test(folder)) throw new Error("bad project folder");
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error("the project folder is gone");
    await osascript(RUN_IN_NEW_TAB, `cd ${shellQuote(folder)} && f1rm pm`);
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
