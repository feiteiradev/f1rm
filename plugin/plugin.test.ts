// The company plugin as shipped: role files, the guidelines skill, and a real `claude` install into a throwaway config.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const PLUGIN = import.meta.dir;
const REPO = join(PLUGIN, "..");

const GUIDELINES = "f1rm:f1rm-guidelines";
// research and security-review are slash commands: `f1rm hire --skills` or `--level high` brings them in, so no role lists them.
const ROLES: Record<string, string[]> = {
  pm: [],
  lead: [GUIDELINES, "f1rm:hire"],
  designer: ["design-pipeline"],
  "frontend-dev": ["pstack:poteto-mode", "mattpocock-skills:tdd"],
  "backend-dev": ["pstack:poteto-mode", "mattpocock-skills:tdd"],
  reviewer: ["code-review", GUIDELINES, "ponytail:ponytail-review", "mattpocock-skills:code-review"],
  researcher: ["mattpocock-skills:research"],
  advisor: ["mattpocock-skills:domain-modeling", "mattpocock-skills:research"],
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

test("f1rm merge fast-forwards the base only after the new tests fail on it and the suite passes on the merge, and never pushes", () => {
  const flow = section("Review and landing");
  expect(flow).toContain("merges the branch in a scratch worktree");
  expect(flow).toContain("`--ff-only`");
  expect(flow.indexOf("must fail")).toBeLessThan(flow.indexOf("`--ff-only`"));
  expect(flow).toContain("It never pushes");
  expect(flow).not.toContain("reset --hard");
  expect(role("reviewer").body).not.toContain("reset --hard");
  expect(role("reviewer").body).toContain("`f1rm merge`");
});

test("the guidelines cover every item the spec lists", () => {
  for (const h of [
    "Roster and hiring playbook",
    "Brief format",
    "Handoff via SendMessage",
    "Board format",
    "Review and landing",
    "Cap rule",
    "Definition of done",
  ]) {
    expect(section(h).trim().length).toBeGreaterThan(100);
  }
  expect(section("Handoff via SendMessage")).toContain("commits on the hire's worktree branch");
  expect(section("Review and landing")).toContain("Only the PM pushes, with `f1rm push`");
  expect(section("Review and landing")).toContain("`--ff-only`");
  expect(section("Cap rule")).toContain("No cap counts sessions, teams, members or interns");
  expect(section("Cap rule")).toMatch(/nobody asks the user, and `--override` is refused to every session/);
  expect(section("Definition of done")).toContain("`f1rm merge` has landed it");
});

test("the guidelines run teams: when to form them, the team brief, NEEDS YOU/DONE, who talks to whom, the caps, interns, team boards and installed skills", () => {
  for (const h of ["Teams", "Team brief", "Who talks to whom", "Interns", "Use what is installed"]) expect(section(h).trim().length).toBeGreaterThan(100);
  const teams = section("Teams");
  for (const s of ["Every topic is a team of its own", "No cap on live topics", "The user, or the PM on his request, starts a lead", "No nested teams", "`DONE <team>`"]) expect(teams).toContain(s);
  expect(section("Who talks to whom")).toContain("The user talks to each lead directly");
  expect(section("Who talks to whom")).toMatch(/lead .*messages the other leads directly/s);
  const caps = section("Cap rule");
  for (const s of ["No cap counts sessions, teams, members or interns", "**One specialist per task**"]) expect(caps).toContain(s);
  expect(caps).not.toContain("frees its slot"); // no team cap, so no idle member frees one
  expect(section("Interns")).toContain("No cap counts interns");
  expect(section("Board format")).toContain("~/.f1rm/boards/<repo>.team.<team>.md");
  expect(section("Use what is installed")).toContain("skills, slash commands and plugins");
});

test("the roster table names each hireable role with the commands `f1rm hire` loads", () => {
  const rows = [...section("Roster and hiring playbook").matchAll(/^\| `(\S+)` \| .*? \| (.+?) \|$/gm)];
  expect(rows.map((r) => r[1])).toEqual(Object.keys(ROLES));
  for (const [, name, cell] of rows) {
    const listed = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The PM is never hired, so its row lists only what `f1rm pm` loads. A Reviewer is hired with --content, which drops its code-review skills.
    const skills = name === "pm" ? ROLES[name].filter((s) => s !== GUIDELINES) : name === "reviewer" ? [GUIDELINES] : ROLES[name];
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
  researcher: ["research"],
};
// A Reviewer is hired with --content, which drops the code-review skills its role file lists.
const WORKFLOW_ROLE_SKILLS = (r: string) => (r === "reviewer" ? [GUIDELINES] : ROLES[r]);
const bare = (skill: string) => skill.split(":").pop()!;

test("the Workflows section has an entry for every role, naming its skills, and every skill it names is in a role file or the roster", () => {
  const flows = section("Workflows");
  const entries = flows.split(/^- \*\*/m).slice(1);
  for (const r of Object.keys(ROLES)) {
    const entry = entries.find((e) => e.startsWith(`${r}**`));
    expect(entry, `${r} has a Workflows entry`).toBeDefined();
    for (const s of [...WORKFLOW_ROLE_SKILLS(r), ...(WORKFLOW_SKILLS[r] ?? [])]) expect(entry!, `${r} names ${s}`).toContain(bare(s));
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
  const flow = section("Review and landing");
  for (const s of ["passes on the base proves nothing", "`ESCALATE <slug>`", "research a brief puts in the repo"]) expect(flow).toContain(s);
  expect(section("Teams")).toContain("`f1rm letgo");
  expect(section("Who talks to whom")).toContain("`BLOCKED <slug> permission`");
  expect(guidelines).toContain("Only the PM pushes, with `f1rm push`");
  const playbook = section("Roster and hiring playbook");
  for (const s of ["same task goes to the same session", "`review-<task>`", "previous `DONE` report", "what the user must provide"]) expect(playbook).toContain(s);
});

test("the guidelines say what each gate holds and the way out, and a cap refusal waits and asks nobody", () => {
  const gates = section("Gates");
  for (const s of ["skill gate", "delegation gate", "boards, milestones, kept files, memory, evidence and scratch", "`f1rm:*`", "load the skills", "security-review"]) expect(gates).toContain(s);
  const skillGate = gates.split("\n").find((l) => l.includes("**skill gate**")) ?? "";
  for (const s of ["Only a session's first prompt arms it", "a later message that quotes that prompt's skill list changes nothing", "resumed with its own id is not armed again", "A woken session (`f1rm wake`) is a new session whose first prompt is the wake note", "names no skills to load (its history has them)", "A Reviewer session started before the Reviewer became content-only may still carry the security sentence in its first prompt", "a content Reviewer carries none", "a skill the Skill tool refuses counts as tried, read from the session's own transcript", "disable-model-invocation, go on without that skill", "Unknown skill, go on and send `BLOCKED <slug>`"]) expect(skillGate, s).toContain(s);
  const cap = section("Cap rule");
  expect(cap).toMatch(/wait for a free slot and ask nobody/);
  expect(cap).not.toMatch(/tells? the (PM|user)/);
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

test("both READMEs and the hire skill say no cap counts sessions, and never state a machine cap", () => {
  const texts = [join(REPO, "README.md"), join(PLUGIN, "README.md"), join(PLUGIN, "skills", "hire", "SKILL.md")].map((f) => readFileSync(f, "utf8"));
  expect(texts[0]).toContain("No cap counts sessions, teams or interns");
  expect(texts[1]).toContain("no cap counts sessions, teams or members");
  expect(texts[2]).toContain("No cap counts sessions, teams or members");
  expect(parts(join(PLUGIN, "skills", "hire", "SKILL.md")).fm.description).toContain("waits on a usage hold");
  for (const t of [...texts, guidelines]) expect(t).not.toMatch(/\b(6|six|8|eight|30|thirty) (background|working) sessions/);
  expect(guidelines).not.toMatch(/cap of 30/);
});

test("fewer sessions: the guidelines name the check lock, send roles to bun run check for the full suite and never two at once", () => {
  const runs = section("Handoff via SendMessage");
  for (const s of ["`bun run check`", "per-repo lock", "every worktree of the repo", "never run two", "waits", "prints who holds it", "`bun test <file>`"]) expect(runs, s).toContain(s);
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  const entry = log.split(/^## /m).find((e) => e.startsWith("2026-10-23 Fewer sessions")) ?? "";
  expect(entry).toMatch(/- Decision: .*cap.*8.*lock/s);
  expect(entry).toContain("fewer-sessions, ");
  expect(log.split(/^## /m).find((e) => e.startsWith("2026-10-19 Machine cap")) ?? "").toMatch(/\n- Superseded: [^\n]*Fewer sessions/);
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
  expect(/Skills \(\d+\)\s+(.*)/.exec(details.out)?.[1].split(", ").sort()).toEqual(["f1rm-guidelines", "hire", "resume-all", "stop-all"]);
  expect(details.out).toMatch(/Agents \(14\)\s+\S/);
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


test("the playbook gives the real `f1rm hire` syntax, and the override is refused to a session", () => {
  const playbook = section("Roster and hiring playbook");
  expect(playbook).not.toContain("f1rm hire lead lead-<team>"); // the PM starts a lead only as a topic lead
  expect(playbook).toContain('f1rm hire --topic lead lead-<topic> <topic> "<brief>"');
  expect(playbook).toContain('f1rm hire --team <team> <role> <team>.<role>-<task> <task> "<brief>"');
  expect(playbook).not.toContain("--help");
  expect(section("Cap rule")).toContain("`--override` is refused to every session");
  expect(section("Brief format")).not.toMatch(/^Report to:/m);
});

test("the guidelines state the milestones file and the decisions log, and the places where the rules bite mention them", () => {
  const md = section("Milestones and decisions");
  for (const s of ["~/.f1rm/milestones/<repo>.md", "encoded exactly as the board path", "# Milestones: <repo name>", "## <milestone slug>", "Goal", "Settled", "Tasks", "Done when", "Only the PM writes it", "when the user confirms the plan", "at pickup", "replaces the section with a 5-line record", "Task status stays on the board"]) expect(md, s).toContain(s);
  for (const s of ["`docs/decisions.md`", "a feature or behaviour the user chose", "a refactor or architecture choice", "a cap, limit, dependency or version change", "anything rejected for a reason", "Bug fixes and wording tweaks get no entry", "append-only, oldest first", "## <YYYY-MM-DD> <title>", "`- Decision:`", "`- Why:`", "`- Rejected:`", "`- Where:`", "docs/decisions.md has the entry <title>", "a missing entry blocks", "`docs/adr/`", "links to the ADR"]) expect(md, s).toContain(s);
  expect(section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))).toContain("milestones file");
  expect(section("Brief format")).toContain("docs/decisions.md");
  expect(section("Review and landing")).toContain("docs/decisions.md");
});

test("a lead has an advisor test a core decision against the why before it asks the user or takes its own option, and a STRAINS or BREAKS verdict goes to the user", () => {
  const rule = section("Who talks to whom").split("\n").find((l) => l.includes("**An advisor tests each core decision first.**")) ?? "";
  for (const s of ["Before a lead sends the user a round that holds a core decision", "before it takes its own recommended option on a core decision", "one advisor `test` task into its team for all those items of the round", "a product, design or business choice", "word for word", "STRAINS or BREAKS", "STOP or ASK FIRST", "asks the user that item instead", "Technical choices (the lead's own call)", "never the recommendation itself", "the lead writes the answer in that item's row"]) expect(rule, s).toContain(s);
  expect(rule).not.toMatch(/feit|Pedro/);
  const lead = role("lead").body;
  for (const s of ["one advisor `test` task", "a product, design or business choice", "STRAINS or BREAKS", "STOP or ASK FIRST", "when the user has told you to take your recommended options"]) expect(lead, s).toContain(s);
  expect(role("advisor").body).not.toContain("unless the brief asks for a `docs/decisions.md` entry"); // it commits nothing
  const advisor = role("advisor");
  expect(String(advisor.fm.tools).split(/,\s*/)).not.toContain("Edit"); // it changes no file of the repo
  for (const s of ["`why`", "`test`", "~/.f1rm/kept/<repo>/advisor/why.md", "~/.f1rm/kept/<repo>/advisor/ledger.md", "FITS | STRAINS | BREAKS", "Never hire or start a session", "`<team>.advisor-<task>`"]) expect(advisor.body, s).toContain(s);
  expect(advisor.body).not.toMatch(/feit|Pedro|Hired by the PM/);
});

test("the lead and the Reviewer carry their part of the decisions log", () => {
  expect(role("lead").body).toContain("docs/decisions.md has the entry");
  expect(role("reviewer").body).toMatch(/every `docs\/decisions\.md` entry the brief asks for.*blocks/);
});

const SPECIALISTS = ["designer", "frontend-dev", "backend-dev", "researcher", "advisor", "marketer", "seo-specialist", "social-media", "sales", "strategist"];
const cliSource = () => readFileSync(join(REPO, "office", "cli", "f1rm.ts"), "utf8");
const pmPromptText = () => /const pmPrompt[\s\S]*?`;/.exec(cliSource())![0];

test("B1: no line says a specialist reports to the PM or that the PM lets specialists go", () => {
  const stale = [/otherwise the PM/, /the PM or the team's lead/, /the PM or your team's lead/, /your team's lead, or the PM/, /the PM, or its team's lead/, /the specialists, the PM or/];
  const texts = [guidelines, readFileSync(join(PLUGIN, "README.md"), "utf8"), readFileSync(join(REPO, "README.md"), "utf8"), ...Object.keys(ROLES).filter((r) => r !== "pm" && r !== "lead").map((r) => role(r).body)];
  for (const t of texts) for (const re of stale) expect(t).not.toMatch(re);
  expect(section("Who talks to whom")).toContain("A specialist reports only to the session in its `Report to`, its team's lead (the PM for a simple task), and messages only who the Messaging table allows.");
  expect(section("Who talks to whom")).not.toContain("another specialist");
  expect(section("Handoff via SendMessage")).toContain("A hire reports to the session in its `Report to` and messages only who the Messaging table allows.");
  expect(section("Handoff via SendMessage")).not.toContain("another hire");
  expect(section("Review and landing")).toContain("the PM (a simple task) or the team's lead marks the task's row `done` and lets the session go with `f1rm letgo <name>...`");
  for (const r of ["designer", "frontend-dev", "backend-dev", "reviewer", "researcher", ...SPECIALISTS]) expect(role(r).body, r).toMatch(/Report only to the session in your `Report to`: your team's lead( \(the PM on a simple task\))?\. Message only who the Messaging table in the guidelines allows\./);
});

test("three gates, the README's hiring line, and the content checklist match the new rules", () => {
  expect(section("Gates")).toContain("With the office stopped, none runs.");
  expect(section("Gates")).not.toContain("neither runs");
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  expect(readme).toContain("You talk to the PM, which starts a team lead for each piece of work you ask for.");
  expect(readme).not.toContain("The PM hires the rest.");
  for (const text of [section("Review and landing"), role("reviewer").body]) {
    expect(text).toContain("research a brief puts in the repo");
    expect(text).not.toContain("docs/research/");
  }
});

// R8b: the PM picks the workflow by rule, the user talks to each lead, PLAN and GO are gone, and two tables carry what the gate enforces.
const WORKFLOW_FILES = () => ({
  guidelines,
  prompt: pmPromptText(),
  "plugin README": readFileSync(join(PLUGIN, "README.md"), "utf8"),
  README: readFileSync(join(REPO, "README.md"), "utf8"),
  hire: readFileSync(join(REPO, "office", "cli", "hire.ts"), "utf8"),
  ...Object.fromEntries(Object.keys(ROLES).map((r) => [`${r}.md`, role(r).body])),
});

test("R8b: a spend is a big decision that reaches the user through the lead, not a PM relay", () => {
  expect(section("Drafts only")).toContain("the lead asks the user for each spend as Who talks to whom says, records the answer on its team board and passes it down");
  expect(section("Drafts only")).not.toContain("the PM asks the user for each spend");
  expect(role("pm").body).not.toContain("Ask the user before any spend");
  expect(role("researcher").body).not.toContain("through the PM");
});

test("R8b: the hire skill says a cap refusal waits for a slot, asks nobody and refuses --override", () => {
  const skill = readFileSync(join(PLUGIN, "skills", "hire", "SKILL.md"), "utf8");
  expect(skill).toContain("it asks nobody, and `--override` is refused to every session");
  expect(skill).not.toContain("Only the PM asks the user");
});

test("R8b: the plugin README says the PM tells the user which lead needs them", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  expect(readme).toContain("the PM tells you which lead needs you");
  expect(readme).not.toContain("in the words");
});

test("R8b: the guidelines hold a Spawning table and a Messaging table, each cell marked enforced or rule only, matching the gate", () => {
  const rowsOf = (md: string, head: string) => md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith(head) && !l.startsWith("| :-"));
  const spawn = section("Spawning table");
  expect(spawn).toContain("| Role | `f1rm hire` | Sub-agents | `/loop` and `/schedule` | Background shell watchers | `claude --bg` and `claude -p` |");
  const srows = rowsOf(spawn, "| Role");
  expect(srows.map((r) => r.split("|")[1].trim())).toEqual(["PM", "Lead", "Specialist or Reviewer", "Intern"]);
  for (const r of srows) {
    const cells = r.split("|").slice(2, -1);
    expect(cells, r).toHaveLength(5);
    for (const c of cells) expect(c, `${r} :: ${c}`).toMatch(/\((enforced|rule only)[;:) ]/);
  }
  const held = "enforced for a specialist's or a Reviewer's intern; a PM's or a lead's intern is held to its parent's row (enforced), so what its parent may do passes (rule only)";
  expect(srows[3].split("|")[2]).toContain(held);
  expect(srows[3].split("|")[6]).toContain(held);
  expect(srows[0]).toContain("Leads only (enforced), and the legacy `--simple`, which the gate still passes and the PM no longer uses (rule only)");
  expect(srows[1]).toContain("of its own team, never a dev or a lead (enforced)");
  expect(srows[2]).toContain("Nothing (enforced)");
  expect(spawn).not.toContain("At most 2");
  for (const s of ["No cap", "never an `f1rm:*` role", "Never (enforced)", "`--bg --resume`", "temporary HOME", "bash -c", "not parsed"]) expect(spawn, s).toContain(s);
  expect(srows[2].split("|")[5]).toContain("rule only");
  const talk = section("Messaging table");
  expect(talk).toContain("| Sender | May message | Message types | When | Why |");
  const trows = rowsOf(talk, "| Sender");
  expect(trows.map((r) => r.split("|")[1].trim())).toEqual(["The user", "PM", "Lead", "Team member", "Simple task's dev", "Intern", "Anyone", "Anyone, to an ended hire"]);
  for (const r of trows.slice(1, 6)) {
    const cells = r.split("|").slice(2, -1);
    expect(cells, r).toHaveLength(4);
    expect(r, r).toContain("enforced");
    expect(r, r).toContain("rule only");
  }
  expect(trows[0]).toContain("Ask");
  expect(trows[0]).toContain("Tell");
  expect(trows[0]).toContain("(a lead records it on its team board)");
  expect(trows[1]).toContain("Leads of its project only (enforced)");
  expect(trows[1]).not.toContain("simple tasks' devs");
  for (const s of ["`NEEDS YOU <team>: <topic>`", "`DONE <team>`", "`resume`"]) expect(talk, s).toContain(s);
  expect(trows[2]).toContain("The PM, other leads and the members of its own team");
  expect(trows[3]).toContain("`DONE`, `APPROVED`, `CHANGES REQUESTED`, `BLOCKED`, `ESCALATE`");
  expect(trows[3]).toContain("only to its lead");
  expect(trows[4]).toContain("The PM only, its reports included (enforced)");
  expect(trows[5]).toContain("parent session");
  expect(trows[6]).toContain("enforced");
  expect(trows[6]).toContain("A team member never messages another team; leads message each other");
  expect(trows[6]).not.toContain("Never another team");
  expect(trows[6]).toContain("another team");
  expect(trows[6]).toContain("another project");
  expect(trows[6]).toContain("Elsewhere is no room");
  expect(talk).toContain("rule only");
});

test("R8b: docs/decisions.md has the entries PM picks the workflow and Who talks to whom", () => {
  const titles = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1).map((e) => e.split("\n")[0]);
  for (const t of ["PM picks the workflow", "Who talks to whom"]) expect(titles).toContain(`2026-10-22 ${t}`);
});

test("C1: f1rm merge sends a conflict or a moved tip back to the dev, who rebases and sends a new DONE", () => {
  const flow = section("Review and landing");
  for (const s of ["a conflict", "\"tip moved\"", "`CHANGES REQUESTED <slug> conflict`"]) expect(flow, s).toContain(s);
  const handoff = section("Handoff via SendMessage");
  for (const s of ["`CHANGES REQUESTED <slug> conflict`", "rebases its unpushed branch onto the current main", "\"tip moved\""]) expect(handoff, s).toContain(s);
  expect(handoff).not.toContain("`BLOCKED <slug> tip moved`");
  for (const name of SPECIALISTS) expect(role(name).body, name).toContain("`CHANGES REQUESTED <slug> conflict`");
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
  expect(entries.find((e) => e.startsWith("2026-10-22 A refused skill counts as tried"))).toContain("`security-review` is never taken from a try");
  // An entry a later one overrides may end with one `- Superseded:` line; its other lines stay as written.
  for (const e of entries) expect(e.split("\n").filter((l) => l.trim()).slice(1).filter((l) => !l.startsWith("- Superseded: ")).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

test("the guidelines say once that every hire but a lead starts at ponytail full, and the decision is logged", () => {
  const rule = "`f1rm hire` starts every hire but a lead at ponytail `full`";
  expect(guidelines.split(rule)).toHaveLength(2);
  expect(guidelines).toContain("A lead keeps the config default");
  expect(guidelines).toContain("`f1rm wake` keeps the level");
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  expect(log.split("## 2026-10-23 Ponytail full for workers")).toHaveLength(2);
});

const LEAN_ENTRY = "2026-10-23 Lean review and test runs";
const NON_BLOCKING = "Non-blocking (for the batch task)";

test("lean review: only blocking findings go back, the rest wait for one batch task", () => {
  const flow = section("Review and landing");
  const step2 = /^2\. .*$/m.exec(flow)?.[0] ?? "";
  for (const s of ["blocking or non-blocking", "a wrong or missing behaviour against the brief, a bypass or security hole, a false positive in a main flow, or a test that does not test what it claims", "a wording nit, a style point, a hypothetical edge or a cleanup is not"]) expect(step2, s).toContain(s);
  for (const s of ["with the blocking findings only", NON_BLOCKING, "At most 2 blocking rounds per branch", "`ESCALATE <slug>`"]) expect(flow, s).toContain(s);
  // The guidelines state each rule once, in Review and landing; the other places point to it.
  for (const s of ["wrong or missing behaviour", "At most 2 blocking rounds per branch"]) expect(guidelines.split(s).length - 1, s).toBe(1);
  const handoff = section("Handoff via SendMessage");
  expect(handoff).toMatch(/`CHANGES REQUESTED <slug>` from a content Reviewer, then the blocking findings with file and line/);
  expect(handoff).toMatch(/`ESCALATE <slug>` from a content Reviewer in place of a third blocking round \(see Review and landing\)/);
  const teams = section("Teams");
  for (const s of ["copies the non-blocking ones to `~/.f1rm/kept/<repo>/findings.md`", "runs one batch task for the non-blocking findings", "a normal task through the same flow", "skips it, and says so in its `DONE <team>`, when the list is empty or the user says to leave them", "each finding as `fixed` or `left`"]) expect(teams, s).toContain(s);
  const reviewer = role("reviewer").body;
  for (const s of [NON_BLOCKING, "the blocking findings", "Review and landing"]) expect(reviewer, s).toContain(s);
  const lead = role("lead").body;
  for (const s of [NON_BLOCKING, "batch task", "`ESCALATE <slug>`", "with blocking findings goes back to its implementer, designer or researcher"]) expect(lead, s).toContain(s);
  const pm = role("pm").body;
  expect(pm).not.toContain("only blocking findings"); // the leads own the findings now
  for (const f of ["README.md", join("plugin", "README.md")]) expect(readFileSync(join(REPO, f), "utf8"), f).toContain("batch task");
  // No old wording survives anywhere a role reads.
  const old = /every (`\/code-review` )?finding|blocking or not|minor findings|reruns? (its|your) checks|follow-up branch|merge first|fix(ed)? (them )?later/i;
  for (const [name, text] of Object.entries({ guidelines, reviewer, lead, pm })) expect(text, name).not.toMatch(old);
});

test("lean review: the dev runs the suite once per round and records it; the PM or owner checks the record; f1rm merge runs the new tests on the base and the suite once on the merge", () => {
  const handoff = section("Handoff via SendMessage");
  for (const s of ["**Test runs.**", "once per round, on its final commit", "`{commit, exit code, pass/fail counts}`", "`check-record.json`", "its `DONE` names the file", "runs the suite once more and records again", "checks the record against the branch tip (same commit, exit 0) and does not rerun the suite", "`f1rm merge` runs only the new tests on the base (red) and the full suite once on the merge"]) expect(handoff, s).toContain(s);
  for (const s of ["{commit, exit code, pass/fail counts}", "does not rerun the suite"]) expect(guidelines.split(s).length - 1, s).toBe(1);
  expect(handoff).not.toContain("the full check command and its exit code");
  const flow = section("Review and landing");
  for (const s of ["runs the branch's new tests on the base, where they must fail", "runs the full suite once on the merge"]) expect(flow, s).toContain(s);
  const teams = section("Teams");
  expect(teams).toContain("its check record (see Test runs in Handoff)");
  expect(section("Workflows")).not.toMatch(/rerun/);
  const lead = role("lead").body;
  expect(lead).toContain("its check record");
  expect(lead).not.toMatch(/rerun its checks/);
  for (const name of ["backend-dev", "frontend-dev"]) {
    const { body } = role(name);
    for (const s of ["once per round, on your final commit", "`check-record.json`", "Test runs in the guidelines"]) expect(body, `${name} ${s}`).toContain(s);
    expect(body, name).not.toMatch(/rerun your checks/);
  }
  for (const name of SPECIALISTS) expect(role(name).body, name).not.toMatch(/rerun your checks/);
  expect(role("reviewer").body).not.toMatch(/full check command|new tests only|red-<task>/);
});

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

test("the plugin README names both documents", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  expect(readme).toContain("~/.f1rm/milestones/<repo>.md");
  expect(readme).toContain("docs/decisions.md");
});

test("P3: a hire that creates the decisions log adds its merge=union line to .gitattributes, and nobody resolves a conflict by hand", () => {
  const md = section("Milestones and decisions");
  for (const s of ["the decisions log file, whatever its path", "`<that path> merge=union`", ".gitattributes", "a line of its own"]) expect(md, s).toContain(s);
  expect(md).toContain("docs/decisions.md merge=union");
  expect(md).toContain("Nobody resolves a conflict by hand: `f1rm merge` sends it back to the dev.");
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
  const refusals = "any `pstack:` skill other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only) is refused";
  for (const text of [readme, readFileSync(join(REPO, "README.md"), "utf8")]) expect(text).toContain(refusals);
  expect(readme).not.toContain("made and logged for you");
  expect(readme).toContain("technical choices are made by the PM or the lead, and the hires log the core ones");
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

test("K3a: a topic lead's first command is the grilling interview, and it loads the guidelines and f1rm:hire with the Skill tool", () => {
  const step1 = /^1\. \*\*Load the rules\.\*\*.*$/m.exec(role("lead").body)?.[0] ?? "";
  for (const s of ["has the grilling interview as its first command", "with the Skill tool"]) expect(step1, s).toContain(s);
});

test("K3b: a lead sketches a contract itself or sends a Haiku Explore intern, and the PM is not a route to a first command", () => {
  const step3 = /^3\. \*\*Plan\.\*\*.*$/m.exec(role("lead").body)?.[0] ?? "";
  expect(step3).toContain("sketch it yourself from the files or send a Haiku Explore intern");
  for (const s of ["tell the PM", "hires you again", "A running lead cannot gain a first command"]) expect(step3, s).not.toContain(s);
  expect(guidelines).not.toContain("which the PM names with `--skills pstack");
  expect(guidelines).not.toContain("when the PM started you");
});

test("K3c: the Skill stack's Review row names the dev's one review subagent, and a content Reviewer reads against worktree-<task>", () => {
  expect(section("Skill stack")).toContain("the dev's one review subagent runs the `code-review` skill on its diff, and `security-review` at `--level high`");
  expect(role("reviewer").body).toContain("`git diff <base>...worktree-<task>`");
  expect(role("reviewer").body).toContain("so your first command is `/f1rm:f1rm-guidelines`");
});

test("K4: the guidelines hold a Skill stack table: phase, mattpocock skill, pstack skill, the f1rm rule that wins, and what never runs inside a hire", () => {
  const md = section("Skill stack");
  expect(md).toContain("| Phase | mattpocock skill | pstack skill | Rule that wins |");
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Phase") && !l.startsWith("| :-"));
  expect(rows.length).toBeGreaterThanOrEqual(6);
  for (const r of rows) expect(r.split("|").length, r).toBe(6); // four cells
  for (const s of [
    "`mattpocock-skills:grilling`", "`mattpocock-skills:tdd`", "`mattpocock-skills:diagnosing-bugs`", "`code-review`", "`pstack:poteto-mode`", "`pstack:architect`", "`pstack:how`", "`pstack:interrogate`",
    "`feature`, `bug-fix`, `refactoring`, `perf-issue`", "slash-only", "disable-model-invocation", "the user can run it by hand",
  ]) expect(md, s).toContain(s);
  for (const s of ["no PR opening", "no babysit loops", "no `/loop` ticks", "no `afk`", "`pstack:arena` and `pstack:swarm` are not wired inside hires", "interns only for independent subtasks (see Interns)", "only the PM pushes, with `f1rm push`"]) expect(md, s).toContain(s);
  // arena and swarm can't be run inside a hire (the Skill tool refuses them): the Parallel work row says the user runs them by hand, and a brief never asks for them.
  expect(rows.find((r) => r.startsWith("| Parallel work"))).toContain("Not wired inside hires (the Skill tool refuses them); the user can run them by hand");
  expect(md).not.toContain("when a brief asks");
  // Every pstack skill but its setup skill carries disable-model-invocation, so `f1rm hire` refuses all the others in --skills; a lead learns it before the refusal.
  const rule = "refuses any `pstack:` skill in `--skills` other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only)";
  expect(md).toContain("Every pstack skill but its setup skill carries `disable-model-invocation`");
  expect(md).toContain(`\`f1rm hire\` ${rule}`);
  const bullet = /^   - `--skills a,b`.*$/m.exec(section("Roster and hiring playbook"))?.[0] ?? "";
  for (const s of [rule, "`pstack:poteto-mode` (devs only)"]) expect(bullet, s).toContain(s);
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

test("K7: a conflict is no blocking round: f1rm merge sends it back to the dev, and the ESCALATE line points to Review and landing", () => {
  const line = /^ *- `ESCALATE <slug>`.*$/m.exec(section("Handoff via SendMessage"))?.[0] ?? "";
  expect(line).toContain("(see Review and landing)");
  expect(line).not.toContain("only item");
  expect(section("Review and landing")).toContain("It goes back to the dev as `CHANGES REQUESTED <slug> conflict`");
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

// R9a: `f1rm wake` resumes an ended hire in place; the gate says so when a message goes to one with no live process.
test("W1: the guidelines name `f1rm wake` once in Watching and waking, and the Ended rule wakes instead of letting go and re-hiring", () => {
  const w = section("Watching and waking");
  for (const s of [
    "**No live session**", "no live session; f1rm wake <name>", "`f1rm wake <name> \"<the message you meant to send>\"`", "resumes that hire in place", "from its own worktree", "with its history, name and `Report to`",
    "`resumed; continue your task`", "new session id", "runs the hire checks and waits on a usage hold like a hire", "refuses a hire that was let go, another project's hire, a live one (message it instead) and an unknown name",
    "The PM wakes leads and its simple tasks' devs, and a lead wakes the members of its own team (enforced); a specialist wakes nobody.",
    "**Ended**: the office wakes it within a minute", "a NOTE that says the office could not wake it (or that it stopped again) means you run `f1rm wake <name>`", "Re-hire only a hire that was let go or whose wake failed",
    "**Address a woken or re-hired session**",
  ]) expect(w, s).toContain(s);
  expect(w).not.toContain("**Ended**: run `f1rm letgo");
  expect(w.split("no live session; f1rm wake <name>").length - 1).toBe(1); // said once
  expect(section("Teams")).toMatch(/sends the work back to the same specialist[^\n]*\*\*No live session\*\* in Watching and waking/);
});

test("W2: the Spawning table names `f1rm wake` as the wrapper of `claude --bg --resume`, the Messaging table and the gates carry the refusal row", () => {
  const spawn = section("Spawning table");
  expect(spawn).toMatch(/`claude --bg --resume[^\n]*`f1rm wake` is the sanctioned wrapper/);
  expect(spawn).toContain("who may wake is in **No live session** in Watching and waking");
  expect(guidelines.split("a specialist wakes nobody").length - 1).toBe(1); // the who-may-wake rule is said once, in **No live session**
  const talk = section("Messaging table");
  const row = talk.split("\n").find((l) => l.startsWith("| Anyone, to an ended hire"))!;
  expect(row).toContain("no live process");
  expect(row).toContain("`no live session; f1rm wake <name>`");
  expect(row).toContain("(enforced)");
  expect(row).toContain("`name [ref]`");
  const gates = section("Gates");
  expect(gates).toContain("a hire of the project with no live process");
  expect(gates).toContain("`f1rm wake` follows the hire rules (**No live session** in Watching and waking)");
  expect(gates).toMatch(/with no live process \(way out: \*\*No live session\*\* in Watching and waking\)/);
  expect(gates).not.toContain("else ask your lead");
  expect(gates).toContain("A specialist cannot run `f1rm hire`, `f1rm wake` or `f1rm merge`");
});

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
const hireSkill = () => readFileSync(join(PLUGIN, "skills", "hire", "SKILL.md"), "utf8");
const pmDecides = () => /const PM_DECIDES =\s*("[^\n]*");/.exec(readFileSync(join(REPO, "office", "server", "server.ts"), "utf8"))![1];

test("flat: a dev reviews its own branch inside its session, once, and a second blocking round is ESCALATE", () => {
  const flow = section("Review and landing");
  for (const s of [
    "**Review inside the session.**", "ONE review in a fresh context", "general-purpose subagent", "`code-review` skill", "`git diff <base>...HEAD`", "`security-review`", "`--level high`",
    "so tell the subagent to read the diff itself", "Fix the blocking findings ONCE", "~/.f1rm/kept/<repo>/findings.md", "| date | area | status | finding | evidence |",
    "If a second review would still have blocking findings, do not fix again: send `ESCALATE <slug>`", "never delegates the implementation", "at least one failing test", "`f1rm merge` does not land it",
    "The `DONE` states the review round count and the review level",
  ]) expect(flow, s).toContain(s);
  for (const r of ["frontend-dev", "backend-dev"]) {
    const body = role(r).body;
    for (const s of ["Review inside your session", "Review and landing in the guidelines", "`ESCALATE <slug>`", "never delegate the implementation", "the review round count and level", "at least one failing test"]) expect(body, `${r}: ${s}`).toContain(s);
    expect(body, r).not.toContain("Leave merging to the Reviewer");
    expect(body, r).toContain("`f1rm merge`");
  }
  expect(section("Handoff via SendMessage")).toContain("`NEEDS YOU <slug>`");
  expect(section("Handoff via SendMessage")).toContain("review round count");
  expect(section("Roster and hiring playbook")).toContain("`--level low|medium|high` sets the level of a dev's own review");
});

test("flat: only f1rm merge lands on the base branch, and the content Reviewer does not merge", () => {
  const flow = section("Review and landing");
  for (const s of ["**Landing.**", "Only `f1rm merge <task>` lands on the base branch", "the PM (a simple task) or the owner (a milestone)", "a main with uncommitted changes", "no `DONE` report", "\"tip moved\"", "a conflict", "code without tests", "a branch that changes how the suite runs", "must fail", "the full suite once", "`--ff-only`", "never pushes"]) expect(flow, s).toContain(s);
  expect(section("Gates")).toContain("Only `f1rm merge` lands on the base branch");
  expect(section("Definition of done")).toContain("`f1rm merge`");
  expect(section("Definition of done")).not.toContain("Reviewer has signed off");
  expect(flow).toContain("**Content review.**");
  expect(flow).toContain("does not merge");
  const rev = role("reviewer");
  expect(String(rev.fm.description)).not.toMatch(/merge/);
  for (const s of ["`--content`", "content checklist", "does not merge", "`f1rm merge`"]) expect(rev.body, s).toContain(s);
  expect(rev.body).not.toMatch(/--ff-only|--no-ff|\/code-review|reset --hard/);
});

test("flat: owners run implementer subagents, plan once, approve their own plan, and cannot hire devs", () => {
  const teams = section("Teams");
  for (const s of ["implementer subagents", "`implement-spec`", "plans once", "approves its own plan", "product, design or business choice", "runs the implementers of independent tasks in parallel", "its own worktree", "`worktree-<task>`", "`f1rm merge <task>`", "cannot hire a frontend-dev or a backend-dev"]) expect(teams, s).toContain(s);
  const lead = role("lead").body;
  for (const s of ["implementer subagent", "Plan once", "approve your own plan", "`f1rm merge", "never a dev", "`implement-spec`"]) expect(lead, s).toContain(s);
  expect(lead).not.toContain("`NEEDS YOU <team>: plan`");
  expect(section("Spawning table").split("\n").find((l) => l.startsWith("| Lead"))).toContain("never a dev or a lead (enforced)");
  expect(section("Roster and hiring playbook")).toContain("never a dev");
  expect(section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("lead**"))).toContain("implementer");
});

test("flat: a simple task whose DONE has no landable commit is checked by the PM and let go without f1rm merge", () => {
  expect(pmPromptText()).not.toContain("without running f1rm merge"); // the scribe lands nothing
  expect(section("Teams")).toContain("`git worktree remove` and `git branch -d`");
  for (const s of ['`isolation: "worktree"`', "`/usr/bin/git checkout --detach main`", "`/usr/bin/git checkout -b worktree-<task>`", "never runs `git merge`"]) expect(section("Teams"), s).toContain(s);
  expect(section("Teams")).not.toContain("git worktree add -b");
  for (const s of ['`isolation: "worktree"`', "`/usr/bin/git`"]) expect(role("lead").body, s).toContain(s);
  expect(section("Review and landing")).toContain("a branch must descend from main's current tip");
  expect(section("Definition of done")).toContain("the PM's own check against the brief and the content checklist");
  expect(section("Review and landing")).not.toContain("as before");
  expect(section("Messaging table")).not.toContain("back to a dev");
  expect(role("lead").body).not.toContain("back to its dev");
  expect(pluginReadme()).toContain("its simple tasks' devs");
});

test("flat: the plugin is 0.8.0 everywhere it is repeated, and docs/decisions.md has the Flat workflow entry", () => {
  expect(JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.8.0");
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const flat = entries.find((e) => e.startsWith("2026-10-28 Flat workflow\n")) ?? "";
  for (const s of ["f1rm hire --simple", "f1rm merge", "implementer", "plan once", "baseline-2026-10.md", "11099a6", "f517e70", "flat-prose"]) expect(flat, s).toContain(s);
});

// no-user-commands: no session hands the user a command or asks him outside the five things that are his.
const commandFree = () => ({
  guidelines,
  "hire skill": hireSkill(),
  README: readFileSync(join(REPO, "README.md"), "utf8"),
  "plugin README": pluginReadme(),
  "PM prompt": pmPromptText(),
  ...Object.fromEntries(Object.keys(ROLES).map((r) => [`${r}.md`, role(r).body])),
});

test("NUC1: the guidelines, role files and hire skill never hand the user a command or ask him to run, push or approve exceeding a cap", () => {
  const banned = ["with `!`", "run it with !", "Ask the user to run", "the user pushes", "ending with the `git push` line", "wait or exceed", "exceed the cap", "exceeding a cap", "approves exceeding", "land it by hand with the user", "hand the user", "cleanup you approve", "comes to you as"];
  for (const [name, text] of Object.entries(commandFree())) {
    for (const s of banned) expect(text, `${name}: ${s}`).not.toContain(s);
    for (const line of text.split("\n")) if (line.includes("--override")) expect(line, `${name}: --override only in a sentence saying it is refused`).toMatch(/refus/);
  }
});

test("NUC2: the cap rule makes a refused hire wait and asks nobody; push, plan approval, cleanup and the report are the company's", () => {
  const cap = section("Cap rule");
  for (const s of ["wait for a free slot", "ask nobody", "exit 75", "run the same command again", "`run_in_background`", "`timeout` 600000", "`--override` is refused", "One specialist per task"]) expect(cap, s).toContain(s);
  for (const s of ["NEEDS YOU <team>: cap", "tells the user why"]) expect(cap, s).not.toContain(s);
  const land = section("Review and landing");
  for (const s of ["Only the PM pushes, with `f1rm push`", "fast-forward only", "never force", "not pushed: origin moved", "--check", "remembered per project", "--no-red", "calls.md"]) expect(land, s).toContain(s);
  const teams = section("Teams");
  for (const s of ["approves its own plan", "product, design or business choice", "calls.md"]) expect(teams, s).toContain(s);
  const ms = section("Milestones and decisions");
  for (const s of ["The PM decides Persist and Delete itself", "before the report", "needs no reply"]) expect(ms, s).toContain(s);
  expect(ms).not.toContain("only after the user replies");
  const gates = section("Gates");
  for (const s of ["`--settings`", "`--allowedTools`", ".claude/settings"]) expect(gates, s).toContain(s);
});

test("NUC4: the README and the decisions log carry the new rules", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  for (const s of ["| `f1rm push` |", "`--no-red`", "`--check`", "waits for a free slot", "Commands for <project>", "approves its own plan"]) expect(readme, s).toContain(s);
  expect(readme).not.toContain("Only you push");
  expect(readme).not.toContain("asks you to approve the plan");
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const nuc = entries.find((e) => e.startsWith("2026-11-02 No commands for the user\n")) ?? "";
  for (const s of ["- Decision:", "f1rm feedback", "- Why:", "- Rejected:", "- Where: no-user-commands"]) expect(nuc, s).toContain(s);
  const interview = entries.find((e) => e.startsWith("2026-11-02 Interview asks at most three scope questions\n")) ?? "";
  for (const s of ["spec-kit", "Assumptions", "- Rejected:"]) expect(interview, s).toContain(s);
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

test("the README and the plugin README say where the user stops and resumes every project, and the guidelines pin it once", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  for (const s of ["**Stop all and resume all.**", "`f1rm pause --all`", "`f1rm resume --all`", "/f1rm:stop-all", "/f1rm:resume-all", "Stop all / Resume all button", "top bar", "the office never pauses or resumes a project by itself"]) expect(readme, s).toContain(s);
  expect(readme.split("**Stop all and resume all.**").length).toBe(2);
  expect(readme).not.toContain("for your terminal only");
  expect(pluginReadme()).toContain("/f1rm:stop-all");
  expect(guidelines.split("/f1rm:stop-all").length).toBe(2);
  expect(guidelines).toContain("`f1rm wake` refuses a message that starts with a slash");
  for (const [text, name] of [[readme, "README"], [guidelines, "guidelines"]] as const) expect(text, name).toContain("best-effort text matching");
  expect(readme).not.toContain("| `f1rm wake` |"); // f1rm wake is gone (#93)
});

test("docs/decisions.md has the Stop all and resume all entry with the mechanism and what it rejected", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const entry = entries.find((e) => e.startsWith("2026-11-02 Stop all and resume all in three places\n")) ?? "";
  for (const s of ["- Decision:", "- Why:", "- Rejected:", "- Where:", "disable-model-invocation", "no hook", "whose prompt text matches", "best-effort text matching", "USAGE and the README row", "a HOME prefix included", "allowed-tools", "f1rm wake", "lid", "nothing resumes by itself"]) expect(entry, s).toContain(s);
});

test("topic-prose: a topic lead grills, previews visible work, shows a first slice without waiting, holds about 5 tasks, and lands visible tasks with proof and one desk line each", () => {
  const lead = role("lead");
  expect(lead.body).toContain("Load `mattpocock-skills:grilling` with the Skill tool");
  for (const [name, text] of [["lead.md", lead.body], ["SKILL.md", section("Teams")]] as const) {
    for (const s of [
      "opens with `mattpocock-skills:grilling` and interviews the user about that one topic in its own chat",
      "one-screen plan plus a mock or screenshot", "his \"go\"", "`NEEDS YOU <team>: preview`",
      "thinnest end-to-end slice first", "its proof on its desk", "without waiting", "\"stop\"",
      "about 5 tasks", "only with proof from the running app", "right after `f1rm merge` appends one line per landed task to its desk file `~/.f1rm/evidence/<repo>/lead-<team>/desk.md`",
      "`| <ISO date> | <task slug> | <proof path or https link, or \"none (not visible)\"> | <one-line what landed> |`",
      "proof path is absolute under `~/.f1rm/evidence/` or relative to the desk file's folder",
    ]) expect(text, `${name}: ${s}`).toContain(s);
  }
  expect(section("Teams")).toContain("`lead-<topic>`");
  expect(section("Teams")).toContain("No cap on live topics");
});

test("topic-prose: docs/decisions.md has the four topic entries", () => {
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  for (const t of ["Topics run by leads; the PM is a scribe", "Preview before building visible work", "First slice shown without waiting", "Visible tasks land with proof from the running app"]) expect(log).toContain(`## 2026-11-03 ${t}\n`);
});

describe("usage pacing and docker rules", () => {
  const usage = section("Usage pacing and Docker");
  test("the section sits right before Use what is installed and says where the numbers come from", () => {
    const names = guidelines.split(/^## /m).map((s) => s.split("\n")[0]);
    expect(names.indexOf("Usage pacing and Docker")).toBeGreaterThan(-1);
    expect(names.indexOf("Use what is installed")).toBe(names.indexOf("Usage pacing and Docker") + 1);
    for (const s of ["statusLine", "never the oauth usage endpoint", "transcript estimates", "75", "85", "90", "95", "exit 75", "`--override` is refused", "\"Ahead of pace\"; nothing is held for it"]) expect(usage, s).toContain(s);
    expect(usage).not.toContain("one team per project");
  });
  test("a hire tags and removes the Docker resources it starts and never prunes", () => {
    for (const s of ["f1rm docker-tag <task>", "COMPOSE_PROJECT_NAME", "removes what it starts", "never prune", "never touches an untagged resource or an image", "f1rm letgo", "node_modules"]) expect(usage, s).toContain(s);
  });
  test("the Cap rule points to the section", () => {
    expect(section("Cap rule")).toContain("A usage hold (see Usage pacing and Docker)");
  });
  test("docs/decisions.md has the two usage entries", () => {
    const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
    for (const t of ["Pace on the official usage windows", "Tag and tear down each task's Docker stack"]) expect(log).toContain(`## 2026-11-03 ${t}\n`);
  });
});

describe("sdd borrow rules", () => {
  const teamsItem = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(section("Teams"))?.[0] ?? "";
  const leadStep = (n: number) => new RegExp(`^${n}\\. .*$`, "m").exec(role("lead").body)?.[0] ?? "";
  test("the living spec: docs/spec.md, one present-tense section per capability, created lazily, edited in the same commit, and a repo's CLAUDE.md can name another", () => {
    const md = section("Milestones and decisions");
    for (const s of ["**The living spec.**", "`docs/spec.md`", "one short section per capability, in the present tense", "The first task that changes a behaviour creates it, holding only that task's section", "never backfilled", "edits its section in the same commit", "no `merge=union`", "goes back through `f1rm merge`", "A repo whose `CLAUDE.md` names another file or files as its living spec uses those instead.", "`docs/decisions.md` and git history stay, and so does the living spec."]) expect(md, s).toContain(s);
    expect(section("Brief format")).toContain('When a task changes what the software does, a criterion reads "the living spec section <capability> says <behaviour>"');
    expect(role("lead").body).toContain('"the living spec section <capability> says <behaviour>"');
  });
  test("a missing living spec update the brief asks for blocks, in review step 2, the content checklist and reviewer.md", () => {
    const flow = section("Review and landing");
    expect(flow).toContain("A `docs/decisions.md` entry or a living spec update the brief asks for and the diff lacks is blocking.");
    expect(flow).toContain("- every `docs/decisions.md` entry and living spec update the brief asks for is there.");
    expect(role("reviewer").body).toContain("and every living spec update it asks for, is in the branch. A missing one blocks.");
  });
  test("f1rm's CLAUDE.md names the guidelines and the README as its living spec", () => {
    const claude = readFileSync(join(REPO, "CLAUDE.md"), "utf8").split(/^### /m).find((s) => s.startsWith("Living spec\n")) ?? "";
    for (const s of ["`plugin/skills/f1rm-guidelines/SKILL.md` (the company rules)", "`README.md` (the office)"]) expect(claude, s).toContain(s);
  });
  test("the size gate is Teams 11, with pointers in Brief format, Teams 8, Teams 10, the lead's Workflows steps, Definition of done and lead.md steps 3 and 5", () => {
    const gate = teamsItem(11);
    for (const s of ["**Size gate.**", "about 3 files", "no product, design or business choice and no core decision", "the gates, authentication, user data, secrets, shell execution, money or data removal", "short brief", "no grilling rounds", "one-line understanding and the check", "the user's \"go\"", "reads a small task's diff itself", "failing test first", "full check", "only through `f1rm merge`", "\"small\" call in `~/.f1rm/kept/<repo>/calls.md`"]) expect(gate, s).toContain(s);
    expect(section("Brief format")).toContain("A small task (Teams 11) has a short brief: only Task, one or two acceptance criteria each with its proved by, and Out of scope.");
    expect(teamsItem(8)).toContain("for a small task, the lead reads the diff itself (Teams 11)");
    expect(teamsItem(10)).toContain("A topic that is one small task gets no grilling rounds; its one-line understanding goes the same way (Teams 11).");
    expect(leadStep(3)).toContain("A topic that is one small task (Teams 11 in the guidelines) gets no rounds");
    expect(leadStep(5)).toContain("or, for a small task, read the diff yourself (Teams 11 in the guidelines); then send the blocking findings back");
    expect(section("Brief format")).toContain("Write exactly these sections, in this order (a small task uses the short form below).");
    const wf = section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("lead**")) ?? "";
    expect(wf).toContain("(a topic that is one small task: no rounds, Teams 11)");
    expect(wf).toContain("(a small task: the lead reads the diff itself, Teams 11)");
    expect(section("Definition of done")).toContain("the lead's own reading of a small task's diff (Teams 11)");
    const entry = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).find((e) => e.startsWith("2026-11-05 Size gate for small tasks\n")) ?? "";
    expect(entry).toContain("authentication, user data, secrets");
  });
  test("the topic converges once at close: criteria on the team board (Teams 6), one check on main before the batch task (Teams 9), named in Workflows and lead.md step 7", () => {
    expect(teamsItem(6)).toContain("the topic's acceptance criteria, each with its proved by, under `## Acceptance criteria` on its team board");
    const close = teamsItem(9);
    for (const s of ["converges once", "runs each check of the topic's acceptance criteria once on main", "each failing criterion becomes one more task through the same flow", "listed as open in `DONE <team>`, with no second round"]) expect(close, s).toContain(s);
    expect(close.indexOf("converges once")).toBeLessThan(close.indexOf("one batch task"));
    expect(section("Workflows")).toContain("Close the team (Teams 9): the converge check, the batch task,");
    const step7 = leadStep(7);
    for (const s of ["converge once", "`## Acceptance criteria`", "on main", "one more task through the same flow", "open in your `DONE <team>`", "no second round"]) expect(step7, s).toContain(s);
    expect(step7.indexOf("converge once")).toBeLessThan(step7.indexOf("batch task"));
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
  test("no role file, README or hire skill states a removed cap", () => {
    const texts: [string, string][] = [["README", readFileSync(join(REPO, "README.md"), "utf8")], ["plugin README", pluginReadme()], ["hire skill", hireSkill()], ...Object.keys(ROLES).map((r): [string, string] => [`${r}.md`, readFileSync(join(PLUGIN, "agents", `${r}.md`), "utf8")])];
    for (const [name, text] of texts) for (const s of REMOVED) expect(text.toLowerCase(), `${name}: ${s}`).not.toContain(s.toLowerCase());
  });
  test("the Cap rule says no cap counts sessions, teams, members or interns, and keeps one specialist per task, one Reviewer, the team's lead and the usage holds", () => {
    const cap = section("Cap rule");
    for (const s of ["No cap counts sessions, teams, members or interns", "still refuse or wait, and say why:", "**One specialist per task**", "One Reviewer per task", "A `--team` hire needs its lead running", "`waiting for a slot: usage hold: ...`", "`f1rm resume`", "auto-wake", "run independent tasks in parallel", "the usage holds are the brake"]) expect(cap, s).toContain(s);
  });
  test("Teams 3 says live topics have no cap and queue only by dependency, and owners run independent implementers in parallel", () => {
    expect(teamsItem(3)).toContain("**No cap on live topics**");
    expect(teamsItem(3)).toContain("only by dependency");
    expect(teamsItem(5)).not.toContain("two live");
    expect(teamsItem(7)).toContain("runs the implementers of independent tasks in parallel");
  });
  test("the Spawning table's Sub-agents column has no cap, and the PM's f1rm hire stays leads", () => {
    const rows = section("Spawning table").split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Role") && !l.startsWith("| :-"));
    for (const r of rows) expect(r.split("|")[3], r).not.toMatch(/At most 2|parent's 2/);
    for (const r of rows.slice(0, 3)) expect(r.split("|")[3], r).toContain("No cap");
    expect(rows[0].split("|")[2]).toContain("Leads");
  });
  test("the Interns rule says there is no cap and keeps the independent-subtask and Haiku guidance", () => {
    const interns = section("Interns");
    for (const s of ["No cap counts interns", "independent of your other work", "on Haiku unless the subtask needs more", "implementer and review subagents follow the same independence rule and run on the model their work needs"]) expect(interns, s).toContain(s);
    expect(interns).not.toContain("sub-agents too");
    expect(section("Review and landing")).toContain("the one subagent it starts is this reviewer (interns aside, see Interns)");
    for (const name of SPECIALISTS) expect(role(name).body, name).toContain("Run an intern only for a subtask independent of your other work, on Haiku unless it needs more.");
  });
  test("the usage pacing notes ahead of pace and holds nothing for it", () => {
    const usage = section("Usage pacing and Docker");
    for (const s of ["\"Ahead of pace\"", "nothing is held for it"]) expect(usage, s).toContain(s);
  });
  test("the guidelines say the PM starts a topic lead with f1rm hire --topic when the user asks and tells him only when a lead needs him", () => {
    expect(guidelines.split("\n").find((l) => l.startsWith("Hierarchy:"))).toContain("a scribe that starts leads");
    expect(section("Roster and hiring playbook").split("```")[1]).toContain('f1rm hire --topic lead lead-<topic> <topic> "<brief>"');
    const pmFlow = section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))!;
    for (const s of ["`f1rm hire --topic lead lead-<topic> <topic> \"<brief>\"`", "verbatim", "Other teams", "tell the user only when a lead needs him"]) expect(pmFlow, s).toContain(s);
    expect(teamsItem(1)).toContain("or asks the PM, which starts its lead at once");
    expect(teamsItem(4)).toContain("The user, or the PM on his request, starts a lead");
    expect(section("Who talks to whom")).toContain("the PM relays no question and no answer");
  });
  test("a topic lead's first round goes through NEEDS YOU, in the guidelines and lead.md, and so does a small task's one-line understanding", () => {
    for (const s of ["the user's words verbatim", "its first one too", "`NEEDS YOU <team>: <topic>` before it waits"]) expect(teamsItem(10), s).toContain(s);
    expect(teamsItem(11)).toContain("it writes its one-line understanding and the check under `## Open question for the user` with `NEEDS YOU <team>: <topic>`, like a round, and starts on the user's \"go\"");
    const lead = role("lead").body;
    for (const s of ["the first one too", "`NEEDS YOU <team>: <topic>` before you wait", "write your one-line understanding and the check under `## Open question for the user` with `NEEDS YOU <team>: <topic>`, like a round, and start on the user's \"go\"", "A topic lead, started from the office or by the PM, has the grilling interview as its first command."]) expect(lead, s).toContain(s);
  });
  test("a lead asks the open scope questions and runs the board check; the PM plans nothing", () => {
    const talk = section("Who talks to whom");
    for (const s of ["A lead asks at most 3 open scope questions per topic, each with a recommended answer", "a default the lead writes under an `Assumptions` line", "**Board check before the first task.** Before its first task the lead checks"]) expect(talk, s).toContain(s);
    for (const s of ["The PM asks at most 3", "The PM checks that every acceptance criterion"]) expect(talk, s).not.toContain(s);
    expect(section("Brief format")).toContain("each default the lead chose for a gap");
    expect(role("lead").body).toContain("Before your first task run the board check, and ask at most 3 open scope questions (Who talks to whom in the guidelines).");
    expect(role("pm").body).not.toContain("board check");
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain("Each lead asks at most three open scope questions per topic");
    expect(readFileSync(join(REPO, "README.md"), "utf8")).not.toContain("The PM asks at most three");
    expect(pluginReadme()).not.toContain("the PM interviews you before it plans");
  });
  test("Ask the user only for big decisions gives the PM no interview", () => {
    const big = section("Who talks to whom").split("\n").find((l) => l.startsWith("- **Ask the user only for big decisions.**")) ?? "";
    expect(big).toContain("Every question to the user covers only business");
    expect(big).not.toContain("The PM's interview");
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
  for (const s of ["setup-matt-pocock-skills", "`mattpocock-skills:grilling`", "`mattpocock-skills:domain-modeling`", "`to-spec`", "`ready-for-agent`", "A small ask", "gets no rounds", "and stop."]) expect(body, s).toContain(s);
  for (const s of ["f1rm hire", "board", "f1rm push", "letgo", "milestone", "lead"]) expect(body, s).not.toContain(s);
  expect(pmPromptText()).toContain("publish it as a spec");
  expect(pmPromptText()).not.toMatch(/board|f1rm hire|\blead|guidelines/);
});
