#!/usr/bin/env bun
// Re-runnable check of the 8 design assumptions in the spec (#1, "Verify before building").
// Usage: bun scripts/smoke.ts [1..8 ...]   Env: F1RM_SMOKE_DIR (default /tmp/f1rm-smoke).
// Runs real `claude` sessions on Haiku with hooks from a per-run --settings file pointed at a local listener.
// It never reads or writes ~/.claude/settings.json beyond a before/after checksum.
// Side effects owned by claude itself: the first run in a new F1RM_SMOKE_DIR accepts the folder-trust dialog
// (recorded in ~/.claude.json), and check 3 creates ~/.claude/agent-memory/f1rmspike-memrole/.
// Exit code is 1 when any check fails or settings.json changed.
import { $ } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.F1RM_SMOKE_DIR ?? "/tmp/f1rm-smoke";
const PROJ = join(ROOT, "proj");
const PROJ2 = join(ROOT, "proj2");
const PLUG = join(ROOT, "plugin");
const SETTINGS = join(ROOT, "settings.json");
const USER_SETTINGS = join(homedir(), ".claude", "settings.json");
const sleep = (ms: number) => Bun.sleep(ms);
const nonce = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const dec = new TextDecoder();
// ponytail: wait helpers poll every 200 ms; fine for a manual smoke run
async function until<T>(f: () => T | undefined | false | null, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

type Ev = { at: number; path: string; h: Record<string, string>; b: any };
const events: Ev[] = [];
let permHoldMs = 0;
const listener = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let b: any = {};
    try { b = JSON.parse(await req.text()); } catch {}
    events.push({ at: Date.now(), path: url.pathname, h: Object.fromEntries(req.headers), b });
    if (url.pathname === "/perm") await sleep(permHoldMs);
    return new Response(null, { status: 200 });
  },
});
const evs = (name: string, sid: string) => events.filter((e) => e.b.hook_event_name === name && e.b.session_id === sid);

const ENV_HEADERS = {
  "X-F1rm-Iterm": "$ITERM_SESSION_ID",
  "X-F1rm-Term": "$TERM_PROGRAM",
  "X-F1rm-Sock": "$CLAUDE_CODE_MESSAGING_SOCKET",
  "X-F1rm-Tok": "$CLAUDE_CODE_MESSAGING_TOKEN",
  "X-F1rm-Job": "$CLAUDE_JOB_DIR",
};
function writeSettings() {
  const base = `http://127.0.0.1:${listener.port}`;
  const http = (path: string, timeout: number) => ({
    type: "http", url: base + path, timeout, headers: ENV_HEADERS,
    allowedEnvVars: ["ITERM_SESSION_ID", "TERM_PROGRAM", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_JOB_DIR"],
  });
  // SessionStart has no http handler; the command hook is also how the messaging token reaches f1rm
  const curl = `curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-F1rm-Sock: $CLAUDE_CODE_MESSAGING_SOCKET" -H "X-F1rm-Msg-Token: $CLAUDE_CODE_MESSAGING_TOKEN" --data-binary @- ${base}/session-start`;
  const on = (path: string, t = 5) => [{ hooks: [http(path, t)] }];
  writeFileSync(SETTINGS, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: curl }] }],
      UserPromptSubmit: on("/hook"), PreToolUse: on("/hook"), PostToolUse: on("/hook"), Stop: on("/hook"),
      PermissionRequest: on("/perm", 60),
    },
  }));
}

