// The company plugin as shipped: role files, the guidelines skill, and a real `claude` install into a throwaway config.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const PLUGIN = import.meta.dir;
const REPO = join(PLUGIN, "..");

const GUIDELINES = "f1rm:f1rm-guidelines";
// research and security-review are slash commands: `f1rm hire --skills` or `--level high` brings them in, so no role lists them.
const ROLES: Record<string, string[]> = {
  pm: ["mattpocock-skills:grilling", GUIDELINES],
  lead: [GUIDELINES, "f1rm:hire"],
  designer: ["design-pipeline"],
  "frontend-dev": ["pstack:poteto-mode", "mattpocock-skills:tdd"],
  "backend-dev": ["pstack:poteto-mode", "mattpocock-skills:tdd"],
  reviewer: ["code-review", GUIDELINES, "ponytail:ponytail-review", "mattpocock-skills:code-review"],
  researcher: ["mattpocock-skills:research"],
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

test("the plugin ships exactly the twelve roles", () => {
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

test("the Reviewer merges in a scratch worktree, fast-forwards the main checkout, and approves only once main has moved", () => {
  const flow = section("Review and merge flow");
  expect(flow).toContain("git worktree add --detach .claude/worktrees/review-<task> <base>");
  expect(flow).toContain("git merge --no-ff <branch>");
  expect(flow).toContain("git merge --ff-only <merge sha>");
  expect(flow).toContain("git worktree remove");
  expect(flow).not.toContain("reset --hard");
  expect(role("reviewer").body).not.toContain("reset --hard");
  expect(flow.indexOf("--ff-only")).toBeLessThan(flow.indexOf("`APPROVED`"));
  expect(flow).toMatch(/only after main has moved/);
  expect(role("reviewer").body).toContain("scratch worktree");
  expect(role("reviewer").body).toContain("--ff-only");
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
  expect(section("Cap rule")).toContain("**30 background sessions working at once**");
  expect(section("Cap rule")).toMatch(/override flag.*only after the user has approved/s);
  expect(section("Definition of done")).toContain("Reviewer has signed off");
});

test("the guidelines run teams: when to form them, the team brief, PLAN/GO/DONE, who talks to whom, the caps, interns, team boards and installed skills", () => {
  for (const h of ["Teams", "Team brief", "Who talks to whom", "Interns", "Use what is installed"]) expect(section(h).trim().length).toBeGreaterThan(100);
  const teams = section("Teams");
  for (const s of ["Every milestone runs through one or two teams", "At most 2 teams", "hires only leads", "No nested teams", "`PLAN <team>`", "`GO <team>`", "`DONE <team>`"]) expect(teams).toContain(s);
  expect(section("Who talks to whom")).toContain("Only the PM talks to the user");
  expect(section("Who talks to whom")).toMatch(/lead .*messages the other leads directly/s);
  const caps = section("Cap rule");
  for (const s of ["**30 background sessions working at once**", "**2 teams**", "**2 working in a team**", "**One specialist per task**"]) expect(caps).toContain(s);
  expect(caps).toMatch(/status is `idle`.*frees its slot.*missing or unreadable status counts as working/s);
  expect(section("Interns")).toContain("**at most 2 interns**");
  expect(section("Board format")).toContain("~/.f1rm/boards/<repo>.team.<team>.md");
  expect(section("Use what is installed")).toContain("skills, slash commands and plugins");
});

test("specialists never hire and answer only their Report to; the PM hires only leads and lets a lead go after DONE", () => {
  for (const name of ["designer", "frontend-dev", "backend-dev", "reviewer", "researcher"]) {
    const { body } = role(name);
    expect(body).toContain("Never hire or start a session");
    expect(body).toContain("Report only to the session in your `Report to`");
    expect(body).toMatch(/at most 2 interns/i);
  }
  const pm = role("pm").body;
  expect(pm).toContain("Hire only leads");
  expect(pm).toContain("After `DONE <team>`, let the lead go");
  const lead = role("lead").body;
  for (const s of ["`PLAN <team>`", "`GO <team>`", "`DONE <team>`", "f1rm hire --team <team>", "Only the PM talks to the user"]) expect(lead).toContain(s);
});

test("the guidelines run editions: Work and Founder, the founder playbook, drafts only, the content checklist and publish", () => {
  for (const h of ["Editions", "Founder playbook", "Drafts only"]) expect(section(h).trim().length).toBeGreaterThan(100);
  expect(section("Editions")).toContain("~/.f1rm/projects/<repo>.json");
  expect(section("Editions")).toContain("refuses a Founder-only role in a Work project");
  const playbook = section("Founder playbook");
  for (const s of ["the customer, the problem they have, the offer, and the channel", "**Strategist first**", "`growth/brand.md`", "`growth/marketing/`", "`launch` team"]) expect(playbook).toContain(s);
  const drafts = section("Drafts only");
  for (const s of ["never post, publish, send, schedule or spend", "paid credits", "`publish`"]) expect(drafts).toContain(s);
  expect(section("Review and merge flow")).toContain("**content checklist**");
  expect(section("Board format")).toContain("`publish` means approved founder work waiting for the user to put it out");
  for (const r of ["marketer", "seo-specialist", "social-media", "sales", "strategist"]) {
    const { body } = role(r);
    expect(body).toContain("Drafts only: never post, publish, send, schedule or spend");
    expect(body).toContain("Read `growth/brand.md` before drafting anything");
    expect(body).toMatch(/Deliver files under `growth\/(marketing|seo|social|sales|strategy)\/`/);
    expect(body).toContain("Report only to the session in your `Report to`");
  }
  expect(role("marketer").body).toContain("your first task is to write it");
  expect(role("pm").body).toContain("In a Founder project, follow the founder playbook as well");
  expect(role("pm").body).toContain("keep the `publish` list");
  expect(role("reviewer").body).toContain("content checklist");
});

test("the roster table names each hireable role with the commands `f1rm hire` loads", () => {
  const rows = [...section("Roster and hiring playbook").matchAll(/^\| `(\S+)` \| .*? \| (.+?) \|$/gm)];
  expect(rows.map((r) => r[1])).toEqual(Object.keys(ROLES));
  for (const [, name, cell] of rows) {
    const listed = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The PM is never hired, so its row lists only what `f1rm pm` loads.
    const skills = name === "pm" ? ROLES[name].filter((s) => s !== GUIDELINES) : ROLES[name];
    expect(listed.sort()).toEqual([...skills].sort());
  }
});

test("research and security-review are slash commands: --skills research and --level high bring them in, no role invokes them as skills", () => {
  const playbook = section("Roster and hiring playbook");
  for (const c of SLASH_ONLY) {
    expect(playbook).toContain(`\`/${c}\``);
    for (const r of Object.keys(ROLES)) {
      expect(role(r).fm.skills ?? []).not.toContain(c);
      expect(role(r).body).not.toMatch(new RegExp(`${c} skill`, "i"));
    }
  }
  expect(playbook).toMatch(/brief of a hire starts with/i);
  for (const s of ["`--skills research`", "`--level high`", "`--skills security-review` is refused", "never loaded at the start", "`--content`"]) expect(playbook).toContain(s);
});

// The skills the Workflows section names for each role, beyond its `skills:` list.
const WORKFLOW_SKILLS: Record<string, string[]> = {
  "frontend-dev": ["run", "design-pipeline"],
  "backend-dev": ["mattpocock-skills:diagnosing-bugs"],
  reviewer: ["security-review"],
  researcher: ["research"],
};
const bare = (skill: string) => skill.split(":").pop()!;

test("the Workflows section has an entry for every role, naming its skills, and every skill it names is in a role file or the roster", () => {
  const flows = section("Workflows");
  const entries = flows.split(/^- \*\*/m).slice(1);
  for (const r of Object.keys(ROLES)) {
    const entry = entries.find((e) => e.startsWith(`${r}**`));
    expect(entry, `${r} has a Workflows entry`).toBeDefined();
    for (const s of [...ROLES[r], ...(WORKFLOW_SKILLS[r] ?? [])]) expect(entry!, `${r} names ${s}`).toContain(bare(s));
  }
  const everything = [section("Roster and hiring playbook"), ...Object.keys(ROLES).map((r) => readFileSync(join(PLUGIN, "agents", `${r}.md`), "utf8"))].join("\n");
  const named = [...flows.matchAll(/`\/?([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)`/g)].map((m) => m[1]);
  expect(named.length).toBeGreaterThan(15);
  for (const s of named) expect(everything, `${s} is in a role file or the roster`).toContain(bare(s));
  // The skills a role runs by hand are in its role file.
  expect(role("frontend-dev").body).toContain("`run`");
  expect(role("backend-dev").body).toContain("diagnosing-bugs");
});

test("the guidelines carry the evidence handoff: the DONE block, BLOCKED permission, ESCALATE, f1rm letgo and the base-fails rule", () => {
  const handoff = section("Handoff via SendMessage");
  for (const s of ["exit code", "screenshot", "skills used", "~/.f1rm/evidence/<repo>/<task>/", "`BLOCKED <slug> permission`", "`ESCALATE <slug>`", "one `BLOCKED` message"]) expect(handoff).toContain(s);
  const flow = section("Review and merge flow");
  for (const s of ["passes on the base proves nothing", "red-<task>", "`ESCALATE <slug>`", "research a brief puts in the repo"]) expect(flow).toContain(s);
  expect(section("Teams")).toContain("`f1rm letgo");
  expect(section("Who talks to whom")).toContain("`BLOCKED <slug> permission`");
  expect(guidelines).toContain("Nobody pushes; the user pushes.");
  const playbook = section("Roster and hiring playbook");
  for (const s of ["same task goes to the same session", "`review-<task>`", "previous `DONE` report", "what the user must provide"]) expect(playbook).toContain(s);
});

test("the guidelines say what each gate holds and the way out, and a cap refusal goes lead to PM to user", () => {
  const gates = section("Gates");
  for (const s of ["skill gate", "delegation gate", "boards, milestones, kept files, memory, evidence and scratch", "`f1rm:*`", "load the skills", "security-review"]) expect(gates).toContain(s);
  const skillGate = gates.split("\n").find((l) => l.includes("**skill gate**")) ?? "";
  for (const s of ["Only a session's first prompt arms it", "a later message that quotes that prompt's skill list changes nothing", "forked from one is not armed again", "a skill the Skill tool refuses counts as tried, read from the session's own transcript", "disable-model-invocation, go on without that skill", "Unknown skill, go on and send `BLOCKED <slug>`"]) expect(skillGate, s).toContain(s);
  const cap = section("Cap rule");
  expect(cap).toMatch(/lead.*tells? the PM/s);
  expect(cap).toMatch(/PM.*tells? the user/s);
});

test("pm.md turns handed work into a board task, sends exploration to a Haiku Explore intern, sends permission blocks to the hire's desk, picks up first, and ends a milestone", () => {
  const pm = role("pm").body;
  for (const s of ["including a slash command", "Haiku Explore intern", "never run its command", "Pick up", "claude logs", "f1rm letgo", "close this session"]) expect(pm).toContain(s);
  const lead = role("lead").body;
  expect(lead).toContain("f1rm letgo");
  expect(lead).toMatch(/cap.*Tell the PM/s);
  expect(role("reviewer").body).toContain("only after main has moved");
});

test("both READMEs list f1rm letgo, the hire flags and the Workflows section", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8"), plugin = readFileSync(join(PLUGIN, "README.md"), "utf8");
  expect(readme).toMatch(/^\| `f1rm letgo` \|/m);
  for (const text of [readme, plugin]) {
    for (const s of ["--skills", "--level", "--content", "f1rm letgo", "Workflows"]) expect(text).toContain(s);
  }
  expect(readme).toContain("(plugin/skills/f1rm-guidelines/SKILL.md#workflows)");
  expect(plugin).toContain("(skills/f1rm-guidelines/SKILL.md#workflows)");
});

test("both READMEs and the hire skill state the machine cap as 30, never 6", () => {
  const texts = [join(REPO, "README.md"), join(PLUGIN, "README.md"), join(PLUGIN, "skills", "hire", "SKILL.md")].map((f) => readFileSync(f, "utf8"));
  expect(texts[0]).toContain("At most 30 background sessions work at once");
  expect(texts[1]).toContain("30 working sessions on the machine");
  expect(parts(join(PLUGIN, "skills", "hire", "SKILL.md")).fm.description).toContain("30 working sessions on the machine");
  for (const t of [...texts, guidelines]) expect(t).not.toMatch(/\b(6|six) (background|working) sessions/);
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
  expect(details.out).toMatch(/Agents \(12\)\s+\S/);
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
  expect(playbook).toContain('f1rm hire lead lead-<team> <team> "<team brief>"');
  expect(playbook).toContain('f1rm hire --team <team> <role> <team>.<role>-<task> <task> "<brief>"');
  expect(playbook).not.toContain("--help");
  expect(section("Cap rule")).toContain("f1rm hire --override");
  expect(section("Brief format")).not.toMatch(/^Report to:/m);
});

test("the guidelines state the milestones file and the decisions log, and the places where the rules bite mention them", () => {
  const md = section("Milestones and decisions");
  for (const s of ["~/.f1rm/milestones/<repo>.md", "encoded exactly as the board path", "# Milestones: <repo name>", "## <milestone slug>", "Goal", "Settled", "Tasks", "Done when", "Only the PM writes it", "when the user confirms the plan", "at pickup", "replaces the section with a 5-line record", "Task status stays on the board"]) expect(md, s).toContain(s);
  for (const s of ["`docs/decisions.md`", "a feature or behaviour the user chose", "a refactor or architecture choice", "a cap, limit, dependency or version change", "anything rejected for a reason", "Bug fixes and wording tweaks get no entry", "append-only, oldest first", "## <YYYY-MM-DD> <title>", "`- Decision:`", "`- Why:`", "`- Rejected:`", "`- Where:`", "docs/decisions.md has the entry <title>", "a missing entry blocks", "`docs/adr/`", "links to the ADR"]) expect(md, s).toContain(s);
  expect(section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))).toContain("milestones file");
  expect(section("Brief format")).toContain("docs/decisions.md");
  expect(section("Review and merge flow")).toContain("docs/decisions.md");
});

