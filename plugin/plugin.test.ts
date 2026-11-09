// The company plugin as shipped: role files, the guidelines skill, and a real `claude` install into a throwaway config.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const PLUGIN = import.meta.dir;
const REPO = join(PLUGIN, "..");

const GUIDELINES = "f1rm:f1rm-guidelines";
// research and security-review are slash commands: `f1rm hire --skills` or `--level high` brings them in, so no role lists them.
const ROLES: Record<string, string[]> = {
  pm: [],
  designer: ["design-pipeline"],
  researcher: ["mattpocock-skills:research"],
  advisor: ["mattpocock-skills:domain-modeling", "mattpocock-skills:research"],
  "fresh-eyes": [],
  marketer: ["cro", "anthropic-skills:content-creator", "brandkit"],
  "seo-specialist": ["seo-audit", "ai-seo"],
  "social-media": ["social", "content-calendar-sms", "anthropic-skills:fabrica", "hook-writer-sms", "carousel-writer-sms"],
  sales: ["anthropic-skills:6-first-customers-acquisition-plan", "anthropic-skills:7-fast-revenue-strategy"],
  strategist: ["anthropic-skills:1-startup-idea-validator", "anthropic-skills:2-profitable-niche-finder", "anthropic-skills:3-customer-pain-point-researcher", "anthropic-skills:4-lean-startup-business-plan-builder"],
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

test("the plugin ships exactly the thirteen roles and the office step", () => {
  expect(readdirSync(join(PLUGIN, "agents")).sort()).toEqual([...Object.keys(ROLES), "step"].map((r) => `${r}.md`).sort());
});

test("the PM runs on sonnet: coordination is cheap, and its effort is medium", () => {
  expect(role("pm").fm.model).toBe("sonnet");
});

test.each(Object.entries(ROLES).filter(([name]) => name !== "pm"))("%s declares its skills, user memory, tools and model", (name, skills) => {
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

// The skills the Workflows section names for each role, beyond its `skills:` list.
const WORKFLOW_SKILLS: Record<string, string[]> = {
  "frontend-dev": ["run", "design-pipeline"],
  "backend-dev": ["mattpocock-skills:diagnosing-bugs"],
  researcher: ["research"],
};
// A Reviewer is hired with --content, which drops the code-review skills its role file lists.
const WORKFLOW_ROLE_SKILLS = (r: string) => (r === "reviewer" ? [GUIDELINES] : ROLES[r]);
const bare = (skill: string) => skill.split(":").pop()!;

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
  expect(/Skills \(\d+\)\s+(.*)/.exec(details.out)?.[1].split(", ").sort()).toEqual(["f1rm-guidelines", "resume-all", "stop-all"]);
  expect(details.out).toMatch(/Agents \(11\)\s+\S/);
  for (const name of Object.keys(ROLES)) expect(details.out).toContain(name);
});

/** The tools a role's session starts with, from the init event. A bad model id stops the session before any API call, so this costs nothing. */
function initTools(name: string): string[] {
  const out = sandboxedClaude()("-p", "--plugin-dir", PLUGIN, "--agent", `f1rm:${name}`, "--model", "claude-nonexistent-x", "--output-format", "stream-json", "--verbose", "x").out;
  const init = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((e) => e.type === "system" && e.subtype === "init");
  return init.tools;
}

// A deny rule such as Bash(...) in `disallowedTools` removes the whole Bash tool, so only the init event shows what a role really has.


test("a step has the advisor test a high-risk decision against the why before it opens the ticket, and a STRAINS or BREAKS verdict makes the recommendation no default", () => {
  const rule = section("Decision tickets").split("\n").find((l) => l.includes("**Advisor.**")) ?? "";
  for (const s of ["high-risk decision ticket", "a product, design or business choice", "`agents/advisor.md`", "`test` task", "word for word", "STRAINS or BREAKS", "never a default"]) expect(rule, s).toContain(s);
  expect(rule).not.toMatch(/feit|Pedro/);
  const step = role("step").body;
  for (const s of ["agents/advisor.md", "`test` task", "word for word", "STRAINS or BREAKS"]) expect(step, s).toContain(s);
  expect(role("advisor").body).not.toContain("unless the brief asks for a `docs/decisions.md` entry"); // it commits nothing
  const advisor = role("advisor");
  expect(String(advisor.fm.tools).split(/,\s*/)).not.toContain("Edit"); // it changes no file of the repo
  for (const s of ["`why`", "`test`", "~/.f1rm/kept/<repo>/advisor/why.md", "~/.f1rm/kept/<repo>/advisor/ledger.md", "FITS | STRAINS | BREAKS", "Never hire or start a session"]) expect(advisor.body, s).toContain(s);
  expect(advisor.body).not.toMatch(/feit|Pedro|Hired by the PM/);
});

const SPECIALISTS = ["designer", "frontend-dev", "backend-dev", "researcher", "advisor", "marketer", "seo-specialist", "social-media", "sales", "strategist"];
const cliSource = () => readFileSync(join(REPO, "office", "cli", "f1rm.ts"), "utf8");
const pmPromptText = () => /const pmPrompt[\s\S]*?`;/.exec(cliSource())![0];

// R8b: the PM picks the workflow by rule, the user talks to each lead, PLAN and GO are gone, and two tables carry what the gate enforces.
const WORKFLOW_FILES = () => ({
  guidelines,
  prompt: pmPromptText(),
  "plugin README": readFileSync(join(PLUGIN, "README.md"), "utf8"),
  README: readFileSync(join(REPO, "README.md"), "utf8"),
  hire: readFileSync(join(REPO, "office", "cli", "hire.ts"), "utf8"),
  ...Object.fromEntries(Object.keys(ROLES).map((r) => [`${r}.md`, role(r).body])),
});

test("R8b: docs/decisions.md has the entries PM picks the workflow and Who talks to whom", () => {
  const titles = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1).map((e) => e.split("\n")[0]);
  for (const t of ["PM picks the workflow", "Who talks to whom"]) expect(titles).toContain(`2026-10-22 ${t}`);
});

test.each(["designer", "researcher", "marketer", "seo-specialist", "social-media", "sales", "strategist"])("%s adds its decisions.md entries in its own commit", (name) => {
  const { body } = role(name);
  const core = "a feature or behaviour the user chose; a refactor or architecture choice; a cap, limit, dependency or version change; anything rejected for a reason";
  expect(section("Docs in each repo")).toContain("a feature or behaviour the user chose, a refactor or architecture choice, a cap, limit, dependency or version change, anything rejected for a reason");
  for (const s of ["add every `docs/decisions.md` entry the brief asks for in your own commit. Also add one for any core decision you made that the brief didn't fix", core, "`## <YYYY-MM-DD> <title>`", "`- Decision:`, `- Why:`, `- Rejected:`, `- Where:`", "`docs/adr/`"]) expect(body, s).toContain(s);
});

