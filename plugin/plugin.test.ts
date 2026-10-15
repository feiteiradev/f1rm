// The company plugin as shipped: role files, the guidelines skill, and a real `claude` install into a throwaway config.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const PLUGIN = import.meta.dir;
const REPO = join(PLUGIN, "..");

const GUIDELINES = "f1rm:f1rm-guidelines";
// research and security-review are slash commands, not Skill-tool skills, so no role lists them.
const ROLES: Record<string, string[]> = {
  pm: ["mattpocock-skills:grilling", GUIDELINES],
  designer: ["design-pipeline"],
  "frontend-dev": ["mattpocock-skills:tdd"],
  "backend-dev": ["mattpocock-skills:tdd"],
  reviewer: ["code-review", GUIDELINES],
  researcher: [],
};
const SLASH_ONLY = ["research", "security-review"];

function parts(file: string) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file}: no frontmatter`);
  return { fm: Bun.YAML.parse(m[1]) as Record<string, any>, body: m[2] };
}
const role = (name: string) => parts(join(PLUGIN, "agents", `${name}.md`));
const guidelines = readFileSync(join(PLUGIN, "skills", "f1rm-guidelines", "SKILL.md"), "utf8");
const section = (heading: string) => guidelines.split(/^## /m).find((s) => s.startsWith(heading + "\n")) ?? "";

test("the plugin ships exactly the six roles", () => {
  expect(readdirSync(join(PLUGIN, "agents")).sort()).toEqual(Object.keys(ROLES).map((r) => `${r}.md`).sort());
});

test.each(Object.entries(ROLES))("%s declares its skills, user memory, tools and model", (name, skills) => {
  const { fm } = role(name);
  expect(fm.name).toBe(name);
  expect(fm.skills ?? []).toEqual(skills);
  expect(fm.memory).toBe("user");
  expect(fm.model).toMatch(/^(opus|sonnet|haiku)$/);
  expect(String(fm.tools).split(/,\s*/)).toContain("SendMessage");
  expect(String(fm.description).length).toBeLessThan(160); // every session pays for it
});

test.each(Object.keys(ROLES))("%s prompt is about the work, with no persona", (name) => {
  const { body } = role(name);
  expect(body).not.toMatch(/\b(you are|act as|pretend|persona|imagine you|your name)\b/i);
  expect(body).toStartWith("\nRole: ");
});

test("the PM interviews before it plans, and only the Reviewer merges and never pushes", () => {
  const pm = role("pm");
  expect(pm.body).toMatch(/Make no plan, board entry or hire before that confirmation/);
  expect(pm.body).toContain("f1rm hire");
  const reviewer = role("reviewer");
  expect(reviewer.fm.disallowedTools).toBeUndefined(); // a Bash(...) deny removes the whole Bash tool
  expect(reviewer.body).toContain("Never push");
});

test("the guidelines cover every item the spec lists", () => {
  for (const h of [
    "Roster and hiring playbook",
    "Brief format",
    "Handoff via SendMessage",
    "Board format",
    "Review and merge flow",
    "Cap rule",
    "Definition of done",
  ]) {
    expect(section(h).trim().length).toBeGreaterThan(100);
  }
  expect(section("Handoff via SendMessage")).toContain("commits on the hire's worktree branch");
  expect(section("Review and merge flow")).toContain("Never run `git push`");
  expect(section("Review and merge flow")).toContain("--ff-only");
  expect(section("Cap rule")).toContain("**4 hired employees working at once**");
  expect(section("Cap rule")).toMatch(/override flag.*only after the user has approved/s);
  expect(section("Definition of done")).toContain("Reviewer has signed off");
});

test("the roster table names each hireable role with the commands `f1rm hire` loads", () => {
  const slash: Record<string, string[]> = { reviewer: ["security-review"], researcher: ["research"] };
  const rows = [...section("Roster and hiring playbook").matchAll(/^\| `(\S+)` \| .*? \| (.+?) \|$/gm)];
  expect(rows.map((r) => r[1])).toEqual(Object.keys(ROLES));
  for (const [, name, cell] of rows) {
    const listed = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The PM is never hired, so its row lists only what `f1rm pm` loads.
    const skills = name === "pm" ? ROLES[name].filter((s) => s !== GUIDELINES) : ROLES[name];
    expect(listed.sort()).toEqual([...skills, ...(slash[name] ?? [])].sort());
  }
});

test("research and security-review are slash commands: briefs start with them, no role invokes them as skills", () => {
  const playbook = section("Roster and hiring playbook");
  for (const c of SLASH_ONLY) {
    expect(playbook).toContain(`\`/${c}\``);
    for (const r of Object.keys(ROLES)) {
      expect(role(r).fm.skills ?? []).not.toContain(c);
      expect(role(r).body).not.toMatch(new RegExp(`${c} skill`, "i"));
    }
  }
  expect(playbook).toMatch(/brief of a hire starts with/i);
});

