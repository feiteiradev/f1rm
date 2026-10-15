#!/usr/bin/env bun
// Re-runnable check of Jump against the real iTerm2 and Claude Code (#7).
// Usage: bun scripts/jump-smoke.ts [iterm] [bg]      Env: F1RM_JUMP_DIR (folder the background session runs in, default: this repo)
//   iterm  creates its own iTerm2 windows (4 x 10 tabs) and jumps between their tabs with the real machine module.
//   bg     starts one Haiku `claude --bg` session, jumps to it through a real f1rm server and checks the tab that opens.
// It types only into tabs it created, closes only windows it created, and stops and removes the session it started.
// It never touches ~/.claude/settings.json: the session's hooks come from a --settings argument.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { machine } from "../office/server/machine.ts";
import { startServer } from "../office/server/server.ts";

const sleep = (ms: number) => Bun.sleep(ms);
const ITERM = 'application id "com.googlecode.iterm2"';
async function osa(script: string, ...args: string[]) {
  const p = Bun.spawn(["osascript", "-e", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`osascript: ${err.trim()}`);
  return out.trim();
}
async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<Exclude<T, false | null | undefined | 0 | "">> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await f();
    if (v) return v as Exclude<T, false | null | undefined | 0 | "">;
  }
  throw new Error(`timeout waiting for ${what}`);
}

// Windows this script created, by iTerm2 window id, kept in a file so a crashed run can still be cleaned up. Nothing else is ever closed.
const MINE_FILE = join(tmpdir(), "f1rm-jump-smoke-windows.json");
const mine = new Set<string>(existsSync(MINE_FILE) ? JSON.parse(readFileSync(MINE_FILE, "utf8")) : []);
const saveMine = () => writeFileSync(MINE_FILE, JSON.stringify([...mine]));
const allWindows = () => osa(`tell ${ITERM}
  set AppleScript's text item delimiters to ","
  return (id of windows) as text
end tell`);
const windowsBefore = await allWindows().catch(() => "");

const NEW_WINDOW = `on run argv
  tell ${ITERM}
    set w to (create window with default profile)
    repeat (item 1 of argv as integer) - 1 times
      tell w to create tab with default profile
    end repeat
    set ids to {(id of w) as text}
    repeat with t in tabs of w
      set end of ids to unique id of current session of t
    end repeat
    set AppleScript's text item delimiters to " "
    return ids as text
  end tell
end run`;
const CURRENT = `tell ${ITERM} to return ((id of current window) as text) & " " & (unique id of current session of current tab of current window)`;
const TAB_COUNT = `on run argv
  tell ${ITERM}
    repeat with w in windows
      if ((id of w) as text) is item 1 of argv then return count of tabs of w
    end repeat
  end tell
end run`;
const CLOSE_MINE = `on run argv
  tell ${ITERM}
    set ws to windows
    repeat with w in ws
      if argv contains ((id of w) as text) then
        repeat (count of tabs of w) times
          try
            close last tab of w
          end try
        end repeat
        try
          close w
        end try
      end if
    end repeat
  end tell
end run`;
const LAST_TAB_TEXT = `on run argv
  tell ${ITERM}
    repeat with w in windows
      if ((id of w) as text) is item 1 of argv then return text of current session of last tab of w
    end repeat
  end tell
end run`;
const TYPE_INTO = `on run argv
  tell ${ITERM}
    repeat with w in windows
      if ((id of w) as text) is item 1 of argv then
        repeat with s in sessions of first tab of w
          if unique id of s is item 2 of argv then tell s to write text (item 3 of argv)
        end repeat
      end if
    end repeat
  end tell
end run`;

async function newWindow(tabs: number) {
  const [id, ...guids] = (await osa(NEW_WINDOW, String(tabs))).split(" ");
  mine.add(id);
  saveMine();
  return { id, guids };
}

