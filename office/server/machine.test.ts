// The machine module's OS calls against stub `claude`, `osascript`, `code` and `open` commands on PATH.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine as realMachine } from "./machine.ts";

const dir = mkdtempSync(join(tmpdir(), "f1rm-machine-"));
const log = join(dir, "calls.log");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Each stub logs "name<TAB>args...<TAB>[env:<count of CLAUDE_CODE_ vars>]", prints $STUB_OUT and exits $STUB_EXIT.
const STUB = `#!/bin/sh
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$(printf %s "$a" | tr '\\n' ' ')"; done; printf '\\t[env:%s]\\n' "$(env | grep -c '^CLAUDE_CODE_')"; } >> "$STUB_LOG"
pwd -P >> "$STUB_LOG.cwd"
[ "$(basename "$0")" = claude ] && cat > "$STUB_LOG.stdin"
printf %s "$STUB_OUT"
exit "\${STUB_EXIT:-0}"
`;
for (const name of ["claude", "osascript", "code", "open"]) {
  writeFileSync(join(dir, name), STUB);
  chmodSync(join(dir, name), 0o755);
}

// Bun resolves a spawned command against the PATH it started with, so each call runs in a child that starts with the stubs first.
async function run(expr: string, out = "", exit: Record<string, number> = {}) {
  for (const f of [log, log + ".cwd", log + ".stdin"]) rmSync(f, { force: true });
  writeFileSync(log, "");
  const child = Bun.spawn(
    ["bun", "-e", `import { machine } from ${JSON.stringify(import.meta.dir + "/machine.ts")}; console.log(JSON.stringify((await Promise.resolve(${expr}).catch((e) => ({ threw: e.message }))) ?? null))`],
    {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, STUB_OUT: out, STUB_EXIT: String(exit.all ?? 0), CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/not-for-children" },
      stdout: "pipe",
    },
  );
  const value = JSON.parse(await new Response(child.stdout).text());
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return { value, cwds: read(log + ".cwd").trim().split("\n").filter(Boolean), stdin: read(log + ".stdin"), calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t")) };
}

const claudeAgents = async (out: string, exit = 0) => {
  const { value } = await run("machine.liveSessions().then((s) => s && [...s])", out, { all: exit });
  return value && new Set<string>(value);
};

test("liveSessions lists the session ids of `claude agents --json`", async () => {
  const out = JSON.stringify([
    { pid: 1, cwd: "/code/shop", kind: "interactive", startedAt: 0, sessionId: "a", name: "x", status: "busy" },
    { pid: 2, cwd: "/code/shop", kind: "background", startedAt: 0, sessionId: "b", name: "y", status: "waiting", waitingFor: "approval" },
  ]);
  expect(await claudeAgents(out)).toEqual(new Set(["a", "b"]));
  expect(await claudeAgents("[]")).toEqual(new Set());
});

test("liveSessions is null when claude agents fails, so nobody is mistaken for gone", async () => {
  expect(await claudeAgents("[]", 1)).toBeNull();
  expect(await claudeAgents("not json")).toBeNull();
  expect(await claudeAgents('{"error":"x"}')).toBeNull();
});

test("backgroundId finds the attach handle of a background session, among finished ones too", async () => {
  const out = JSON.stringify([
    { pid: 1, cwd: "/a", kind: "interactive", sessionId: "same" },
    { id: "7c5dcf5d", cwd: "/a", kind: "background", sessionId: "same", state: "done" },
    { id: "0badf00d", cwd: "/a", kind: "background", sessionId: "other" },
  ]);
  const { value, calls } = await run(`machine.backgroundId("same")`, out);
  expect(value).toBe("7c5dcf5d");
  expect(calls[0].slice(0, 4)).toEqual(["claude", "agents", "--json", "--all"]);
  expect((await run(`machine.backgroundId("nobody")`, out)).value).toBeNull();
  expect((await run(`machine.backgroundId("same")`, JSON.stringify([{ id: "$(rm -rf)", kind: "background", sessionId: "same" }]))).value).toBeNull();
});

test("claude is never started with the parent session's CLAUDE_CODE_ variables", async () => {
  const { calls } = await run("machine.liveSessions()", "[]");
  expect(calls[0].at(-1)).toBe("[env:0]");
});

test("focusIterm passes the session guid to AppleScript as an argument and reports whether the tab was found", async () => {
  const found = await run(`machine.focusIterm("w2t5p0:6C2B4D3E-1A2B-4C5D-8E9F-0123456789AB")`, "ok");
  expect(found.value).toBe(true);
  expect(found.calls[0][0]).toBe("osascript");
  expect(found.calls[0][1]).toBe("-e");
  expect(found.calls[0].at(-2)).toBe("6C2B4D3E-1A2B-4C5D-8E9F-0123456789AB");
  expect((await run(`machine.focusIterm("w2t5p0:6C2B4D3E-1A2B-4C5D-8E9F-0123456789AB")`, "missing")).value).toBe(false);
  const hostile = await run(`machine.focusIterm('w0t0p0:x" & (do shell script "id") & "')`, "ok");
  expect([hostile.value, hostile.calls]).toEqual([false, []]);
});

test("attachInIterm types `claude attach <id>` into a new tab, and refuses an id with shell syntax", async () => {
  const { calls } = await run(`machine.attachInIterm("7c5dcf5d")`);
  expect(calls[0].at(-2)).toBe("claude attach 7c5dcf5d");
  const bad = await run(`machine.attachInIterm("7c5; rm -rf ~")`);
  expect([bad.value, bad.calls]).toEqual([{ threw: "bad background session id" }, []]);
});

test("openVsCode runs `code <folder>`, and falls back to `open -a` when that fails", async () => {
  const ok = await run(`machine.openVsCode("/code/shop")`);
  expect(ok.calls.map((c) => c.slice(0, 2))).toEqual([["code", "/code/shop"]]);
  const fallback = await run(`machine.openVsCode("/code/shop")`, "", { all: 1 });
  expect(fallback.calls.map((c) => c.slice(0, -1))).toEqual([["code", "/code/shop"], ["open", "-a", "Visual Studio Code", "/code/shop"]]);
  expect(fallback.value).toEqual({ threw: "couldn't open VS Code" });
});

const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const textBlock = JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
const result = (r: object) => JSON.stringify({ type: "result", subtype: "success", is_error: false, ...r });
const ask = (question: string, out: string, exit = 0) =>
  run(`(async () => { const parts = []; for await (const t of machine.askFork("sid-1", ${JSON.stringify(askDir)}, ${JSON.stringify(question)})) parts.push(t); return parts; })()`, out, { all: exit });
const askDir = realpathSync(mkdtempSync(join(dir, "session-cwd-")));

test("askFork forks the session on Haiku with read-only tools, hooks off and no transcript, in the session's folder", async () => {
  const { calls, cwds, stdin, value } = await ask("--What is the codeword?", [delta("The codeword "), delta("is MANGO."), result({ result: "The codeword is MANGO." })].join("\n"));
  expect(value).toEqual(["The codeword ", "is MANGO."]);
  expect(calls[0].slice(0, -1)).toEqual([
    "claude", "-p", "--resume", "sid-1", "--fork-session", "--no-session-persistence",
    "--model", "haiku", "--tools", "Read,Grep,Glob", "--disallowedTools", "mcp__*", "--permission-mode", "dontAsk",
    "--settings", '{"disableAllHooks":true}',
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  ]);
  expect(calls[0].at(-1)).toBe("[env:0]");
  expect(cwds).toEqual([askDir]);
  expect(stdin.endsWith("\n\n--What is the codeword?")).toBe(true);
});

test("askFork refuses a session id that could be read as a flag, and spawns nothing", async () => {
  const { calls, value } = await run(`(async () => { for await (const _ of machine.askFork("--dangerously-skip-permissions", ${JSON.stringify(askDir)}, "q")); })()`);
  expect(value).toEqual({ threw: "bad session id" });
  expect(calls).toEqual([]);
});

test("askFork separates text blocks, falls back to the final result without deltas, and throws what went wrong", async () => {
  expect((await ask("q", [textBlock, delta("Let me look."), textBlock, delta("It is MANGO."), result({})].join("\n"))).value).toEqual(["Let me look.", "\n\n", "It is MANGO."]);
  expect((await ask("q", result({ result: "MANGO" }))).value).toEqual(["MANGO"]);
  expect((await ask("q", result({ is_error: true, result: "No conversation found with session ID: sid-1" }))).value).toEqual({ threw: "No conversation found with session ID: sid-1" });
  expect((await ask("q", "", 1)).value).toEqual({ threw: "claude exited with 1" });
});

// A stand-in for a session's inbox: a unix socket that records what is written to it. Short path: sockets cap near 104 bytes.
async function inbox() {
  const path = join(mkdtempSync(join("/tmp", "f1rm-ib-")), "s.sock");
  const received: string[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => received.push(buf));
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, received, stop: () => server.close() };
}

test("tell writes one newline-ended user frame, with the session id, into the inbox socket", async () => {
  const box = await inbox();
  await realMachine.tell(box.path, "sess-1", "Use the staging database.\nThen rerun.");
  await Bun.sleep(50);
  box.stop();
  expect(box.received).toEqual([
    JSON.stringify({ type: "user", session_id: "sess-1", from: "f1rm", message: { role: "user", content: "Use the staging database.\nThen rerun." } }) + "\n",
  ]);
});

test("tell refuses a path that isn't an absolute, existing socket file", async () => {
  const box = await inbox();
  const link = join(mkdtempSync(join("/tmp", "f1rm-ib-")), "link.sock");
  symlinkSync(box.path, link);
  const file = join(dir, "plain.sock");
  writeFileSync(file, "");
  for (const bad of ["s.sock", "./s.sock", "/tmp/f1rm-no-such/s.sock", file, link, dir]) {
    await expect(realMachine.tell(bad, "sess-1", "hi")).rejects.toThrow("its inbox socket is gone");
  }
  await Bun.sleep(50);
  box.stop();
  expect(box.received).toEqual([]);
});
