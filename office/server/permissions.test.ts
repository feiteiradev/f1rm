// A project's command list in the office: the routes only the user's browser answers, the state the page gets, and the gates that keep every session out of the permission settings.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFile } from "./editions.ts";
import { commandsFile } from "./projectcmds.ts";
import { startServer } from "./server.ts";
import type { OfficeState } from "./office.ts";

const SECRET = "ingest-secret";
const TOKEN = "ui-token";
let server: ReturnType<typeof startServer>;
let sockets: WebSocket[] = [];
afterEach(() => {
  sockets.forEach((s) => s.close());
  sockets = [];
  server?.stop(true);
});

const clientDir = mkdtempSync(join(tmpdir(), "f1rm-client-"));
writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>f1rm</title>");

/** A Bun project in a real folder (the office reads its package.json). */
function project(scripts: Record<string, string> = { test: "bun test", build: "vite build", deploy: "x", start: "bun run x" }) {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-proj-"));
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop", scripts }));
  writeFileSync(join(dir, "bun.lock"), "");
  return dir;
}
const roomOf = (dir: string) => join(dir, ".git");

/** An office that knows the project in `dir` (registered as `f1rm pm` would) and /code/shop, which has no folder on disk. */
function start(dir?: string, projectsDir = mkdtempSync(join(tmpdir(), "f1rm-projects-"))) {
  const repos: Record<string, string> = { "/code/shop": "/code/shop/.git", ...(dir && { [dir]: roomOf(dir) }) };
  for (const common of Object.values(repos)) if (!existsSync(projectFile(projectsDir, common))) writeFileSync(projectFile(projectsDir, common), "{}\n");
  const machine = {
    gitCommonDir: (cwd: string) => repos[cwd] ?? null,
    isRepo: () => true,
    liveSessions: async () => new Map(),
    backgroundId: async () => null,
    sessions: async () => [],
    workingHires: async () => 0,
    backgroundSessions: async () => [],
  };
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: machine as never, clientDir, projectsDir, junkRoots: [], boardsDir: mkdtempSync(join(tmpdir(), "f1rm-boards-")) });
  return projectsDir;
}
const base = () => `http://127.0.0.1:${server.port}`;
const hook = (payload: object) => fetch(`${base()}/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-f1rm-secret": SECRET }, body: JSON.stringify(payload) });
const ui = (path: string, init: RequestInit = {}, token = TOKEN) => fetch(`${base()}/${token}/${path}`, init);
function office(until: (s: OfficeState) => boolean, timeout = 1000) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${TOKEN}/ws`, { headers: { origin: base() } } as never);
  sockets.push(ws);
  return new Promise<OfficeState>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no matching state within " + timeout + "ms")), timeout);
    ws.onmessage = (m) => {
      const state = JSON.parse(String(m.data)) as OfficeState;
      if (until(state)) (clearTimeout(timer), resolve(state));
    };
  });
}
const common = (session_id: string, hook_event_name: string, cwd = "/code/shop") => ({ session_id, transcript_path: `/Users/me/.claude/projects/x/${session_id}.jsonl`, cwd, permission_mode: "default", hook_event_name });
const preToolUse = (id: string, tool_name: string, tool_input: object, extra: object = {}) => ({ ...common(id, "PreToolUse"), tool_name, tool_input, tool_use_id: "toolu_1", ...extra });
const held = async (r: Response) => {
  const body = await r.text();
  return body ? JSON.parse(body).hookSpecificOutput : null;
};
const commandsPath = (room: string) => `commands/${encodeURIComponent(room)}`;
const approve = (room: string, ids: unknown, init: RequestInit = {}) => ui(commandsPath(room), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }), ...init });

/** A session in the project's folder, so its room shows; resolves with the state that has it. */
async function enter(dir: string) {
  await hook({ ...common("pm0", "SessionStart", dir), source: "startup", model: "claude-opus-5-5" });
  return office((s) => roomOf(dir) in s.rooms);
}

test("a project whose commands are not approved carries its proposal in the state; the browser reads it, and a folder that is gone has none", async () => {
  const dir = project();
  start(dir);
  await hook({ ...common("ghost", "SessionStart"), source: "startup", model: "claude-opus-5-5" });
  const state = await enter(dir);
  expect(state.commands!["/code/shop/.git"]).toBeUndefined();
  const list = state.commands![roomOf(dir)];
  expect(list.find((c) => c.id === "Bash(bun run test *)")).toMatchObject({ group: "script", checked: true });
  expect(list.find((c) => c.id === "Bash(bun run start *)")).toMatchObject({ checked: false });
  expect(list.find((c) => c.id === "Bash(bun run deploy *)")).toMatchObject({ checked: false, excluded: expect.stringContaining("deploy") });
  const got = await (await ui(commandsPath(roomOf(dir)))).json();
  expect(got).toEqual({ approved: false, commands: list });
});