test("pm.md reads the milestones file at pickup, writes the milestone's section with the board, and replaces it with a record at the end of the milestone", () => {
  const pm = role("pm").body;
  const step = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(pm)?.[0] ?? "";
  expect(step(1)).toContain("~/.f1rm/milestones/<repo>.md");
  expect(step(4)).toContain("milestone's section");
  expect(step(4)).toContain("docs/decisions.md has the entry");
  expect(step(7)).toMatch(/replace the milestone's section/);
  expect(pm).toContain("Only the PM writes the milestones file");
  expect(step(7)).toContain("picks up from the board and the milestones file");
  expect(role("researcher").body).toContain("Change no other files except `docs/decisions.md`");
});

test("the lead and the Reviewer carry their part of the decisions log", () => {
  expect(role("lead").body).toContain("docs/decisions.md has the entry");
  expect(role("reviewer").body).toMatch(/every `docs\/decisions\.md` entry the brief asks for.*blocks/);
});

const SPECIALISTS = ["designer", "frontend-dev", "backend-dev", "researcher", "marketer", "seo-specialist", "social-media", "sales", "strategist"];
const pmStep = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(role("pm").body)?.[0] ?? "";
const cliSource = () => readFileSync(join(REPO, "office", "cli", "f1rm.ts"), "utf8");
const pmPromptText = () => /const pmPrompt[\s\S]*?`;/.exec(cliSource())![0];

test("B1: every milestone runs through one or two leads, and the PM hires only leads", () => {
  const stale = [/the PM, no teams/, /forms teams only/, /hire specialists directly/, /hiring specialists directly/, /In a milestone without teams/];
  for (const text of [guidelines, role("pm").body, role("lead").body, readFileSync(join(PLUGIN, "README.md"), "utf8"), readFileSync(join(REPO, "README.md"), "utf8"), pmPromptText()]) for (const re of stale) expect(text).not.toMatch(re);
  expect(section("Teams")).toContain("even a milestone of one task");
  expect(section("Teams")).toContain("Haiku Explore interns");
  expect(guidelines.split("\n").find((l) => l.startsWith("Hierarchy:"))).toContain("hires only leads");
  const forms = section("Roster and hiring playbook").split("```")[1];
  expect(forms).not.toContain("the PM, no teams");
  expect(forms).toContain('f1rm hire lead lead-<team> <team> "<team brief>"');
  expect(role("pm").body).toContain("Hire only leads");
  expect(String(role("pm").fm.description)).not.toContain("hires specialists");
  expect(pmPromptText()).toContain("Hire only leads");
});

