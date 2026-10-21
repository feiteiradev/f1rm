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
  "frontend-dev": ["mattpocock-skills:tdd"],
  "backend-dev": ["mattpocock-skills:tdd"],
  reviewer: ["code-review", GUIDELINES, "ponytail:ponytail-review"],
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
  expect(pmPromptText()).toContain("Speak to me only for");
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
  for (const s of ["questions that need the user's decision", "a permission on a hire's desk", "spend, credentials or inputs", "a `git push`", "a dirty main checkout", "one end-of-milestone report", 'the user asks "status?"']) expect(talk, s).toContain(s);
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
  for (const s of ["questions that need the user's decision", "git push"]) expect(pm, s).toContain(s);
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
  expect(handoff).toMatch(/`ESCALATE <slug>` from the Reviewer in place of a third `CHANGES REQUESTED` \(see the review flow\)/);
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