// A child must not look like a child of the session that launched this script
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k))) as Record<string, string>;
async function claude(args: string[], cwd = PROJ) {
  const p = Bun.spawn(["claude", ...args], { cwd, env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), 180_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(t);
  return { code: p.exitCode, out, err };
}
async function claudeJson(args: string[], cwd = PROJ) {
  const r = await claude(["-p", ...args, "--output-format", "json"], cwd);
  let j: any;
  try { j = JSON.parse(r.out); } catch { throw new Error(`claude -p gave no JSON (exit ${r.code}): ${(r.out + r.err).slice(0, 300)}`); }
  if (Array.isArray(j)) j = j.findLast((x) => x.type === "result");
  return { text: String(j?.result ?? ""), sid: String(j?.session_id ?? ""), raw: j };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "").replace(/\s+/g, "");
class Pty {
  raw = "";
  private trusted = false;
  proc: ReturnType<typeof Bun.spawn>;
  constructor(args: string[], env: Record<string, string> = {}, cwd = PROJ) {
    this.proc = Bun.spawn(["claude", ...args], {
      cwd,
      env: { ...cleanEnv(), TERM: "xterm-256color", ...env },
      terminal: {
        cols: 160, rows: 50,
        data: (_t, d) => {
          this.raw += typeof d === "string" ? d : dec.decode(d);
          if (!this.trusted && strip(this.raw.slice(-6000)).includes("Yes,Itrustthisfolder")) {
            this.trusted = true; // default is "No, exit"
            setTimeout(() => this.write("\x1b[B"), 300);
            setTimeout(() => this.write("\r"), 700);
          }
        },
      },
    });
  }
  write(s: string) { this.proc.terminal?.write(s); }
  get mark() { return this.raw.length; }
  textSince(mark = 0) { return strip(this.raw.slice(mark)); }
  async type(text: string) { this.write(text); await sleep(400); this.write("\r"); }
  async close() {
    this.write("\x1b"); this.write("/exit\r");
    await Promise.race([this.proc.exited, sleep(5000)]);
    this.proc.kill();
  }
}
const ptys: Pty[] = [];
function pty(args: string[], env?: Record<string, string>) {
  const p = new Pty(args, env);
  ptys.push(p);
  return p;
}

/** Type a prompt into an interactive session and wait for the turn to end. */
async function ask(p: Pty, sid: string, text: string) {
  const prompts = evs("UserPromptSubmit", sid).length, stops = evs("Stop", sid).length;
  await p.type(text);
  await until(() => evs("UserPromptSubmit", sid).length > prompts, 20_000, "UserPromptSubmit").catch(async () => { p.write("\r"); await until(() => evs("UserPromptSubmit", sid).length > prompts, 20_000, "UserPromptSubmit (retry)"); });
  return String((await until(() => evs("Stop", sid)[stops], 120_000, "Stop")).b.last_assistant_message ?? "");
}

let live: { sid: string; p: Pty } | undefined;
const SENT_ITERM = `w9t9p9:F1RM-SPIKE-${nonce()}`;
async function getLive() {
  if (live) return live;
  const sid = randomUUID();
  const p = pty(["--model", "haiku", "--session-id", sid, "--name", "f1rm-spike-live", "--settings", SETTINGS, "--allowedTools", "Bash(sleep *)"], { ITERM_SESSION_ID: SENT_ITERM });
  await until(() => evs("SessionStart", sid)[0], 120_000, "live SessionStart");
  await sleep(3000);
  return (live = { sid, p });
}

// bg sessions we start are tracked so cleanup never touches anyone else's
const bgIds = new Set<string>();
async function trust(cwd: string) {
  const p = new Pty(["--settings", NOHOOKS], {}, cwd);
  await sleep(10_000);
  await p.close();
}
async function bg(args: string[], cwd = PROJ) {
  let r = await claude(["--bg", ...args], cwd);
  if ((r.out + r.err).includes("Workspace not trusted")) {
    await trust(cwd);
    r = await claude(["--bg", ...args], cwd);
  }
  const id = /backgrounded · ([0-9a-f]+)/.exec(r.out)?.[1];
  if (!id) throw new Error(`--bg did not start: ${(r.out + r.err).slice(0, 300)}`);
  bgIds.add(id);
  return id;
}
async function agentsJson(): Promise<any[]> {
  return JSON.parse((await claude(["agents", "--json", "--all"])).out);
}

const WORD = `PINEAPPLE-${nonce()}`;
function writePlugin() {
  const w = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
  w(join(PLUG, ".claude-plugin/plugin.json"), JSON.stringify({ name: "f1rmspike", version: "0.0.0", description: "f1rm spike fixture" }));
  w(join(PLUG, "skills/codeword/SKILL.md"), `---\nname: codeword\ndescription: Spike fixture\n---\nThe f1rm codeword is ${WORD}.\n`);
  w(join(PLUG, "skills/hidden/SKILL.md"), `---\nname: hidden\ndescription: Spike fixture\ndisable-model-invocation: true\n---\nThe hidden f1rm codeword is H-${WORD}.\n`);
  const agent = (name: string, fm: string) => w(join(PLUG, `agents/${name}.md`), `---\nname: ${name}\ndescription: Spike role ${name}\nmodel: haiku\n${fm}\n---\nYou are a spike role. Answer in as few words as possible.\n`);
  agent("role", "tools: Read\nskills:\n  - f1rmspike:codeword");
  agent("barerole", "tools: Read\nskills:\n  - codeword");
  agent("hiddenrole", "tools: Read\nskills:\n  - f1rmspike:hidden");
  agent("noskill", "tools: Read");
  agent("userskill", "tools: Read\nskills:\n  - design-pipeline");
  w(join(PLUG, "agents/inst.md"), `---\nname: inst\ndescription: Spike role\nmodel: haiku\ntools: Read, Skill\n---\nYour first action is to invoke the Skill tool with skill "f1rmspike:codeword". Then answer in as few words as possible.\n`);
  w(join(PROJ, ".claude/agents/initial.md"), `---\nname: initial\ndescription: Spike role\nmodel: haiku\ntools: Read\ninitialPrompt: /f1rmspike:codeword\n---\nAnswer in as few words as possible.\n`);
  agent("memrole", "tools: Read, Write, Edit\nmemory: user");
}

type R = { ok: boolean; notes: string[] };
const mk = () => { const notes: string[] = []; return { notes, note: (s: string) => notes.push(s) }; };
async function c1(): Promise<R> {
  const { notes, note } = mk();
  const { sid, p } = await getLive();
  const word = `MANGO-${nonce()}`, tag = `FORKQ-${nonce()}`;
  await ask(p, sid, `Remember the codeword ${word}. Reply with only: stored`);
  await sleep(4000);
  const tp: string = evs("Stop", sid)[0].b.transcript_path;
  const fork = (extra: string[] = []) => claudeJson([`(${tag}) What codeword was I asked to remember earlier? Reply with only the codeword.`, "--resume", sid, "--fork-session", ...extra, "--model", "haiku", "--tools", "Read,Grep,Glob", "--disallowedTools", "mcp__*", "--permission-mode", "dontAsk", "--settings", '{"disableAllHooks":true}']);
  const before = readFileSync(tp, "utf8");
  const idle = await fork();
  const now = readFileSync(tp, "utf8");
  const added = now.slice(before.length).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const appendOnly = now.startsWith(before) && added.every((l) => !l.sessionId || l.sessionId === sid);
  note(`idle fork answered "${idle.text.trim()}" as new session ${idle.sid.slice(0, 8)}; live transcript append-only with lines of its own session: ${appendOnly} (${added.length} new lines${added.length ? ": " + added.map((l) => l.type).join(",") : ""})`);
  const noPersist = await fork(["--no-session-persistence"]);
  note(`--no-session-persistence fork answered "${noPersist.text.trim()}"`);
  const lastStop = evs("Stop", sid).length;
  await p.type("Run the bash command `sleep 20`, then reply with only: awake");
  await until(() => evs("PreToolUse", sid).find((e) => e.b.tool_input?.command?.includes("sleep")), 60_000, "sleep PreToolUse");
  const mid = await fork();
  note(`mid-turn fork answered "${mid.text.trim()}"`);
  const awake = String((await until(() => evs("Stop", sid)[lastStop], 120_000, "Stop after sleep")).b.last_assistant_message);
  const recall = await ask(p, sid, "And what was that codeword again? Only the codeword.");
  const transcript = readFileSync(tp, "utf8");
  const leaked = transcript.includes(tag) || [idle.sid, mid.sid, noPersist.sid].some((x) => transcript.includes(x));
  const forkHooks = events.filter((e) => [idle.sid, mid.sid, noPersist.sid].includes(e.b.session_id)).length;
  note(`live turn then finished "${awake.trim()}" and recalled "${recall.trim()}"; fork question or fork ids in live transcript: ${leaked}; hooks fired by forks: ${forkHooks}`);
  const ok = [idle, noPersist, mid].every((f) => f.text.includes(word) && f.sid !== sid) && appendOnly && awake.includes("awake") && recall.includes(word) && !leaked && forkHooks === 0;
  return { ok, notes };
}

const NOHOOKS = '{"disableAllHooks":true}';
const codeQ = "What is the f1rm codeword? Reply with only the codeword, or UNKNOWN.";
async function c2(): Promise<R> {
  const { notes, note } = mk();
  const asRole = async (agent: string, q = codeQ) => (await claudeJson([q, "--plugin-dir", PLUG, "--agent", agent, "--settings", NOHOOKS])).text;
  const asSub = async (agent: string, q = codeQ) => (await claudeJson([`Use the Agent tool with subagent_type "${agent}" and the prompt "${q}". Reply with only what the subagent replied.`, "--plugin-dir", PLUG, "--model", "haiku", "--disallowedTools", "Skill", "--permission-mode", "acceptEdits", "--settings", NOHOOKS])).text;
  const loaded = (t: string, w = WORD) => (t.includes(w) ? "loaded" : `NOT loaded (${t.trim().slice(0, 40)})`);
  const [role, bare, none] = [await asRole("f1rmspike:role"), await asRole("f1rmspike:barerole"), await asRole("f1rmspike:noskill")];
  note(`--agent main session, skills: [f1rmspike:codeword] -> ${loaded(role)}; bare name [codeword] -> ${loaded(bare)}; control without skills -> ${none.includes(WORD) ? "LEAKED" : "does not know it"}`);
  note(`same role run as a subagent via the Agent tool -> ${loaded(await asSub("f1rmspike:role"))}; skill with disable-model-invocation -> ${loaded(await asSub("f1rmspike:hiddenrole"), `H-${WORD}`)}`);
  note(`replacement 1, role body says "invoke the Skill tool first" -> ${loaded(await asRole("f1rmspike:inst"))}`);
  note(`replacement 2, brief starts with the slash command -> ${loaded(await asRole("f1rmspike:role", `/f1rmspike:codeword ${codeQ}`))}; with a disable-model-invocation skill -> ${loaded(await asRole("f1rmspike:role", `/f1rmspike:hidden ${codeQ}`), `H-${WORD}`)}`);
  note(`replacement 3, initialPrompt: /f1rmspike:codeword in a non-plugin agent -> ${loaded(await asRole("initial"))}`);
  const real = join(homedir(), ".claude/skills/design-pipeline/SKILL.md");
  if (existsSync(real)) {
    const h1 = /^# (.+)$/m.exec(readFileSync(real, "utf8"))?.[1] ?? "";
    const t = await asSub("f1rmspike:userskill", "Quote the first H1 heading of your design-pipeline skill verbatim, or UNKNOWN.");
    note(`user-level skill design-pipeline preloaded into a subagent -> ${loaded(t, h1)}`);
  }
  return { ok: role.includes(WORD) && !none.includes(WORD), notes };
}

async function c3(): Promise<R> {
  const { notes, note } = mk();
  const color = `chartreuse-${nonce()}`;
  const agent = ["--plugin-dir", PLUG, "--agent", "f1rmspike:memrole", "--settings", '{"disableAllHooks":true}'];
  const a = await claudeJson([`Remember for later: my favorite color is ${color}. Save it to your memory directory, then reply: saved`, ...agent, "--permission-mode", "acceptEdits"]);
  note(`session 1 (${PROJ}): "${a.text.trim().slice(0, 80)}"`);
  const b = await claudeJson(["What is my favorite color according to your memory? Reply with only the value.", ...agent], PROJ2);
  note(`session 2 (${PROJ2}): "${b.text.trim().slice(0, 80)}"`);
  const files = (await $`grep -rl ${color} ${join(homedir(), ".claude/agent-memory")}`.nothrow().text()).trim();
  note(`memory file: ${files || "none found"}`);
  return { ok: b.text.includes(color) && !!files, notes };
}

let bgLive: { sid: string; sock: string } | undefined;
async function c4(): Promise<R> {
  const { notes, note } = mk();
  const n = nonce();
  writeFileSync(join(PROJ, "hello.txt"), "hello\n");
  const id = await bg(["--model", "haiku", "--name", "f1rm-spike-bg", "--settings", SETTINGS, `Read hello.txt with the Read tool, then reply: bg-${n}`]);
  const submit = await until(() => events.find((e) => e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`bg-${n}`)), 90_000, "bg UserPromptSubmit");
  const sid = submit.b.session_id;
  await until(() => evs("Stop", sid)[0], 90_000, "bg Stop");
  const names = [...new Set(events.filter((e) => e.b.session_id === sid).map((e) => e.b.hook_event_name))];
  bgLive = { sid, sock: submit.h["x-f1rm-sock"] };
  note(`bg ${id}: http hooks fired ${names.join(", ")}; job header "${submit.h["x-f1rm-job"]}", iterm header "${submit.h["x-f1rm-iterm"] ?? ""}"`);
  return { ok: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].every((x) => names.includes(x)), notes };
}