test("the user's tick writes the allow and deny rules into the main checkout, records the set, and clears the proposal; ids that are no line of the list are ignored", async () => {
  const dir = project();
  const projectsDir = start(dir);
  await enter(dir);
  const ticked = ["Bash(bun run test *)", "Bash(git add *)"];
  const res = await approve(roomOf(dir), [...ticked, "Bash(rm -rf /)", "Bash(*)", "Bash(bun run deploy *)"]);
  expect([res.status, await res.json()]).toEqual([200, { ok: true, approved: ticked }]);
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toEqual(ticked);
  expect(settings.permissions.deny).toContain("Bash(gh pr merge *)");
  expect(JSON.parse(readFileSync(commandsFile(projectsDir, roomOf(dir)), "utf8")).approved).toEqual(ticked);
  // nothing shows for the project any more, and the page keeps no card
  const after = await office((s) => !(roomOf(dir) in (s.commands ?? {})));
  expect(after.commands).toEqual({});
  expect(await (await ui(commandsPath(roomOf(dir)))).json()).toEqual({ approved: true, commands: expect.any(Array) });
});

test("the approval is remembered across a restart, and the record is no project", async () => {
  const dir = project();
  const projectsDir = start(dir);
  await enter(dir);
  await approve(roomOf(dir), ["Bash(bun test *)"]);
  server.stop(true);
  start(dir, projectsDir);
  const state = await enter(dir);
  expect(state.commands).toEqual({});
  // `pause --all` walks the registered projects: the record file must not be one of them
  const res = await ui("pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
  const body = await res.json();
  expect(body.rooms.some((r: string) => r.includes("commands"))).toBe(false);
  // and the pause list the page gets (Stop all / Resume all) names real projects only
  const { paused } = await office((s) => (s.paused?.length ?? 0) > 0);
  expect(paused!.some((r) => r.includes("commands"))).toBe(false);
});

test("only the user's browser answers: no link, a wrong link, another origin, another verb, a bad body or an unknown project write nothing", async () => {
  const dir = project();
  start(dir);
  await enter(dir);
  const room = roomOf(dir);
  const path = commandsPath(room);
  const body = JSON.stringify({ ids: ["Bash(bun test *)"] });
  const json = { "content-type": "application/json" };
  const status = async (r: Promise<Response>) => (await r).status;
  expect(await status(approve(room, ["Bash(bun test *)"]))).toBe(200);
  // everything below must find the file as the one good approval left it
  const before = readFileSync(join(dir, ".claude", "settings.local.json"), "utf8");
  expect(await status(ui(path, { method: "POST", headers: json, body }, "wrong"))).toBe(401);
  expect(await status(fetch(`${base()}/${path}`, { method: "POST", headers: json, body }))).toBe(401);
  expect(await status(ui(path, {}, "wrong"))).toBe(401);
  expect(await status(ui(path, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body }))).toBe(403);
  expect(await status(ui(path, { method: "PUT", headers: json, body }))).toBe(405);
  expect(await status(ui(path, { method: "DELETE" }))).toBe(405);
  expect(await status(ui(path, { method: "POST", headers: json, body: "{nope" }))).toBe(400);
  expect(await status(ui(path, { method: "POST", headers: json, body: JSON.stringify({ ids: "Bash(*)" }) }))).toBe(400);
  expect(await status(ui(commandsPath("/no/such/project/.git"), { method: "POST", headers: json, body }))).toBe(404);
  expect(await status(ui(commandsPath("elsewhere"), { method: "POST", headers: json, body }))).toBe(404);
  expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe(before);
});