test("docs/decisions.md holds the seeded entries, oldest first, each with its four lines", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  // The log grows: later entries follow the seeded ones, and get the same four-line check below.
  const titles = entries.map((e) => e.split("\n")[0]);
  expect(titles.slice(0, 6)).toEqual([
    "2026-10-14 Founding decisions",
    "2026-10-19 Plugin 0.2.0 drops the /f1rm skill from cached installs",
    "2026-10-19 Machine cap on working background sessions is 30",
    "2026-10-19 A bare f1rm fails like f1rm start when the office doesn't start",
    "2026-10-19 Milestones outside the repo, decisions inside it",
    "2026-10-19 Plugin 0.3.0",
  ]);
  // The rules-prose entries, in order, wherever other tasks' entries sit between them.
  const mine = ["PM hires only leads", "Leads filter team traffic", "Reviewer conflict and tip rules", "Only the user pushes", "Milestone cleanup", "Plugin 0.4.0", "Reviewer sends back every finding"].map((t) => titles.indexOf(`2026-10-20 ${t}`));
  expect(mine.every((i) => i >= 6)).toBe(true);
  expect(mine).toEqual([...mine].sort((x, y) => x - y));
  expect(titles).toContain("2026-10-21 Idle members free their team slot");
  for (const t of ["Projects are isolated", "Decisions log merges by union", "Project notes live outside memory"]) expect(titles).toContain(`2026-10-21 ${t}`);
  for (const t of ["The skill gate arms on the first prompt only", "A refused skill counts as tried"]) expect(titles).toContain(`2026-10-22 ${t}`);
  expect(entries.find((e) => e.startsWith("2026-10-22 A refused skill counts as tried"))).toContain("`security-review` is never taken from a try");
  // An entry a later one overrides may end with one `- Superseded:` line; its other lines stay as written.
  for (const e of entries) expect(e.split("\n").filter((l) => l.trim()).slice(1).filter((l) => !l.startsWith("- Superseded: ")).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

const LEAN_ENTRY = "2026-10-23 Lean review and test runs";
const NON_BLOCKING = "Non-blocking (for the batch task)";

test("the decisions log holds the lean review entry, and the entries it supersedes say so", () => {
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  const entries = log.split(/^## /m).slice(1);
  const lean = entries.filter((e) => e.startsWith(LEAN_ENTRY));
  expect(lean).toHaveLength(1);
  expect(lean[0]).toMatch(/- Where: .*lean-review/);
  for (const e of ["2026-10-20 Reviewer sends back every finding", "2026-10-20 Leads filter team traffic"]) {
    const entry = entries.find((x) => x.startsWith(e)) ?? "";
    expect(entry, e).toContain('\n- Superseded: by "Lean review and test runs" (2026-10-23).');
  }
});

// Self-driving teams: the PM watches its leads and each lead its hires with `f1rm status --watch`, and wakes or replaces the ones that stopped.
test("K6: docs/decisions.md has the Ask the user only for big decisions and Skill stack entries, the second recording why pstack skills are slash-only", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const titles = entries.map((e) => e.split("\n")[0]);
  for (const t of ["Ask the user only for big decisions", "Skill stack: mattpocock + pstack"]) expect(titles).toContain(`2026-10-21 ${t}`);
  const stack = entries.find((e) => e.startsWith("2026-10-21 Skill stack: mattpocock + pstack"))!;
  for (const s of ["disable-model-invocation", "architect", "interrogate", "arena", "swarm", "Opening a PR", "afk"]) expect(stack, s).toContain(s);
});

// R9a: `f1rm wake` resumes an ended hire in place; the gate says so when a message goes to one with no live process.
test("W4: docs/decisions.md has the entries f1rm wake and A message to a hire with no live process says so", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const wake = entries.find((e) => e.startsWith("2026-10-22 f1rm wake\n"))!;
  const gate = entries.find((e) => e.startsWith("2026-10-22 A message to a hire with no live process says so\n"))!;
  for (const s of ["claude --bg --resume <session-id> --agent f1rm:<role> --name <name>", "same cap code", "was let go; hire a new one", "is live: message it instead", "claude attach"]) expect(wake, s).toContain(s);
  for (const s of ["no live session; f1rm wake <name>", "name [ref]", "unknown to the office", "root cause"]) expect(gate, s).toContain(s);
  for (const e of [wake, gate]) expect(e.split("\n").filter((l) => l.trim()).slice(1).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

test("R10a: docs/decisions.md has the entries Permissions are answered in the office and The office tags a lead that waits on the user", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const answered = entries.find((e) => e.startsWith("2026-10-23 Permissions are answered in the office\n"))!;
  const tags = entries.find((e) => e.startsWith("2026-10-23 The office tags a lead that waits on the user\n"))!;
  for (const s of ["1800", "updatedPermissions", ".claude/settings.local.json", "canAlways", "exit code 2", "approve <name>'s request in the office", "exactly the allow rules Claude Code itself suggested", "The gate is advisory: it reads the command text"]) expect(answered, s).toContain(s);
  for (const s of ["needsYou", "Open question for the user", "push message", "the last `## Open question for the user` heading"]) expect(tags, s).toContain(s);
  expect(tags).not.toContain("on the same line");
  for (const e of [answered, tags]) expect(e.split("\n").filter((l) => l.trim()).slice(1).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

test("honest status: the log has The office tells the truth, and the README says when someone shows as working", () => {
  const entry = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).find((e) => e.startsWith("2026-10-23 The office tells the truth\n"))!;
  for (const s of ["last 90 seconds", "busy", "HOT_MS", "#75092", "#80100", "trusting the last hook event alone", "the listing's `state` field"]) expect(entry, s).toContain(s);
  expect(entry.split("\n").filter((l) => l.trim()).slice(1).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
  expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain("one of their hook events came in the last 90 seconds");
});

// F3c: the text describes the flat workflow that `f1rm hire --simple`, `f1rm merge` and the owner sub-agent gate put in code.
const pluginReadme = () => readFileSync(join(PLUGIN, "README.md"), "utf8");

// no-user-commands: no session hands the user a command or asks him outside the five things that are his.
const commandFree = () => ({
  guidelines,
  README: readFileSync(join(REPO, "README.md"), "utf8"),
  "plugin README": pluginReadme(),
  "PM prompt": pmPromptText(),
  ...Object.fromEntries(Object.keys(ROLES).map((r) => [`${r}.md`, role(r).body])),
});

// Stop all and resume all: two slash commands only the user types. The Skill tool refuses a skill with `disable-model-invocation` (probed live on Claude Code 2.1.312), and a `!` block of a slash command runs
// with no PreToolUse hook, so the office's gate (which refuses a session's own `--all`) is not in the way of the user's command and never lets a model's.
const COMMANDS: Record<string, string> = { "stop-all": "f1rm pause --all", "resume-all": "f1rm resume --all" };

test("stop-all and resume-all are skills only the user can run, each running exactly its --all command in one pre-executed line", () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    const { fm, body } = parts(join(PLUGIN, "skills", name, "SKILL.md"));
    expect(fm.name).toBe(name);
    expect(fm["disable-model-invocation"]).toBe(true);
    expect(typeof fm.description === "string" && fm.description.length > 20).toBe(true);
    expect(fm["allowed-tools"]).toBe(`Bash(${command})`); // without it the pre-executed line waits for an approval and the invocation ends
    expect(body.split("\n").filter((l) => l.startsWith("!"))).toEqual([`!\`${command}\``]);
    expect(body).not.toContain("$ARGUMENTS");
  }
  expect(parts(join(PLUGIN, "skills", "stop-all", "SKILL.md")).fm.description).toContain("Pauses every registered project");
  expect(parts(join(PLUGIN, "skills", "resume-all", "SKILL.md")).fm.description).toContain("Resumes every paused project");
});

test("docs/decisions.md has the Stop all and resume all entry with the mechanism and what it rejected", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const entry = entries.find((e) => e.startsWith("2026-11-02 Stop all and resume all in three places\n")) ?? "";
  for (const s of ["- Decision:", "- Why:", "- Rejected:", "- Where:", "disable-model-invocation", "no hook", "whose prompt text matches", "best-effort text matching", "USAGE and the README row", "a HOME prefix included", "allowed-tools", "f1rm wake", "lid", "nothing resumes by itself"]) expect(entry, s).toContain(s);
});

test("topic-prose: docs/decisions.md has the four topic entries", () => {
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  for (const t of ["Topics run by leads; the PM is a scribe", "Preview before building visible work", "First slice shown without waiting", "Visible tasks land with proof from the running app"]) expect(log).toContain(`## 2026-11-03 ${t}\n`);
});

describe("usage pacing and docker rules", () => {
  const usage = section("Usage pacing and Docker");
  test("docs/decisions.md has the two usage entries", () => {
    const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
    for (const t of ["Pace on the official usage windows", "Tag and tear down each task's Docker stack"]) expect(log).toContain(`## 2026-11-03 ${t}\n`);
  });
});

describe("sdd borrow rules", () => {
  const teamsItem = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(section("Teams"))?.[0] ?? "";
  const leadStep = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(role("lead").body)?.[0] ?? "";
  test("f1rm's CLAUDE.md names the guidelines and the README as its living spec", () => {
    const claude = readFileSync(join(REPO, "CLAUDE.md"), "utf8").split(/^### /m).find((s) => s.startsWith("Living spec\n")) ?? "";
    for (const s of ["`plugin/skills/f1rm-guidelines/SKILL.md` (the company rules)", "`README.md` (the office)"]) expect(claude, s).toContain(s);
  });
  test("docs/decisions.md has the three sdd entries", () => {
    const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m);
    for (const t of ["Living spec per project", "Size gate for small tasks", "Converge a topic once at close"]) {
      const entry = entries.find((e) => e.startsWith(`2026-11-05 ${t}\n`)) ?? "";
      for (const s of ["- Decision:", "- Why:", "- Rejected:", "- Where: sdd-rules (plugin/skills/f1rm-guidelines/SKILL.md, plugin/agents/lead.md"]) expect(entry, `${t}: ${s}`).toContain(s);
    }
    const rejected = entries.filter((e) => e.startsWith("2026-11-05 ")).join("");
    for (const s of ["constitution file", "per-change folder", "loop until converged"]) expect(rejected, s).toContain(s);
  });
});

// rules-text (2026-11-05): no spawn caps, and the PM starts a topic lead whenever the user asks, then tells him only when it needs him.
describe("no spawn caps, and the PM starts leads on request", () => {
  const REMOVED = ["8 background sessions", "8 working sessions", "8 sessions on the machine", "**2 teams**", "2 teams per project", "2 teams,", "2 working in a team", "2 working per team", "at most 2 interns", "at most 2 sub-agents", "at most 2 implementers", "at most two sub-agents", "at most 2 at a time", "its 2 sub-agents", "up to two teams", "one or two teams", "one or two live", "At most 2 topics live", "cap of 8", "cap of 2", "a third waits for a slot", "one team per project", "1 team per project"];
  const teamsItem = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(section("Teams"))?.[0] ?? "";
  test("the guidelines state none of the removed caps or the one-team rule", () => {
    for (const s of REMOVED) expect(guidelines.toLowerCase(), s).not.toContain(s.toLowerCase());
  });
  test("docs/decisions.md has the entries No spawn caps and The PM starts leads on request", () => {
    const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m);
    const caps = entries.find((e) => e.startsWith("2026-11-05 No spawn caps\n")) ?? "";
    for (const s of ["- Decision:", "- Why:", "- Rejected: higher caps; dropping the usage holds", "- Where: no-caps-code 3500ab6, drop-one-team, rules-text", "Kept: one specialist per task", "usage holds"]) expect(caps, s).toContain(s);
    const pm = entries.find((e) => e.startsWith("2026-11-05 The PM starts leads on request\n")) ?? "";
    for (const s of ["- Decision:", "f1rm hire --topic", "The PM starts only leads", "still watches and wakes its leads", "its other unprompted items stay", "- Why:", "- Rejected:", "relays the lead's questions and answers", "New topic button as the only way", "- Where: rules-text"]) expect(pm, s).toContain(s);
  });
});

test("a ticket's role label picks its intern's skills from the role files: the designer, the researcher and the five Founder roles", async () => {
  const { roleSkills } = await import("../office/server/scheduler.ts");
  expect(roleSkills(false)).toEqual({ designer: ROLES.designer, researcher: ROLES.researcher });
  expect(roleSkills(true)).toEqual({
    designer: ROLES.designer,
    researcher: ROLES.researcher,
    marketer: ROLES.marketer,
    "seo-specialist": ROLES["seo-specialist"],
    "social-media": ROLES["social-media"],
    sales: ROLES.sales,
    strategist: ROLES.strategist,
  });
});

test("the PM interviews the user, publishes the spec and stops: no rules preloaded, no messages, no hires, no board", () => {
  const { fm, body } = role("pm");
  expect(fm.model).toBe("sonnet");
  expect(fm.skills).toBeUndefined();
  expect(String(fm.tools).split(/,\s*/)).toEqual(["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Skill"]);
  for (const s of ["`CLAUDE.md`, `AGENTS.md`, `docs/agents/`", "--body-file"]) expect(body, s).toContain(s);
  for (const s of ["setup-matt-pocock-skills", "`mattpocock-skills:grilling`", "`mattpocock-skills:domain-modeling`", "`to-spec`", "`ready-for-agent`", "A small ask", "gets none of 2 to 4", "and stop."]) expect(body, s).toContain(s);
  for (const s of ["f1rm hire", "board", "f1rm push", "letgo", "milestone", "lead"]) expect(body, s).not.toContain(s);
  expect(pmPromptText()).toContain("publish it as a spec");
  expect(pmPromptText()).not.toMatch(/board|f1rm hire|\blead|guidelines/);
});

test("the rules file is short and says the flow, the steps, decision tickets, roles, cost, the gates, editions and the repo docs, with no lead, board or message between sessions", () => {
  expect(readFileSync(join(PLUGIN, "skills", "f1rm-guidelines", "SKILL.md")).length).toBeLessThanOrEqual(16 * 1024);
  for (const h of ["The flow", "Steps", "Decision tickets", "Roles", "Cost and budgets", "What the gates enforce", "Editions and drafts", "Docs in each repo", "Docker"]) expect(section(h), h).not.toBe("");
  for (const s of ["/mattpocock-skills:to-tickets", "/mattpocock-skills:implement-spec", "f1rm merge spec-<n>", "`f1rm push`", "`needs-decision`", "4 hours", "Nobody hires", "only its own interns", "`docs/spec.md`", "`docs/decisions.md`"]) expect(guidelines, s).toContain(s);
  expect(guidelines).not.toMatch(/\blead\b|\bboards?\b|SendMessage/i);
});

test("the four retired role files are gone, the plugin is 0.10.0, and the label vocabulary lists the decision, role and size labels", () => {
  for (const r of ["lead", "frontend-dev", "backend-dev", "reviewer"]) expect(existsSync(join(PLUGIN, "agents", `${r}.md`)), r).toBe(false);
  expect(JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.10.0");
  const labels = readFileSync(join(REPO, "docs", "agents", "triage-labels.md"), "utf8");
  for (const s of ["`needs-decision`", "`role:<name>`", "`size:s`"]) expect(labels, s).toContain(s);
});

test("both READMEs describe the new flow: no lead, board, topic or message between sessions, and nobody in the company hires", () => {
  for (const [name, text] of [["README", readFileSync(join(REPO, "README.md"), "utf8")], ["plugin README", pluginReadme()]] as const) {
    expect(text, name).not.toMatch(/\blead\b|\bleads\b|\bboards?\b|\btopics?\b|SendMessage/i);
    expect(text, name).toContain("spec");
  }
  expect(pluginReadme()).toContain("Nobody hires and no session messages another");
});

test("the PM ends on examples the user confirms and a prototype they accept, and publishes the ask verbatim", () => {
  const pm = role("pm").body;
  for (const s of ["3 to 5 numbered examples", "Wait for the user to confirm", "`prototype` skill", "`design-pipeline`", "never a rebuilt copy", "\"accept\"", "## Ask", "verbatim", "## Examples", "in place of the skill's `## User Stories`", "--attach", "Done = you see Y."]) expect(pm, s).toContain(s);
});

test("fresh-eyes reads only the ask, the examples, the tickets and their files on main, and ends on its count of surprises", () => {
  const { fm, body } = role("fresh-eyes");
  expect(String(fm.tools).split(/,\s*/)).not.toContain("Edit");
  expect(String(fm.tools).split(/,\s*/)).not.toContain("Write");
  for (const s of ["## Ask", "## Examples", "Boundary:", "Read nothing else", "Mermaid", "path:line", "none, unasked", "contradicts example N", "SURPRISES: <n>"]) expect(body, s).toContain(s);
  expect(role("step").body).toContain("the user's comments on the spec since this step last started");
});