async function c5(): Promise<R> {
  const { notes, note } = mk();
  const { sid, p } = await getLive();
  await ask(p, sid, "Run the bash command `sleep 1`, then reply: ok");
  const e = evs("PreToolUse", sid).at(-1)!;
  const sock = e.h["x-f1rm-sock"];
  const iterm = e.h["x-f1rm-iterm"] === SENT_ITERM, term = !!e.h["x-f1rm-term"], sockOk = !!sock && existsSync(sock);
  const tokHttp = e.h["x-f1rm-tok"] ?? "";
  const tokCmd = events.find((x) => x.path === "/session-start" && x.b.session_id === sid)?.h["x-f1rm-msg-token"] ?? "";
  note(`http headers via allowlist: iterm ${iterm ? "ok" : "MISSING"}, term "${e.h["x-f1rm-term"]}", messaging socket ${sockOk ? "ok " + sock : "MISSING"}`);
  note(`messaging token via http header: ${tokHttp ? "present" : "EMPTY (credential vars are never interpolated)"}; via SessionStart command hook: ${tokCmd ? `present (${tokCmd.length} chars)` : "absent"}`);
  return { ok: iterm && term && sockOk && !!tokHttp, notes };
}

function tell(sock: string, sid: string, text: string) {
  return new Promise<void>((res, rej) => {
    const c = connect(sock, () => c.end(JSON.stringify({ type: "user", session_id: sid, from: "f1rm", message: { role: "user", content: text } }) + "\n"));
    c.on("close", () => res()); c.on("error", rej);
  });
}
async function c6(): Promise<R> {
  const { notes, note } = mk();
  const { sid, p } = await getLive();
  const sock = (await until(() => evs("PreToolUse", sid).at(-1) ?? evs("UserPromptSubmit", sid).at(-1), 5000, "an event with the socket")).h["x-f1rm-sock"];
  const mode = evs("UserPromptSubmit", sid)[0].b.permission_mode;
  const held = /pendingapproval|Approve|held|crossSession/i;
  const idleN = nonce(), m1 = p.mark, stops = evs("Stop", sid).length;
  await tell(sock, sid, `[f1rm spike] Reply with only: TELL-${idleN}`);
  const got = await until(() => events.find((e) => e.b.session_id === sid && e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`TELL-${idleN}`)), 20_000, "idle Tell delivery").catch(() => undefined);
  const reply = got ? String((await until(() => evs("Stop", sid)[stops], 90_000, "Stop after Tell")).b.last_assistant_message) : "";
  note(`receiver permission_mode "${mode}"; idle Tell ${got ? "delivered" : "NOT delivered"}, reply "${reply.trim()}", approval dialog on screen: ${held.test(p.textSince(m1))}`);
  const midN = nonce(), stops2 = evs("Stop", sid).length, m2 = p.mark;
  await p.type("Run the bash command `sleep 12`, then reply with only: slept");
  const pre = await until(() => evs("PreToolUse", sid).find((e) => e.at > m1 && e.b.tool_input?.command?.includes("sleep 12")), 60_000, "sleep PreToolUse");
  await tell(sock, sid, `[f1rm spike] After you finish, also reply with TELL-${midN}`);
  const mid = await until(() => events.find((e) => e.b.session_id === sid && e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`TELL-${midN}`)), 60_000, "mid-turn Tell delivery").catch(() => undefined);
  const post = evs("PostToolUse", sid).findLast((e) => e.b.tool_input?.command?.includes("sleep 12"));
  await until(() => evs("Stop", sid).length > stops2, 120_000, "Stop after mid-turn Tell");
  note(`mid-turn Tell ${mid ? `delivered ${((mid.at - pre.at) / 1000).toFixed(1)}s after the tool started${post && mid.at < post.at ? " (before the tool finished)" : " (after the tool finished)"}` : "NOT delivered"}, approval dialog on screen: ${held.test(p.textSince(m2))}`);
  let bgOk = true;
  if (bgLive) {
    const bgN = nonce();
    await tell(bgLive.sock, bgLive.sid, `[f1rm spike] Reply with only: TELL-${bgN}`);
    const hit = await until(() => events.find((e) => e.b.session_id === bgLive!.sid && e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`TELL-${bgN}`)), 30_000, "bg Tell delivery").catch(() => undefined);
    bgOk = !!hit;
    note(`Tell to the hired (--bg) session from check 4: ${hit ? "delivered" : "NOT delivered"}`);
  }
  return { ok: !!got && reply.includes(`TELL-${idleN}`) && !!mid && !held.test(p.textSince(m1)) && bgOk, notes };
}