test("a hire reports to the PM's name, which f1rm pm sets and the PM passes on", () => {
  const brief = section("Brief format");
  expect(brief).toContain("--name pm-<repo basename>");
  expect(brief).toContain("ListAgents");
  expect(role("pm").body).toContain("ListAgents");
  expect(String(role("pm").fm.tools).split(/,\s*/)).toContain("ListAgents");
});

test("the board example follows the board format the guidelines state", () => {
  const board = /```\n(# Board:[\s\S]*?)```/.exec(section("Board format"))![1];
  const rows = board.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  expect(rows[0]).toEqual(["id", "owner", "status", "branch", "task"]);
  for (const [id, , status] of rows.slice(2)) {
    expect(id).toMatch(/^T\d+$/);
    expect(status).toMatch(/^(todo|doing|review|done|blocked)$/);
  }
});

// Throwaway HOME and CLAUDE_CONFIG_DIR: nothing here can reach the real Claude Code config.
function sandboxedClaude() {
  const home = mkdtempSync(join(tmpdir(), "f1rm-plugin-"));
  const env = { ...claudeEnv(), HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  return (...args: string[]) => {
    const r = Bun.spawnSync(["claude", ...args], { env, cwd: REPO });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
}
const hasClaude = !!Bun.which("claude");

test.skipIf(!hasClaude)("the plugin and its marketplace validate", () => {
  const claude = sandboxedClaude();
  expect(claude("plugin", "validate", PLUGIN).code).toBe(0);
  expect(claude("plugin", "validate", REPO).code).toBe(0);
});

test.skipIf(!hasClaude)("the plugin installs from the repo's marketplace into a fresh config", () => {
  const claude = sandboxedClaude();
  expect(claude("plugin", "marketplace", "add", REPO).code).toBe(0);
  expect(claude("plugin", "install", "f1rm@f1rm").code).toBe(0);
  const details = claude("plugin", "details", "f1rm@f1rm");
  expect(details.code).toBe(0);
  expect(/Skills \(\d+\)\s+(.*)/.exec(details.out)?.[1].split(", ").sort()).toEqual(["f1rm-guidelines", "hire"]);
  expect(details.out).toMatch(/Agents \(6\)\s+\S/);
  for (const name of Object.keys(ROLES)) expect(details.out).toContain(name);
});

/** The tools a role's session starts with, from the init event. A bad model id stops the session before any API call, so this costs nothing. */
function initTools(name: string): string[] {
  const out = sandboxedClaude()("-p", "--plugin-dir", PLUGIN, "--agent", `f1rm:${name}`, "--model", "claude-nonexistent-x", "--output-format", "stream-json", "--verbose", "x").out;
  const init = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((e) => e.type === "system" && e.subtype === "init");
  return init.tools;
}

// A deny rule such as Bash(...) in `disallowedTools` removes the whole Bash tool, so only the init event shows what a role really has.
test.skipIf(!hasClaude)("the Reviewer's session has Bash, so it can diff, merge and run checks", () => {
  expect(initTools("reviewer")).toContain("Bash");
});

test.skipIf(!hasClaude)("the PM's session can list its hires", () => {
  expect(initTools("pm")).toContain("ListAgents");
});

test("the playbook gives the real `f1rm hire` syntax, and the override only after user approval", () => {
  const playbook = section("Roster and hiring playbook");
  expect(playbook).toContain('f1rm hire <role> <name> <task> "<brief>"');
  expect(playbook).not.toContain("--help");
  expect(section("Cap rule")).toContain("f1rm hire --override");
  expect(section("Brief format")).not.toMatch(/^Report to:/m);
});