async function checkIterm() {
  const wins = [];
  for (let i = 0; i < 4; i++) wins.push(await newWindow(10));
  const tabs = wins.flatMap((w) => w.guids.map((guid) => ({ win: w.id, guid })));
  console.log(`  created ${wins.length} windows with ${tabs.length} tabs`);

  // The prefix of $ITERM_SESSION_ID is w<window>t<tab>p<pane>; the part after ':' must be the session's unique id.
  const probe = join(tmpdir(), `f1rm-jump-${randomBytes(4).toString("hex")}`);
  await sleep(1500);
  await osa(TYPE_INTO, wins[0].id, wins[0].guids[0], `echo $ITERM_SESSION_ID > ${probe}`);
  const env = await until(() => existsSync(probe) && readFileSync(probe, "utf8").trim(), 10_000, "$ITERM_SESSION_ID of a created tab");
  rmSync(probe, { force: true });
  console.log(`  $ITERM_SESSION_ID of a created tab: ${env} (unique id ${wins[0].guids[0]})`);
  if (!/^w\d+t\d+p\d+:/.test(env) || env.split(":")[1] !== wins[0].guids[0]) throw new Error("$ITERM_SESSION_ID doesn't carry the session's unique id");

  // Interleaved across windows, then neighbours, then the same tab twice.
  const order = [0, 39, 13, 14, 27, 1, 38, 25, 26, 12, 12, 9, 10];
  const started = Date.now();
  for (const n of order) {
    const { win, guid } = tabs[n];
    const found = await machine.focusIterm(`w${wins.findIndex((w) => w.id === win)}t${n % 10}p0:${guid}`);
    let [curWin, curGuid] = (await osa(CURRENT)).split(" ");
    for (let waited = 0; (curWin !== win || curGuid !== guid) && waited < 3000; waited += 100) {
      await sleep(100);
      [curWin, curGuid] = (await osa(CURRENT)).split(" ");
      if (curWin === win && curGuid === guid) console.log(`  (tab ${n} selected after ${waited + 100} ms)`);
    }
    if (!found || curWin !== win || curGuid !== guid) throw new Error(`jump to tab ${n} landed on window ${curWin} session ${curGuid}`);
  }
  console.log(`  ${order.length} jumps each landed on exactly its tab (${Math.round((Date.now() - started) / order.length)} ms per jump including the check)`);
  if (await machine.focusIterm("w0t0p0:00000000-0000-0000-0000-000000000000")) throw new Error("jump to a tab that doesn't exist reported success");
  console.log("  a tab that doesn't exist reports missing");
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k))) as Record<string, string>;
async function claude(args: string[], cwd: string) {
  const p = Bun.spawn(["claude", ...args], { cwd, env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return out + err;
}
const agentsAll = async (cwd: string) => JSON.parse(await claude(["agents", "--json", "--all"], cwd)) as any[];

async function checkBackground() {
  const dir = resolve(process.env.F1RM_JUMP_DIR ?? join(import.meta.dir, ".."));
  const secret = randomBytes(8).toString("hex"), token = randomBytes(8).toString("hex");
  const server = startServer({ port: 0, secret, token, machine, clientDir: join(import.meta.dir, "../office/client/dist") });
  const base = `http://127.0.0.1:${server.port}`;
  const env = { "X-F1rm-Secret": secret, "X-F1rm-Iterm-Session": "$ITERM_SESSION_ID", "X-F1rm-Term-Program": "$TERM_PROGRAM" };
  const hook = { hooks: [{ type: "http", url: `${base}/ingest`, headers: env, allowedEnvVars: ["ITERM_SESSION_ID", "TERM_PROGRAM"], timeout: 5 }] };
  const settings = JSON.stringify({ hooks: { UserPromptSubmit: [hook], PreToolUse: [hook], Stop: [hook] } });

  let id = "";
  try {
    const started = await claude(["--bg", "--model", "haiku", "--name", "f1rm-jump-smoke", "--settings", settings, "Reply with exactly: jump-smoke-ok"], dir);
    id = /backgrounded · ([0-9a-f]+)/.exec(started)?.[1] ?? "";
    if (!id) throw new Error(`--bg did not start (is ${dir} trusted? run claude there once): ${started.slice(0, 300)}`);
    console.log(`  started background session ${id}`);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${token}/ws`, { headers: { origin: base } } as any);
    let state: any = { employees: {} };
    ws.onmessage = (m) => (state = JSON.parse(String(m.data)));
    const emp = await until(() => Object.values<any>(state.employees).find((e) => e.cwd === dir || e.cwd.startsWith(dir)), 120_000, "the background employee");
    console.log(`  employee ${emp.sessionId} arrived with terminal ${JSON.stringify(emp.terminal)}`);
    if (emp.terminal.itermSessionId) throw new Error("a background session unexpectedly carries an iTerm2 id");
    const listed = (await agentsAll(dir)).find((a) => a.id === id);
    if (listed?.sessionId !== emp.sessionId) throw new Error("hook session id differs from `claude agents` sessionId");
    ws.close();

    const win = await newWindow(1);
    await sleep(1500);
    const before = Number(await osa(TAB_COUNT, win.id));
    const res = await fetch(`${base}/${token}/jump/${emp.sessionId}`, { method: "POST" });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`jump answered ${res.status} ${JSON.stringify(body)}`);
    await until(async () => Number(await osa(TAB_COUNT, win.id)) === before + 1, 10_000, "the new tab");
    const screen = await until(async () => {
      const t = await osa(LAST_TAB_TEXT, win.id);
      return /claude attach/.test(t) && t;
    }, 10_000, "`claude attach` in the new tab");
    console.log(`  jump opened tab ${before + 1} in the window: ${screen.split("\n").filter((l) => l.trim()).slice(0, 2).join(" | ").slice(0, 120)}`);
    await until(async () => /f1rm-jump-smoke|jump-smoke-ok/.test(await osa(LAST_TAB_TEXT, win.id)), 20_000, "the attached session on screen");
    console.log("  the new tab shows the attached session");
  } finally {
    server.stop(true);
    if (id) {
      await claude(["stop", id], dir).catch(() => {});
      for (let i = 0; i < 10; i++) {
        await sleep(2000);
        await claude(["rm", id], dir).catch(() => {});
        if (!(await agentsAll(dir).catch(() => [])).some((a) => a.id === id)) break;
      }
      const left = (await agentsAll(dir).catch(() => [])).some((a) => a.id === id);
      console.log(`  background session ${id}: ${left ? "STILL LISTED" : "stopped and removed"}`);
      if (left) process.exitCode = 1;
    }
  }
}

const checks: Record<string, () => Promise<void>> = { iterm: checkIterm, bg: checkBackground };
const cleanupOnly = process.argv[2] === "cleanup";
const want = process.argv.slice(2).filter((a) => a in checks);
if (cleanupOnly) {
  console.log(`closing this script's windows [${[...mine]}]; iTerm2 has [${await allWindows()}]`);
  for (const id of mine) console.log(`  window ${id} has ${await osa(TAB_COUNT, id).catch((e) => e.message)} tabs`);
}
let failed = false;
for (const name of cleanupOnly ? [] : want.length ? want : Object.keys(checks)) {
  console.log(`... ${name}`);
  try {
    await checks[name]();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}
if (mine.size) await osa(CLOSE_MINE, ...mine).catch((e) => console.log(`could not close: ${e.message}`));
const windowsAfter = await allWindows().catch(() => "");
const leftover: string[] = [];
const ghosts: string[] = [];
for (const id of windowsAfter.split(",").filter((id) => mine.has(id))) {
  // iTerm2 sometimes keeps a closed window listed with no tabs; there is nothing left in it to close.
  (Number(await osa(TAB_COUNT, id)) > 0 ? leftover : ghosts).push(id);
}
mine.clear();
leftover.forEach((id) => mine.add(id));
saveMine();
console.log(`iTerm2 windows before [${windowsBefore}], after [${windowsAfter}], this script's still open [${leftover}], tabless ghosts [${ghosts}]`);
process.exit(failed || leftover.length || process.exitCode ? 1 : 0);