async function c7(): Promise<R> {
  const { notes, note } = mk();
  const n = nonce();
  const id = await bg(["--model", "haiku", "--plugin-dir", PLUG, "--agent", "f1rmspike:role", "--name", "f1rm-spike-role", "--settings", SETTINGS, `Reply with only the f1rm codeword and then -${n}`]);
  const submit = await until(() => events.find((e) => e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`-${n}`)), 90_000, "bg role UserPromptSubmit");
  const stop = await until(() => evs("Stop", submit.b.session_id)[0], 90_000, "bg role Stop");
  const row = (await agentsJson()).find((a) => a.id === id);
  note(`UserPromptSubmit payload: agent_type "${submit.b.agent_type}", session_title "${submit.b.session_title}"`);
  note(`agents --json row: name "${row?.name}", has role field: ${row ? Object.keys(row).some((k) => /agent|role/i.test(k)) : "no row"}`);
  note(`bg role session answered "${String(stop.b.last_assistant_message).trim()}" (skill loaded in bg: ${String(stop.b.last_assistant_message).includes(WORD)})`);
  try {
    const repo = join(PROJ, "gitproj"), n2 = nonce();
    await $`rm -rf ${repo} && mkdir -p ${repo} && git -C ${repo} init -q -b main && git -C ${repo} -c user.name=smoke -c user.email=smoke@example.com commit -q --allow-empty -m init`.quiet();
    const hid = await bg(["--model", "haiku", "--plugin-dir", PLUG, "--agent", "f1rmspike:role", "--name", "f1rm-spike-hire", "--worktree", "spike-wt", "--settings", SETTINGS, `/f1rmspike:codeword Reply with only the f1rm codeword and then -${n2}`], repo);
    const sub = await until(() => events.find((e) => e.b.hook_event_name === "UserPromptSubmit" && String(e.b.prompt).includes(`-${n2}`)), 90_000, "hire-shaped UserPromptSubmit");
    const st = await until(() => evs("Stop", sub.b.session_id)[0], 90_000, "hire-shaped Stop");
    const r2 = (await agentsJson()).find((a) => a.id === hid);
    note(`hire-shaped run (--bg --agent --name --worktree, brief starts with /skill): hook cwd "${sub.b.cwd.replace(ROOT, "<root>")}", agent_type "${sub.b.agent_type}", agents --json cwd "${String(r2?.cwd).replace(ROOT, "<root>")}", skill loaded: ${String(st.b.last_assistant_message).includes(WORD)}`);
  } catch (e) {
    note(`hire-shaped run failed: ${(e as Error).message}`);
  }
  return { ok: submit.b.agent_type === "f1rmspike:role" && (submit.b.session_title === "f1rm-spike-role" || row?.name === "f1rm-spike-role"), notes };
}