test("B1: no line says a specialist reports to the PM or that the PM lets specialists go", () => {
  const stale = [/otherwise the PM/, /the PM or the team's lead/, /the PM or your team's lead/, /your team's lead, or the PM/, /the PM, or its team's lead/, /the specialists, the PM or/];
  const texts = [guidelines, readFileSync(join(PLUGIN, "README.md"), "utf8"), readFileSync(join(REPO, "README.md"), "utf8"), ...Object.keys(ROLES).filter((r) => r !== "pm" && r !== "lead").map((r) => role(r).body)];
  for (const t of texts) for (const re of stale) expect(t).not.toMatch(re);
  expect(section("Who talks to whom")).toContain("A specialist reports only to the session in its `Report to`, its team's lead.");
  expect(section("Who talks to whom")).toContain("never messages the user, the PM, another team or another specialist");
  expect(section("Review and merge flow")).toContain("The team's lead lets them go with `f1rm letgo <name>...`");
  for (const r of ["designer", "frontend-dev", "backend-dev", "reviewer", "researcher", ...SPECIALISTS]) expect(role(r).body, r).toContain("Report only to the session in your `Report to`: your team's lead. Never message the user, the PM, another team or another specialist.");
});

test("the PM resolves a blocked lead, and its cleanup moves and removes files with Bash only after the user replies", () => {
  const pm = role("pm").body;
  expect(pm).toContain("Resolve a blocked lead");
  expect(pm).not.toContain("blocked specialist");
  const edit = pm.split("\n").find((l) => l.startsWith("- Edit the board and the milestones file only"))!;
  for (const s of ["after the user replies", "`~/.f1rm/kept/<repo>/`", "Bash (`mv`, `rm`)"]) expect(edit, s).toContain(s);
});

test("founder work meant to go out is marked publish on the lead's team board, and the lead tells the PM, who tells the user", () => {
  const drafts = section("Drafts only");
  for (const s of ["the lead marks its team-board row `publish`", "`BLOCKED <team> publish`", "The PM tells the user", "the PM tells the lead, who marks the row `done`"]) expect(drafts, s).toContain(s);
  expect(drafts).not.toContain("the PM marks its board row");
  expect(section("Board format")).toContain("On a team board the lead sets `publish` and `done`");
  const pm = role("pm").body, lead = role("lead").body;
  expect(pm).toContain("keep the `publish` list");
  expect(pm).toContain("`BLOCKED <team> publish`");
  expect(pm).toContain("tell the lead");
  expect(pm).not.toContain("mark approved founder work");
  expect(lead).toContain("`BLOCKED <team> publish`");
  expect(lead).toContain("mark its row `publish`");
  expect(lead).toContain("mark the row `done`");
});

test("pickup keeps status internal: the PM updates the rows and says nothing until the user asks \"status?\"", () => {
  const pickup = [pmStep(1), section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))!.split("\n").find((l) => l.includes("Pick up"))!, pmPromptText()];
  for (const t of pickup) {
    expect(t).not.toMatch(/where things were left/);
    expect(t).toMatch(/says? nothing|say nothing|answer[^.]* "status\?"/i);
  }
  expect(pmStep(1)).toContain('answer when the user asks "status?"');
  expect(pickup[1]).toContain('answer when the user asks "status?"');
  expect(pmPromptText()).toContain('answer when I ask "status?"');
  expect(pmPromptText()).toContain("Ask me only as");
});

test("three gates, the README's hiring line, and the content checklist match the new rules", () => {
  expect(section("Gates")).toContain("With the office stopped, none runs.");
  expect(section("Gates")).not.toContain("neither runs");
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  expect(readme).toContain("The PM hires team leads, who hire the rest.");
  expect(readme).not.toContain("The PM hires the rest.");
  for (const text of [section("Review and merge flow"), role("reviewer").body]) {
    expect(text).toContain("research a brief puts in the repo");
    expect(text).not.toContain("docs/research/");
  }
});