test("a settings file that cannot be merged fails the approval and is not touched", async () => {
  const dir = project();
  start(dir);
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.local.json"), "{nope");
  await enter(dir);
  const res = await approve(roomOf(dir), ["Bash(bun test *)"]);
  expect(res.status).toBe(500);
  expect((await res.json()).error).toContain("settings.local.json");
  expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe("{nope");
  expect((await office(() => true)).commands![roomOf(dir)]).toBeDefined(); // still waiting for the user
});

test("an office without a settings folder keeps no proposal and refuses the route", async () => {
  const dir = project();
  const repos = { [dir]: roomOf(dir) };
  const machine = { gitCommonDir: (cwd: string) => repos[cwd as keyof typeof repos] ?? null, isRepo: () => true, liveSessions: async () => new Map(), backgroundId: async () => null, sessions: async () => [], workingHires: async () => 0, backgroundSessions: async () => [] };
  server = startServer({ port: 0, secret: SECRET, token: TOKEN, machine: machine as never, clientDir, junkRoots: [] });
  await hook({ ...common("pm0", "SessionStart", dir), source: "startup", model: "claude-opus-5-5" });
  const state = await office((s) => Object.keys(s.employees).length === 1);
  expect(state.commands).toBeUndefined();
  expect((await approve(roomOf(dir), [])).status).toBe(500);
});

// ---- the gates ----

/** A PM, a lead, a designer, a Reviewer, an intern-bearing set of the same, and the user's own session. */
async function gateOffice() {
  start();
  for (const [id, type, title] of [["p", "f1rm:pm", "p-title"], ["l", "f1rm:lead", "lead-checkout"], ["d", "f1rm:designer", "d-title"], ["v", "f1rm:reviewer", "v-title"], ["f", undefined, "f-title"]] as const) {
    await hook({ ...common(id, "UserPromptSubmit"), prompt: "go", session_title: title, ...(type && { agent_type: type }) });
  }
  await office((s) => Object.keys(s.employees).length === 5);
  return {
    bash: async (id: string, command: string, extra: object = {}) => held(await hook(preToolUse(id, "Bash", { command }, extra))),
    tool: async (id: string, name: string, input: object, extra: object = {}) => held(await hook(preToolUse(id, name, input, extra))),
  };
}
/** Every company role, each also as the sub-agent (implementer, reviewer, intern) it starts. */
const COMPANY: [string, object][] = [["p", {}], ["l", {}], ["d", {}], ["v", {}], ["p", { agent_id: "a1", agent_type: "general-purpose" }], ["l", { agent_id: "a2", agent_type: "Explore" }], ["d", { agent_id: "a3", agent_type: "Explore" }], ["v", { agent_id: "a4", agent_type: "Explore" }]];
const label = (id: string, extra: object) => (Object.keys(extra).length ? `${id}/sub-agent` : id);

test("no session approves a project's commands through the office's route; the answer rule covers it and the user's browser does not meet it", async () => {
  const { bash } = await gateOffice();
  const at = `http://127.0.0.1:${server.port}`;
  const refused = [
    `curl -s -X POST ${at}/${TOKEN}/commands/%2Fcode%2Fshop%2F.git -d '{"ids":["Bash(*)"]}'`,
    `curl -s ${at}/${TOKEN}/commands/x`,
    `curl -s -X POST "http://localhost:${server.port}/anything/commands/x"`,
    `curl -X POST "$(cat ~/.f1rm/office-url)commands/x"`,
    `bun -e "fetch('${at}/' + process.env.T + '/commands/x', {method:'POST'})"`,
    `curl -s -X POST ${at}/${TOKEN}/approve/abc`,
  ];
  for (const [id, extra] of COMPANY) {
    for (const command of refused) {
      const out = await bash(id, command, extra);
      expect([label(id, extra), command, out?.permissionDecision]).toEqual([label(id, extra), command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the user answers a permission request, in the office");
    }
  }
  // another app's route, a mention of the word and the user's own session pass
  for (const command of ["curl -s http://localhost:3000/commands/12", "ls docs/commands/", `curl -s ${at}/${TOKEN}/jump/abc`]) expect([command, await bash("d", command)]).toEqual([command, null]);
  expect(await bash("f", refused[0])).toBeNull();
});

const SETTINGS_FILES = ["/code/shop/.claude/settings.json", "/code/shop/.claude/settings.local.json", "/code/shop/.claude/hooks/pre.sh", "/code/shop/.claude/worktrees/t/.claude/settings.local.json", "/code/shop/sub/dir/.claude/hooks/a/b.json", "/Users/me/.claude/settings.json", "/code/shop/.claude/../.claude/settings.json", "/code/shop/.Claude/Settings.Local.json", ".claude/settings.local.json"];

test("every company role, and every sub-agent of one, is refused Write, Edit and NotebookEdit on a Claude Code settings or hooks file, in any folder; the user's own session is not", async () => {
  const { tool } = await gateOffice();
  for (const [id, extra] of COMPANY) {
    for (const file of SETTINGS_FILES) {
      for (const [name, input] of [["Write", { file_path: file, content: "{}" }], ["Edit", { file_path: file, old_string: "a", new_string: "b" }], ["NotebookEdit", { notebook_path: file, new_source: "x" }]] as const) {
        const out = await tool(id, name, input, extra);
        expect([label(id, extra), name, file, out?.permissionDecision]).toEqual([label(id, extra), name, file, "deny"]);
        expect(out.permissionDecisionReason).toContain("Only the user changes Claude Code permissions");
      }
    }
  }
  for (const file of SETTINGS_FILES) expect([file, await tool("f", "Write", { file_path: file, content: "{}" })]).toEqual([file, null]);
  // a file that only looks like one
  for (const file of ["/code/shop/src/a.ts", "/code/shop/.claude/skills/x/SKILL.md", "/code/shop/docs/settings.json", "/code/shop/.claude/worktrees/t/src/x.ts", "/code/shop/claude/settings.json", "/code/shop/.claude-plugin/settings.json"]) {
    expect([file, await tool("d", "Write", { file_path: file, content: "x" })]).toEqual([file, null]);
  }
});

const BASH_REFUSED = [
  `echo '{}' > .claude/settings.local.json`,
  `echo '{}'>.claude/settings.local.json`,
  `cat x >> .claude/settings.json`,
  `cat > .claude/settings.local.json <<EOF\n{}\nEOF`,
  `cat .claude/settings.json > .claude/settings.local.json`,
  `echo x | tee .claude/settings.local.json`,
  `echo x | tee -a /code/shop/.claude/settings.json`,
  `sed -i 's/a/b/' .claude/settings.local.json`,
  `cp /tmp/x .claude/settings.local.json`,
  `mv /tmp/x .claude/settings.json`,
  `ln -sf /tmp/x .claude/settings.local.json`,
  `rm .claude/settings.local.json`,
  `touch .claude/hooks/a.sh`,
  `chmod +x .claude/hooks/a.sh`,
  `bun -e "require('fs').writeFileSync('.claude/settings.local.json','{}')"`,
  `python3 -c "open('settings.local.json','w').write('{}')"`,
  `echo x > ~/.claude/settings.json`,
  `cd .claude && echo '{}' > settings.local.json`,
  `git checkout -- .claude/settings.json`,
  `git diff --output=.claude/settings.local.json`,
  `git log --output .claude/hooks/x -- a`,
  `git restore .claude/settings.json`,
  `echo x > .claude/settings.local.json`,
  `echo x >> .claude/settings.json`,
  `tee .claude/settings.json < /tmp/x`,
  `sed -i s/a/b/ .claude/hooks/x.sh`,
  `cp evil .claude/settings.json`,
  `install -m 755 evil .claude/hooks/x.sh`,
  `dd if=/tmp/x of=.claude/settings.json`,
  `truncate -s 0 .claude/settings.local.json`,
  `perl -pi -e 's/a/b/' .claude/settings.json`,
  `node -e "require('fs').writeFileSync('.claude/hooks/x','1')"`,
  `bash -c "echo {} > .claude/settings.local.json"`,
  `bash -c "echo {} > .claude/settings.local.json"`,
  `mkdir -p .claude/hooks && echo x > .claude/hooks/a`,
  `cd .claude && echo '{}' > settings.json`,
  `echo '{}' > .claude/./settings.local.json`,
  `echo '{}' > .claude//hooks/a`,
  `echo '{}' > "$HOME/.claude/settings.json"`,
  `cat x > '.claude/settings.json'`,
  `cat x >'.claude/settings.json'`,
];
const BASH_ALLOWED = [
  "cat .claude/settings.json",
  "cat .claude/settings.local.json | grep allow",
  "cat .claude/settings.json > /tmp/copy.json",
  "ls .claude/hooks",
  "ls -la .claude",
  "grep -n allow .claude/settings.local.json",
  "grep -rn 'settings.local.json' docs/",
  "head -5 .claude/settings.json",
  "tail -n 3 .claude/hooks/x.sh",
  "wc -l .claude/settings.json",
  "jq .permissions .claude/settings.json",
  "diff .claude/settings.json /tmp/x",
  "git diff -- .claude/settings.json",
  "git show HEAD:.claude/settings.json",
  "git log --oneline -- .claude/hooks",
  "git status --short .claude/settings.local.json",
  "echo x >> docs/y.md",
  `echo "a > .claude/settings.json"`,
  `gh pr create --title t --body "see .claude/settings.local.json"`,
  `f1rm report DONE x "changed settings.local.json"`,
  "f1rm report DONE settings.local.json",
  "cat docs/settings.json",
  "cat 'a > b' .claude/settings.json",
  "echo hello",
  "git status",
];

test("every company role, and every sub-agent of one, is refused a Bash that names a settings or hooks file unless it only reads; the user's own session runs it", async () => {
  const { bash } = await gateOffice();
  for (const [id, extra] of COMPANY) {
    for (const command of BASH_REFUSED) {
      const out = await bash(id, command, extra);
      expect([label(id, extra), command, out?.permissionDecision]).toEqual([label(id, extra), command, "deny"]);
      expect(out.permissionDecisionReason).toContain("Only the user changes Claude Code permissions");
    }
  }
  for (const [id, extra] of [["d", {}], ["v", {}], ["d", { agent_id: "a3", agent_type: "Explore" }]] as const) {
    for (const command of BASH_ALLOWED) expect([label(id, extra), command, await bash(id, command, extra)]).toEqual([label(id, extra), command, null]);
  }
  for (const command of BASH_REFUSED) expect([command, await bash("f", command)]).toEqual([command, null]);
});

test("a session never widens a hire's permissions: f1rm hire and f1rm wake with a permission flag, in any spelling, are refused for the PM and a lead", async () => {
  const { bash } = await gateOffice();
  const flags = ["--settings '{}'", "--settings={}", "--permission-mode acceptEdits", "--permission-mode=bypassPermissions", "--dangerously-skip-permissions", "--allowedTools Bash", "--allowed-tools=Bash", "--allowedTools=Bash", `--allowed""Tools Bash`, `'--settings' '{}'`, `\\--dangerously-skip-permissions`, `"--permission-mode" auto`];
  const calls: [string, (flag: string) => string][] = [
    ["p", (f) => `f1rm hire ${f} lead lead-checkout checkout b`],
    ["p", (f) => `f1rm wake lead-checkout ${f}`],
    ["l", (f) => `f1rm hire --team checkout ${f} backend-dev checkout.backend-dev-a a b`],
    ["l", (f) => `f1rm wake checkout.backend-dev-a ${f}`],
  ];
  for (const [id, call] of calls) {
    expect([id, call(""), await bash(id, call(""))]).toEqual([id, call(""), null]);
    for (const flag of flags) {
      const out = await bash(id, call(flag));
      expect([id, call(flag), out?.permissionDecision]).toEqual([id, call(flag), "deny"]);
      expect(out.permissionDecisionReason).toContain("A session never widens a hire's permissions");
    }
  }
  // the words in a brief are prose, and the user's own session runs anything
  expect(await bash("p", "f1rm hire lead lead-checkout checkout 'never pass --settings or --permission-mode'")).toBeNull();
  expect(await bash("f", "f1rm hire --settings '{}' lead lead-checkout checkout b")).toBeNull();
});

// The answer-route rule reads command text: a line that names the office (here its saved link) and has `commands/` in any path is refused, even a harmless `ls .claude/commands/x`.
// A known limit of that rule (it cannot tell a route from a folder of that name); the user's own `!` runs it, and a line that does not name the office passes.
test("the answer-route rule refuses a line that names the office and a commands/ path, and only then", async () => {
  const { bash } = await gateOffice();
  expect((await bash("d", "cat ~/.f1rm/office-url; ls .claude/commands/x"))?.permissionDecision).toBe("deny");
  expect(await bash("d", "ls .claude/commands/x")).toBeNull();
  expect(await bash("d", "cat ~/.f1rm/office-url")).toBeNull();
});

// Git calls that only name a settings file in a message or as a path to add or commit: not the settings gate's to refuse (an implementer commits in its own worktree; `f1rm merge` stops such a file reaching main).
// The other gates may still judge them (a commit in the main checkout is refused as landing), so only the settings refusal is asserted away.
test("a git call that only names a settings file in a message, or adds or commits it, is not refused as a settings write", async () => {
  const { bash } = await gateOffice();
  for (const command of [`git commit -m "docs: .claude/settings.json"`, `git commit -q -m 'mention settings.local.json and .claude/hooks'`, "git add .claude/settings.local.json", "git commit -m x -- .claude/settings.json", `git log --grep ".claude/settings.json"`]) {
    for (const [id, extra] of [["d", {}], ["l", {}], ["d", { agent_id: "a3", agent_type: "Explore" }]] as const) {
      const out = await bash(id, command, extra);
      expect([label(id, extra), command, String(out?.permissionDecisionReason ?? "")]).toEqual([label(id, extra), command, expect.not.stringContaining("Claude Code permissions")]);
    }
  }
});

test("a heredoc body that merely talks about the files is data, not a write target", async () => {
  const { bash } = await gateOffice();
  expect(await bash("d", "cat <<'EOF'\nthe user edits .claude/settings.local.json\nEOF")).toBeNull();
  expect((await bash("d", "cat <<'EOF' > .claude/settings.local.json\n{}\nEOF"))?.permissionDecision).toBe("deny");
});