async function c8(): Promise<R> {
  const { notes, note } = mk();
  const sid = randomUUID();
  const dialog = /Doyouwantto|Yes,and|1\.Yes|Allowthis/;
  const p = pty(["--model", "haiku", "--session-id", sid, "--permission-mode", "default", "--settings", SETTINGS]);
  await until(() => evs("SessionStart", sid)[0], 120_000, "SessionStart");
  await sleep(3000);
  const runCase = async (hold: number, answerEarly: boolean) => {
    permHoldMs = hold;
    const file = join(PROJ, `f1rm-spike8-${nonce()}`), m = p.mark, perms = evs("PermissionRequest", sid).length, stops = evs("Stop", sid).length;
    await p.type(`Run exactly this bash command and then reply done: /usr/bin/touch ${file}`);
    const req = await until(() => evs("PermissionRequest", sid)[perms], 90_000, "PermissionRequest hook");
    const seen = await until(() => dialog.test(p.textSince(m)) && Date.now(), 30_000, "terminal dialog").catch(() => 0);
    if (!seen) return { seen: 0, pending: false, ran: false, early: false };
    if (!answerEarly) await sleep(Math.max(0, req.at + hold + 1500 - Date.now()));
    p.write("\r");
    const ran = await until(() => existsSync(file) && Date.now(), 60_000, "command ran after approving in terminal").catch(() => 0);
    await until(() => evs("Stop", sid).length > stops, 60_000, "Stop");
    return { seen, pending: seen < req.at + hold, ran: !!ran, early: !!ran && ran < req.at + hold };
  };
  const slow = await runCase(8000, false);
  note(`hook held 8s, then answered with an empty 200: terminal dialog was visible ${slow.pending ? "while the hook was still pending" : "only after the hook returned"}; approving it in the terminal afterwards ran the command: ${slow.ran}`);
  const fast = await runCase(15000, true);
  note(`approved in the terminal while a 15s hold was still pending: command ran ${fast.early ? "before the hook returned" : "(not before the hook returned)"}, session then finished its turn`);
  permHoldMs = 0;
  return { ok: !!slow.seen && slow.ran && fast.ran, notes };
}