test("B3-B5: leads filter team traffic, so the PM tells the user only what needs a decision or the user, plus one end-of-milestone report", () => {
  const talk = section("Who talks to whom");
  for (const s of ["big decisions;", "a permission on a hire's desk", "spend, credentials or inputs", "a `git push`", "a dirty main checkout", "one end-of-milestone report", 'the user asks "status?"']) expect(talk, s).toContain(s);
  expect(talk).toMatch(/lead receives all of its team's messages/);
  expect(talk).toMatch(/sends the PM only `PLAN <team>`, `BLOCKED` for what needs the user, and `DONE <team>`/);
  expect(section("Team brief")).toMatch(/Report: PLAN before hiring, BLOCKED[^\n]*DONE/);
  for (const text of [guidelines, role("lead").body]) expect(text).not.toMatch(/status report/i);
  const teams = section("Teams");
  expect(teams).toMatch(/`GO <team>` without telling the user, unless the plan changes agreed scope or a decision/);
  for (const s of ["checks each specialist's `DONE` against its brief", "reruns its checks before it hires the Reviewer", "sends the work back", "~/.f1rm/evidence/<repo>/findings.md", "5-line summary", "only role that merges"]) expect(teams, s).toContain(s);
  const lead = role("lead").body;
  for (const s of ["receive every message from your team", "~/.f1rm/evidence/<repo>/findings.md", "`PLAN <team>`, `BLOCKED` for what needs the user, and `DONE <team>`"]) expect(lead, s).toContain(s);
  const pm = role("pm").body;
  expect(pm).toContain("`GO <team>` without telling the user");
  for (const s of ["big decisions", "git push"]) expect(pm, s).toContain(s);
  expect(pmPromptText()).toContain("GO <team>");
});

test("C1: the Reviewer sends conflicts back to the dev, refuses a moved tip, and retries an index.lock", () => {
  const flow = section("Review and merge flow");
  for (const s of ["git merge --abort", "`CHANGES REQUESTED <slug> conflict`", "never resolves a conflict itself", "rebases its unpushed branch onto the current main", "equals the commit in the dev's `DONE`", "`BLOCKED <slug> tip moved`", "index.lock", "after a few seconds"]) expect(flow, s).toContain(s);
  const reviewer = role("reviewer").body;
  for (const s of ["git merge --abort", "`CHANGES REQUESTED <slug> conflict`", "`BLOCKED <slug> tip moved`", "index.lock"]) expect(reviewer, s).toContain(s);
  expect(section("Handoff via SendMessage")).toContain("`CHANGES REQUESTED <slug> conflict`");
  expect(section("Handoff via SendMessage")).toContain("`BLOCKED <slug> tip moved`");
  for (const name of SPECIALISTS) expect(role(name).body, name).toContain("`CHANGES REQUESTED <slug> conflict`");
});

test("C2: the gate refuses every push and the Reviewer's history rewrites, and the Reviewer file no longer calls the no-push rule prompt-only", () => {
  const gates = section("Gates");
  for (const s of ["`git push` in any form", "`gh pr merge`", "`reset`, `rebase`, `cherry-pick`, `revert`, `am`, `pull`, `clean`, `stash`, `commit --amend`, `checkout -- <path>`, `checkout --ours` or `--theirs`, `restore` unless `--staged` is its only option, `branch -D`, `--force` and `-f`", "except `git worktree remove --force .claude/worktrees/red-<task>`", "`gh api` call that writes to code-landing endpoints", "pull request and branch merges and updates, refs, commits, trees, blobs and contents, and graphql merge, update and ref mutations", "other `gh api` calls stay allowed", "behind `timeout`, `nice` or `stdbuf`", "`git checkout <branch> -- <check files>` stays allowed"]) expect(gates, s).toContain(s);
  expect(role("pm").body).toContain("Write and Edit work there too");
  const reviewer = readFileSync(join(PLUGIN, "agents", "reviewer.md"), "utf8");
  expect(reviewer).not.toContain("prompt-only");
  expect(reviewer).toMatch(/gate refuses/i);
});

test("D1: a milestone ends with a cleanup the user answers, and working files stay out of the repo", () => {
  const md = section("Milestones and decisions");
  for (const s of ["Milestone cleanup", "**Persist**", "~/.f1rm/kept/<repo>/", "never deleted automatically", "**Delete**", "done board rows", "move items between the groups", "only after the user replies", "5-line record", "task ids and landing commits", "how to try it", "what is open", "`docs/decisions.md` and git history stay"]) expect(md, s).toContain(s);
  expect(md).not.toContain("deletes the section");
  expect(section("Board format")).not.toContain("Never delete rows");
  expect(section("Board format")).toContain("milestone cleanup");
  const handoff = section("Handoff via SendMessage");
  for (const s of ["Working files never enter the repo", "`keep: <path> — <why>`"]) expect(handoff, s).toContain(s);
  expect(section("Teams")).toContain("`keep:` lines");
  for (const name of SPECIALISTS) expect(role(name).body, name).toContain("`keep: <path> — <why>`");
  expect(role("lead").body).toContain("`keep:` lines");
  for (const s of ["Persist", "Delete", "the `git push` line", "only after the user replies"]) expect(pmStep(7), s).toContain(s);
  expect(role("researcher").body).toContain("~/.f1rm/evidence/<repo>/<task>/");
  expect(role("pm").body).not.toContain("delete its section");
  expect(readFileSync(join(PLUGIN, "README.md"), "utf8")).not.toContain("deleted when a milestone is reached");
});

test.each(["designer", "frontend-dev", "backend-dev", "researcher", "marketer", "seo-specialist", "social-media", "sales", "strategist"])("%s adds its decisions.md entries in its own commit", (name) => {
  const { body } = role(name);
  const core = "a feature or behaviour the user chose; a refactor or architecture choice; a cap, limit, dependency or version change; anything rejected for a reason";
  expect(section("Milestones and decisions")).toContain(core);
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
  for (const e of entries) expect(e.split("\n").filter((l) => l.trim()).slice(1).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

test("the Reviewer sends back every /code-review finding and merges only when none is left; ponytail-review never blocks; only a blocking round counts toward ESCALATE", () => {
  const flow = section("Review and merge flow");
  const step4 = /^4\. .*$/m.exec(flow)?.[0] ?? "";
  for (const s of ["every finding, blocking or not", "Merge only when none is left", "a round that holds a blocking finding counts toward `ESCALATE`", "ounds of minor findings alone never escalate"]) expect(step4, s).toContain(s);
  // The guidelines state each rule once, in the review flow; the other places point to it.
  expect(flow).toContain("its findings go in your report and never block");
  for (const s of ["never block", "Merge only when none is left", "ounds of minor findings alone never escalate"]) expect(guidelines.split(s).length - 1, s).toBe(1);
  expect(guidelines).not.toContain("no finding goes to a later branch");
  const handoff = section("Handoff via SendMessage");
  expect(handoff).toMatch(/`CHANGES REQUESTED <slug>` from the Reviewer, then the findings with file and line, marked blocking or not/);
  expect(handoff).toMatch(/`ESCALATE <slug>` from the Reviewer in place of a third round with a blocking finding \(see the review flow\)/);
  expect(step4).toContain("in place of a third round with a blocking finding");
  expect(step4).toContain("or any item of the content checklist is missed");
  for (const file of [guidelines, ...["reviewer", "lead", "pm"].map((r) => role(r).body)]) expect(file).not.toContain("in place of a third `CHANGES REQUESTED`");
  const reviewer = role("reviewer").body;
  for (const s of ["every `/code-review` finding, blocking or not", "merge only when none is left", "Its findings go in your report and never block.", "a round that holds a blocking finding counts toward `ESCALATE`"]) expect(reviewer, s).toContain(s);
  expect(reviewer).toContain("`CHANGES REQUESTED` with every finding");
  expect(reviewer).not.toContain("with the blocking findings");
  expect(reviewer).not.toContain("goes back like a blocking one");
  expect(reviewer.split("blocking or not").length - 1).toBe(2);
  const lead = role("lead").body;
  for (const s of ["minor findings too", "before the merge", "fixed"]) expect(lead, s).toContain(s);
  expect(section("Teams")).toMatch(/minor findings too[^\n]*before the merge/);
  expect(section("Teams")).not.toContain("left unfixed");
  expect(role("pm").body).toContain("before the merge");
  expect(guidelines).not.toContain("findings left unfixed");
  for (const text of [guidelines, role("reviewer").body, lead, role("pm").body]) expect(text).not.toMatch(/follow-up branch|merge first|fix(ed)? (them )?later/i);
});

test("the plugin is 0.4.0, and its README names both documents", () => {
  expect(JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.4.0");
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  expect(readme).toContain("~/.f1rm/milestones/<repo>.md");
  expect(readme).toContain("docs/decisions.md");
});

test("P1: projects are isolated: the PM and leads filter to their own repo, address no other project, and report f1rm problems to the user", () => {
  const talk = section("Who talks to whom");
  for (const s of ["Projects are isolated", "`claude agents --json`", "own repo", "never name, address or rely on another project's sessions, boards, milestones or evidence", "`f1rm feedback: <problem> -> <suggestion>`", "addressed to no session"]) expect(talk, s).toContain(s);
  expect(section("Gates")).toContain("project gate");
  expect(section("Gates")).toContain("SendMessage");
  expect(section("Gates")).toContain("With the office stopped, none runs.");
  for (const r of ["pm", "lead"]) {
    for (const s of ["claude agents --json", "own repo", "another project's", "`f1rm feedback: <problem> -> <suggestion>`", "addressed to no session"]) expect(role(r).body, `${r}: ${s}`).toContain(s);
  }
  expect(section("Gates")).toContain("Two sessions both outside any door share the Elsewhere room and can message each other.");
  expect(guidelines.split("Elsewhere room").length - 1).toBe(1);
  const sentence = (r: string) => /Stay in your own repo: filter[^\n]*?(at pickup and every time after)\./.exec(role(r).body)?.[1];
  expect([sentence("pm"), sentence("lead")]).toEqual(["at pickup and every time after", "at pickup and every time after"]);
});

test("P2: every role keeps only facts about the user and lessons that hold in any project in memory, and project learnings in its notes file", () => {
  for (const name of Object.keys(ROLES)) {
    const body = role(name).body;
    expect(body, name).toContain("facts about the user and how they like to work");
    expect(body, name).toContain("lessons that hold in any project");
    expect(body, name).toContain(`~/.f1rm/kept/<repo>/notes/${name}.md`);
    expect(body, name).not.toContain("to your memory");
  }
  expect(section("Brief format")).toContain("Context names the notes file for its role: `~/.f1rm/kept/<repo>/notes/<role>.md`");
  const md = section("Milestones and decisions");
  expect(md).toContain("`~/.f1rm/kept/<repo>/notes/` is in neither group; it stays.");
});

test("P3: a hire that creates the decisions log adds its merge=union line to .gitattributes, and Reviewers still resolve no conflict", () => {
  const md = section("Milestones and decisions");
  for (const s of ["the decisions log file, whatever its path", "`<that path> merge=union`", ".gitattributes", "a line of its own"]) expect(md, s).toContain(s);
  expect(md).toContain("docs/decisions.md merge=union");
  expect(section("Review and merge flow")).toContain("never resolves a conflict itself");
  expect(readFileSync(join(REPO, ".gitattributes"), "utf8").split("\n")).toContain("docs/decisions.md merge=union");
  // Union folds an entry's identical first and last lines, so an HTML entry opens with an id and closes with a comment; one sentence, everywhere.
  const html = "an HTML entry needs an opening tag with an id and a closing comment after its closing tag";
  expect(md).toContain(html);
  expect(md).toContain("The blank line that opens an entry folds too, so the second heading follows the first entry's last line.");
  const decisions = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  expect(decisions).toContain(html);
  for (const name of ["backend-dev", "frontend-dev", "designer", "researcher", "marketer", "seo-specialist", "social-media", "sales", "strategist"]) {
    const line = /Decisions log:[^\n]*/.exec(role(name).body)?.[0];
    expect(line, name).toContain("`<that path> merge=union`");
    expect(line, name).toContain(html);
  }
});

// Self-driving teams: the PM watches its leads and each lead its hires with `f1rm status --watch`, and wakes or replaces the ones that stopped.
test("S1: the guidelines state the watcher, the real-activity rule, and what to do on a wake for a limit stop, an ended session and a stalled one", () => {
  const w = section("Watching and waking");
  for (const s of [
    "never by status text", "`f1rm status --json`", "`idleMinutes`", "`limitUntil`", "`ended`", "`f1rm status --watch <names>`", "`name:waiting`", "`run_in_background`", "its exit wakes you",
    "idle for 20 minutes", "exits 1 when `claude agents --json` can't be read", "only when it and every hire of its team",
    "Pass a session waiting for an answer to its report (`DONE`, `BLOCKED`, `PLAN`, `CHANGES REQUESTED`, `ESCALATE`, `APPROVED`, or a lead's `DONE <team>`) as `name:waiting`",
    "a waiting name is judged only for ended, missing or a limit stop, never for being quiet",
    "When you answer a session's report (and it works again), restart the watcher with it as a plain name.", "a waiting name is watched as a plain name as soon as it writes again",
    "Leave out a hire waiting on a reset timer you hold.", "Start no watcher when no name is left; the reset timers wake you.",
    "After `f1rm letgo`, restart the watcher without the names you let go.", "For a wake about a session you already handled (or took a report from) since that watcher started: ignore it, but still restart the watcher.", "When a session sends its report, restart the watcher with it as `name:waiting`.",
    "A message you send to a waiting session counts as a write and makes it plain.", "Until it writes, a waiting name is woken only for ended, missing or a limit stop.",
    "**Limit stop**", "wait until the time it names", "the text after \"resets\"", "send it `resume`", "`resume.md`",
    "**Limit stop with no time** (`limitUntil` is `unknown`)", "wait a few minutes with a background `sleep` whose exit wakes you, then send it `resume` as for an idle session",
    "**Missing or no activity time**", "keep it in the names; if the next wake still finds it so, treat it as ended",
    "**Ended**", "`f1rm letgo <name>`", "resume brief", "before the original brief", "merged commits", "branch tip", "stale scratch worktrees", "remaining specs", "new task slug", "old tip",
    "`name [ref]`", "`uds:<socket>`", "decides on the bare name", "**Idle 20 minutes",
    "**Status can't be read**", "if status refuses the repo itself (not a git repo, path too long), don't restart: tell the session in your `Report to` (the PM tells the user). Otherwise run `f1rm status` by hand to see why, then restart the watcher.",
    "when the last line of the conversation is a limit stop",
  ]) expect(w, s).toContain(s);
  // After you send `resume`: the delivered `resume` clears the stop; a second one in a row ends the hire unless a timed limit stop came between.
  for (const s of [
    "**After you send `resume`**, restart the watcher.", "The delivered `resume` clears the stop, so the old stop does not wake the watcher again", "shows a new stop and wakes you again",
    "a second `resume` in a row that brought no new commit, message or timed limit stop in between means it is ended", "an `unknown` stop does not count, so a persistent error ends after two resumes",
    "After handling any wake (unless status refused the repo), restart the watcher with the names still working.", "A wake from a stale watcher is ignored when its hire is not in the names you now watch.",
  ]) expect(w, s).toContain(s);
  expect(w.split("delivered `resume` clears the stop").length - 1).toBe(1); // said once
  expect(w.split("After handling any wake (unless status refused the repo), restart the watcher").length - 1).toBe(1);
  // The watcher is the command: no script in the prose, no timer rules, no running-watcher bookkeeping.
  for (const old of ["bun -e", "NAMES=", "while :", "sleep 60", "sleep 300", "stop the running one first", "PID", "a minute later", "under a minute", "until its first new line", "complete the other"]) expect(w, old).not.toContain(old);
  expect(w).not.toMatch(/```/);
  // The checkpoint is one hire rule, in the playbook.
  const rule = section("Roster and hiring playbook");
  for (const s of ["Checkpoint", "wip commit", "`~/.f1rm/evidence/<repo>/<task>/resume.md`", "done, next step, tip", "A lead's is `lead-<team>/resume.md` and the PM's `pm-<repo>/resume.md`"]) expect(rule, s).toContain(s);
  expect(rule).toContain("each lives in a folder named after the session");
  expect(rule).not.toMatch(/collide/);
  // One subscription: the same limit stops the PM, the leads and their hires together, and nothing wakes them (the brief rejects a daemon).
  const known = "If the PM and the leads are stopped by the same limit, nothing wakes them; the user restarts them after the reset.";
  const decisions = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  for (const s of [
    "the PM watches its leads and each lead watches its own hires with `f1rm status --watch <names>` in the background", "its exit wakes them",
    "passes sessions waiting for an answer to their report (`DONE`, `BLOCKED`, `PLAN`, `CHANGES REQUESTED`, `ESCALATE`, `APPROVED`, or a lead's `DONE <team>`) as `name:waiting`",
    "the delivered `resume` clears the stop", "only while the stop is the last line of the conversation", "a stop that names no time gets `resume` after a few minutes",
    "a reply or a delivered message (an enqueue or a user line) clears it; the session's own task-notification does not",
    "a second `resume` in a row that brought no new commit, message or timed limit stop in between means the hire is ended",
    "an ended hire is listed only when the folder its transcript records is this repo's folder or under it",
    "it refuses, in every form, a repo whose encoded project folder is over 150 characters",
    "`f1rm hire` starts hires at the git repo root, not in the subfolder it ran from (outside git, where it ran)", "the PM starts where it ran", "a repo whose `.git` is not inside its working tree (a submodule or a separate git dir) is not supported", "the office's Hire endpoint refuses a long-path repo too, with the same message", "matching cut repo folders was dropped", "The refusal happens at `f1rm pm`, `f1rm hire` and `f1rm status`", "`f1rm pm` and `f1rm hire` check the root of a git repo, not the subfolder they ran from, and refuse nothing outside git", "judged only for ended, missing or a limit stop, never for being quiet",
    "When a session sends its report the PM or lead restarts the watcher with it as `name:waiting` (the PM does the same for its leads: `PLAN`, `DONE <team>`); when it answers the report and the session works again, it restarts the watcher with it as a plain name",
    "so the `--claude-worktrees-` prefix of a worktree's folder stays whole (the filter matches a cut worktree name by that prefix; task slugs have no cap",
  ]) expect(decisions, s).toContain(s);
  for (const old of ["bun snippet", "the loop sleeps first", "loops `f1rm status --json`", "restarts the watcher a minute later", "`f1rm hire` and `f1rm pm` start the session at the git repo root", "judged only for ended and a limit stop", "longest worktree folder", "and nothing outside git (plain-folder", "(except a refused repo)", "matches a cut name by that prefix", "matching cut names was dropped", "or limit stop in between", "leaving out sessions waiting", "it is restored as a plain name when it works again"]) expect(decisions, old).not.toContain(old);
  for (const old of ["So is a hire waiting on a reset timer", "judged only for ended and a limit stop", "unless you hold the timer yourself"]) expect(w, old).not.toContain(old);
  // Nothing watches the PM either: one stopped on its own (a no-time error, a weekly limit mid-turn) stays stopped.
  const pmStop = "Nothing watches the PM; if it stops, the user restarts it.";
  for (const text of [w, decisions]) {
    expect(text).toContain(known);
    expect(text).toContain(pmStop);
  }
  // The lead and PM files say the same paths.
  expect(role("lead").body).toContain("`~/.f1rm/evidence/<repo>/lead-<team>/resume.md`");
  expect(role("pm").body).toContain("`~/.f1rm/evidence/<repo>/pm-<repo>/resume.md`");
  expect(section("Who talks to whom")).toContain("the watcher is your own");
});

test("S3: pm.md and lead.md carry the watcher and the wake rules, and every role file carries the checkpoint line", () => {
  for (const r of ["pm", "lead"]) {
    for (const s of ["`f1rm status --watch", "run_in_background", "its exit wakes you", "never by status text", "limit stop", "resume brief", "`name [ref]`", "Watching and waking", "**After you send `resume`**", "`name:waiting`"]) expect(role(r).body, `${r}: ${s}`).toContain(s);
    for (const old of ["bun -e", "sleep 300", "background watcher on `f1rm status --json`"]) expect(role(r).body, `${r}: ${old}`).not.toContain(old);
  }
  expect(role("pm").body).toMatch(/watch your leads/i);
  expect(role("lead").body).toMatch(/watch your own hires/i);
  for (const name of Object.keys(ROLES)) {
    const line = /^- \*\*Checkpoint\.\*\*[^\n]*|^Checkpoint:[^\n]*/m.exec(role(name).body)?.[0];
    expect(line, name).toContain("`~/.f1rm/evidence/<repo>/");
    expect(line, name).toContain("resume.md");
    if (!["pm", "lead", "reviewer"].includes(name)) expect(line, name).toContain("wip commit");
  }
});

test("S4: both READMEs list f1rm status, and docs/decisions.md has the f1rm status and Self-driving teams entries", () => {
  expect(readFileSync(join(REPO, "README.md"), "utf8")).toMatch(/^\| `f1rm status` \|/m);
  expect(readFileSync(join(PLUGIN, "README.md"), "utf8")).toContain("`f1rm status");
  const titles = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1).map((e) => e.split("\n")[0]);
  for (const t of ["f1rm status", "Self-driving teams"]) expect(titles).toContain(`2026-10-21 ${t}`);
});

test("the Skill stack and Ask-the-user decisions entries and the plugin README state the fixed rules: arena and swarm not wired, every pstack skill but setup flagged, hires log the core decisions", () => {
  const entry = (title: string) => readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).find((e) => e.startsWith(`2026-10-21 ${title}\n`))!;
  const stack = entry("Skill stack: mattpocock + pstack");
  expect(stack).not.toContain("only when a brief asks");
  for (const s of ["`pstack:arena` and `pstack:swarm` are not wired inside hires", "every pstack skill but `setup-pstack` carries `disable-model-invocation`", "`f1rm hire` refuses any other `pstack:` skill in `--skills`"]) expect(stack, s).toContain(s);
  const ask = entry("Ask the user only for big decisions");
  expect(ask).not.toContain("logged in `docs/decisions.md`");
  expect(ask).toContain("a core one goes into a brief's Context so the hire logs it");
  // The Where lines name the commits that rewrote the entries.
  expect(stack).toMatch(/- Where: skill-stack, 9fd3578; skill-stack-2, 24608de, 395e72c, 2359dae, 57552a6, a20d5b2, c2b220b, f44f850, 634a319\n/);
  expect(ask).toMatch(/- Where: skill-stack, 9fd3578; skill-stack-2, 8d68215, 18aa052, 2359dae/);
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  // Both READMEs say which --skills are refused.
  const refusals = "any `pstack:` skill other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only) is refused, and a code Reviewer refuses a slash-only skill";
  for (const text of [readme, readFileSync(join(REPO, "README.md"), "utf8")]) expect(text).toContain(refusals);
  expect(readme).not.toContain("made and logged for you");
  expect(readme).toContain("technical choices are made by the PM or the lead, and the hires log the core ones");
});

test("K1: the decision policy is stated once, in the guidelines; pm.md and lead.md point to it by name, and the report gains the decisions line", () => {
  const who = section("Who talks to whom");
  for (const s of [
    "**Ask the user only for big decisions.**", "business, product scope (what the software does), design direction, strategy", "irreversible or external actions (push, deploy, spend, data deletion, messaging people)",
    "Technical choices (architecture, libraries, refactors, test approach, tooling, f1rm's own internal rules)", // The delegation gate lets the PM and a lead write no docs/decisions.md: the hire logs a core decision in its own commit.
    "are made by the PM or the lead; a core one goes into a brief's Context so the hire logs it (see Who writes it)", "Decisions taken without you",
    // The caps and permissions stay the user's, as the cap rule and the lead's BLOCKED rule say. One flat list: the cap and the permission are items of it, not the tail of the parenthesis.
    "design direction, strategy, irreversible or external actions (push, deploy, spend, data deletion, messaging people), exceeding a cap, and a permission only the user can give", "the caps excepted",
  ]) expect(who, s).toContain(s);
  expect(who).toMatch(/a cap override[^\n]*goes to the PM as `BLOCKED`/);
  expect(section("Cap rule")).toContain("only after the user has approved exceeding the cap");
  expect(guidelines.split("product scope (what the software does)")).toHaveLength(2);
  for (const r of ["pm", "lead"]) {
    expect(role(r).body, r).toContain("Ask the user only for big decisions");
    expect(role(r).body, r).not.toContain("product scope (what the software does)");
    expect(role(r).body, r).toContain("so the hire logs it (see Who writes it");
    expect(role(r).body, r).not.toMatch(/\blog them\b|logged in `docs\/decisions\.md`/);
  }
  expect(role("pm").body).toContain("Decisions taken without you");
  expect(role("pm").body).not.toContain("questions that need the user's decision");
});

test("K2: devs start with /pstack:poteto-mode, pick its playbook, skip Opening a PR, and load tdd second; a backend bug loads diagnosing-bugs first", () => {
  for (const r of ["frontend-dev", "backend-dev"]) {
    const body = role(r).body;
    for (const s of ["/pstack:poteto-mode", "`feature`", "`bug-fix`", "`refactoring`", "`perf-issue`", "Opening a PR", "mattpocock-skills:tdd"]) expect(body, `${r}: ${s}`).toContain(s);
    expect(body, r).not.toMatch(/pstack:tdd|pstack's tdd/);
  }
  expect(role("backend-dev").body).toMatch(/diagnosing-bugs[^\n]*before[^\n]*tdd|first[^\n]*diagnosing-bugs/);
  const flows = section("Workflows");
  const entry = (r: string) => flows.split(/^- \*\*/m).find((e) => e.startsWith(`${r}**`))!;
  for (const r of ["frontend-dev", "backend-dev"]) expect(entry(r), r).toContain("pstack:poteto-mode");
  expect(entry("backend-dev").indexOf("diagnosing-bugs")).toBeLessThan(entry("backend-dev").indexOf("mattpocock-skills:tdd"));
});

test("K3: leads get pstack:architect or pstack:how only as a first command the PM names with --skills; the Reviewer adds mattpocock-skills:code-review and not interrogate; the PM keeps grilling", () => {
  const lead = role("lead").body;
  for (const s of ["pstack:architect", "pstack:how", "tell the PM", "Haiku Explore"]) expect(lead, s).toContain(s);
  expect(role("lead").fm.skills).toEqual([GUIDELINES, "f1rm:hire"]);
  const reviewer = role("reviewer").body;
  for (const s of ["mattpocock-skills:code-review", "Spec", "the brief"]) expect(reviewer, s).toContain(s);
  expect(reviewer).toMatch(/first command stays `\/code-review`|`\/code-review` stays first/);
  expect(reviewer).not.toContain("interrogate");
  expect(role("pm").fm.skills).toContain("mattpocock-skills:grilling");
  const playbook = section("Roster and hiring playbook");
  for (const s of ["`--skills pstack:architect`", "`--skills pstack:how`", "slash-only", "a dev's is `/pstack:poteto-mode`", "for a lead only", "refuses any other slash-only skill in a dev's `--skills`"]) expect(playbook, s).toContain(s);
});

test("K3a: a lead started with pstack:architect or pstack:how loads the guidelines with the Skill tool", () => {
  const step1 = /^1\. \*\*Load the rules\.\*\*.*$/m.exec(role("lead").body)?.[0] ?? "";
  for (const s of ["unless the PM started you with `pstack:architect` or `pstack:how`", "load the guidelines with the Skill tool"]) expect(step1, s).toContain(s);
});

test("K3b: a lead says which of pstack:how or a Haiku Explore intern applies, and that a running lead gets architect or how only through letgo and a re-hire by the PM", () => {
  const step3 = /^3\. \*\*Plan\.\*\*.*$/m.exec(role("lead").body)?.[0] ?? "";
  for (const s of [
    "If the PM started you with `pstack:how`, it ran first; otherwise send a Haiku Explore intern", "A running lead cannot gain a first command", "tell the PM, who runs `f1rm letgo lead-<team>` and hires you again with it",
  ]) expect(step3, s).toContain(s);
  // The route is said once.
  expect(step3).not.toContain("ask the PM");
  expect(step3.split("tell the PM")).toHaveLength(2);
});

test("K3c: the Reviewer runs the Spec axis inline, with no sub-agents, against worktree-<task> and not the main checkout's HEAD", () => {
  const line = /^- Your first command stays.*$/m.exec(role("reviewer").body)?.[0] ?? "";
  for (const s of ["inline, with no sub-agents", "`<base>...worktree-<task>`, not the main checkout's HEAD"]) expect(line, s).toContain(s);
  expect(section("Skill stack")).toContain("`mattpocock-skills:code-review` for the Spec axis, inline, against the brief");
});

test("K4: the guidelines hold a Skill stack table: phase, mattpocock skill, pstack skill, the f1rm rule that wins, and what never runs inside a hire", () => {
  const md = section("Skill stack");
  expect(md).toContain("| Phase | mattpocock skill | pstack skill | Rule that wins |");
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Phase") && !l.startsWith("| :-"));
  expect(rows.length).toBeGreaterThanOrEqual(6);
  for (const r of rows) expect(r.split("|").length, r).toBe(6); // four cells
  for (const s of [
    "`mattpocock-skills:grilling`", "`mattpocock-skills:tdd`", "`mattpocock-skills:diagnosing-bugs`", "`mattpocock-skills:code-review`", "`pstack:poteto-mode`", "`pstack:architect`", "`pstack:how`", "`pstack:interrogate`",
    "`feature`, `bug-fix`, `refactoring`, `perf-issue`", "slash-only", "disable-model-invocation", "/code-review", "the user can run it by hand",
  ]) expect(md, s).toContain(s);
  for (const s of ["no PR opening", "no babysit loops", "no `/loop` ticks", "no `afk`", "`pstack:arena` and `pstack:swarm` are not wired inside hires", "at most 2 interns", "pushing stays the user's"]) expect(md, s).toContain(s);
  // arena and swarm can't be run inside a hire (the Skill tool refuses them): the Parallel work row says the user runs them by hand, and a brief never asks for them.
  expect(rows.find((r) => r.startsWith("| Parallel work"))).toContain("Not wired inside hires (the Skill tool refuses them); the user can run them by hand");
  expect(md).not.toContain("when a brief asks");
  // Every pstack skill but its setup skill carries disable-model-invocation, so `f1rm hire` refuses all the others in --skills; a lead learns it before the refusal.
  const rule = "refuses any `pstack:` skill in `--skills` other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only)";
  expect(md).toContain("Every pstack skill but its setup skill carries `disable-model-invocation`");
  expect(md).toContain(`\`f1rm hire\` ${rule}`);
  const bullet = /^   - `--skills a,b`.*$/m.exec(section("Roster and hiring playbook"))?.[0] ?? "";
  for (const s of [rule, "`pstack:poteto-mode` (devs only)", "A code Reviewer refuses any slash-only skill"]) expect(bullet, s).toContain(s);
  // Any pstack skill's question to the human is routed, not only poteto-mode's (a lead started with architect or how follows the same rule).
  expect(md).toContain("A question a pstack skill would put to the human goes to the session in your `Report to` as `BLOCKED`");
  // Only pstack skills that exist are named.
  const real = ["poteto-mode", "architect", "how", "interrogate", "arena", "swarm"];
  for (const m of guidelines.matchAll(/pstack:([a-z-]+)/g)) expect(real, m[0]).toContain(m[1]);
  expect(section("Brief format")).toContain("names the pstack playbook that fits the task (see Skill stack)");
});

test("K5: `f1rm edition` sets the edition only once `f1rm pm` has registered the project, wherever a line says so", () => {
  const cli = ["hire.ts", "f1rm.ts"].map((f) => join(REPO, "office", "cli", f));
  const files = [join(PLUGIN, "README.md"), join(PLUGIN, "skills", "f1rm-guidelines", "SKILL.md"), ...Object.keys(ROLES).map((r) => join(PLUGIN, "agents", `${r}.md`)), ...cli];
  let seen = 0;
  for (const f of files) {
    // The code writes its backticks escaped (\`), so a few characters may sit around `f1rm pm`.
    for (const line of readFileSync(f, "utf8").split("\n").filter((l) => /`f1rm edition (work\|founder|work|founder)\\?`/.test(l))) {
      seen++;
      expect(line, f).toMatch(/(once|after) .{0,3}f1rm pm.{0,3} has registered the (project|repo)/);
    }
  }
  expect(seen).toBeGreaterThanOrEqual(4);
  expect(readFileSync(cli[0], "utf8")).toMatch(/after \\?`f1rm pm\\?` has registered the project/);
});

test("K7: a conflict round never counts toward ESCALATE; the review flow says so once and the Handoff line and reviewer.md point to it", () => {
  const rule = "A round whose only item is `CHANGES REQUESTED conflict` never counts toward ESCALATE. A round with a conflict and a blocking finding counts once, for the finding.";
  expect(/^4\. .*$/m.exec(section("Review and merge flow"))?.[0]).toContain(rule);
  expect(guidelines.split(rule)).toHaveLength(2);
  const line = /^ *- `ESCALATE <slug>`.*$/m.exec(section("Handoff via SendMessage"))?.[0] ?? "";
  expect(line).toContain("(see the review flow)");
  expect(line).not.toContain("only item");
  expect(role("reviewer").body).toMatch(/conflict round never counts[^\n]*review flow/);
  expect(role("reviewer").body).not.toContain("only item");
  expect(role("lead").body).not.toContain("only item");
  const titles = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1).map((e) => e.split("\n")[0]);
  expect(titles).toContain("2026-10-21 Conflict rounds do not count toward ESCALATE");
});

test("K6: docs/decisions.md has the Ask the user only for big decisions and Skill stack entries, the second recording why pstack skills are slash-only", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const titles = entries.map((e) => e.split("\n")[0]);
  for (const t of ["Ask the user only for big decisions", "Skill stack: mattpocock + pstack"]) expect(titles).toContain(`2026-10-21 ${t}`);
  const stack = entries.find((e) => e.startsWith("2026-10-21 Skill stack: mattpocock + pstack"))!;
  for (const s of ["disable-model-invocation", "architect", "interrogate", "arena", "swarm", "Opening a PR", "afk"]) expect(stack, s).toContain(s);
});