const CHECKS: [number, string, () => Promise<R>][] = [
  [1, "--resume --fork-session on a live interactive session", c1],
  [2, "role definitions load plugin skills via --agent", c2],
  [3, "user-scope memory works for --agent roles", c3],
  [4, "--bg sessions fire the http hooks", c4],
  [5, "http hook headers carry iTerm2 id and messaging socket/token", c5],
  [6, "Tell over the socket arrives without an approval prompt", c6],
  [7, "hook payloads / agents --json expose --agent role and --name", c7],
  [8, "empty PermissionRequest answer falls back to the terminal prompt", c8],
];

async function cleanup() {
  for (const p of ptys) await p.close().catch(() => {});
  for (const id of bgIds) {
    await claude(["stop", id]).catch(() => {});
    await sleep(3000);
    const r = await claude(["rm", id]).catch(() => undefined);
    if (r?.code) console.error(`claude rm ${id} exited ${r.code}: ${(r.out + r.err).trim()}`);
  }
  listener.stop(true);
}
process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));

const want = new Set(process.argv.slice(2).map(Number));
const settingsBefore = existsSync(USER_SETTINGS) ? sha(USER_SETTINGS) : "absent";
mkdirSync(PROJ, { recursive: true });
mkdirSync(PROJ2, { recursive: true });
writeSettings();
writePlugin();
const results: { n: number; title: string; ok: boolean; notes: string[] }[] = [];
for (const [n, title, run] of CHECKS) {
  if (want.size && !want.has(n)) continue;
  console.log(`... check ${n}: ${title}`);
  try {
    const r = await run();
    results.push({ n, title, ...r });
  } catch (e) {
    results.push({ n, title, ok: false, notes: [`error: ${(e as Error).message}`] });
  }
}
await cleanup();
const leftover = (await agentsJson().catch(() => [])).filter((a) => bgIds.has(a.id) && a.state !== "stopped");
const settingsAfter = existsSync(USER_SETTINGS) ? sha(USER_SETTINGS) : "absent";
console.log("");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}. ${r.title}`);
  for (const l of r.notes) console.log(`        ${l}`);
}
console.log(`\nuser settings.json ${settingsBefore === settingsAfter ? "unchanged" : "CHANGED"} (${settingsBefore.slice(0, 12)} -> ${settingsAfter.slice(0, 12)}); bg sessions left running: ${leftover.length}`);
process.exit(results.every((r) => r.ok) && settingsBefore === settingsAfter ? 0 : 1);
