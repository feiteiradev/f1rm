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

test("the PM interviews before it plans, and the Reviewer never pushes", () => {
  const pm = role("pm");
  expect(pm.body).toMatch(/Make no plan, board entry or hire before that confirmation/);
  expect(pm.body).toContain("f1rm hire");
  const reviewer = role("reviewer");
  expect(reviewer.fm.disallowedTools).toBeUndefined(); // a Bash(...) deny removes the whole Bash tool
  expect(reviewer.body).toContain("never push");
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
  expect(section("Review and landing")).toContain("Never run `git push`");
  expect(section("Review and landing")).toContain("`--ff-only`");
  expect(section("Cap rule")).toContain("**8 background sessions working at once**");
  expect(section("Cap rule")).toMatch(/override flag.*only after the user has approved/s);
  expect(section("Definition of done")).toContain("`f1rm merge` has landed it");
});

test("the guidelines run teams: when to form them, the team brief, NEEDS YOU/DONE, who talks to whom, the caps, interns, team boards and installed skills", () => {
  for (const h of ["Teams", "Team brief", "Who talks to whom", "Interns", "Use what is installed"]) expect(section(h).trim().length).toBeGreaterThan(100);
  const teams = section("Teams");
  for (const s of ["Every milestone runs through one or two teams", "At most 2 teams", "Only the PM hires leads", "No nested teams", "`DONE <team>`"]) expect(teams).toContain(s);
  expect(section("Who talks to whom")).toContain("The user talks to each lead directly");
  expect(section("Who talks to whom")).toMatch(/lead .*messages the other leads directly/s);
  const caps = section("Cap rule");
  for (const s of ["**8 background sessions working at once**", "**2 teams**", "**2 working in a team**", "**One specialist per task**"]) expect(caps).toContain(s);
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
  expect(pm).toContain("After `DONE <team>`, mark its row done, then let the lead go");
  const lead = role("lead").body;
  for (const s of ["`NEEDS YOU <team>: <topic>`", "`DONE <team>`", "f1rm hire --team <team>", "Who talks to whom"]) expect(lead).toContain(s);
});

test("the guidelines run editions: Work and Founder, the founder playbook, drafts only, the content checklist and publish", () => {
  for (const h of ["Editions", "Founder playbook", "Drafts only"]) expect(section(h).trim().length).toBeGreaterThan(100);
  expect(section("Editions")).toContain("~/.f1rm/projects/<repo>.json");
  expect(section("Editions")).toContain("refuses a Founder-only role in a Work project");
  const playbook = section("Founder playbook");
  for (const s of ["the customer, the problem they have, the offer, and the channel", "**Strategist first**", "`growth/brand.md`", "`growth/marketing/`", "`launch` team"]) expect(playbook).toContain(s);
  const drafts = section("Drafts only");
  for (const s of ["never post, publish, send, schedule or spend", "paid credits", "`publish`"]) expect(drafts).toContain(s);
  expect(section("Review and landing")).toContain("**content checklist**");
  expect(section("Board format")).toContain("`publish` means landed founder work waiting for the user to put it out");
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
  expect(guidelines).toContain("Nobody pushes; the user pushes.");
  const playbook = section("Roster and hiring playbook");
  for (const s of ["same task goes to the same session", "`review-<task>`", "previous `DONE` report", "what the user must provide"]) expect(playbook).toContain(s);
});

test("the guidelines say what each gate holds and the way out, and a cap refusal goes lead to PM to user", () => {
  const gates = section("Gates");
  for (const s of ["skill gate", "delegation gate", "boards, milestones, kept files, memory, evidence and scratch", "`f1rm:*`", "load the skills", "security-review"]) expect(gates).toContain(s);
  const skillGate = gates.split("\n").find((l) => l.includes("**skill gate**")) ?? "";
  for (const s of ["Only a session's first prompt arms it", "a later message that quotes that prompt's skill list changes nothing", "resumed with its own id is not armed again", "A woken session (`f1rm wake`) is a new session whose first prompt is the wake note", "names no skills to load (its history has them)", "A Reviewer session started before the Reviewer became content-only may still carry the security sentence in its first prompt", "a content Reviewer carries none", "a skill the Skill tool refuses counts as tried, read from the session's own transcript", "disable-model-invocation, go on without that skill", "Unknown skill, go on and send `BLOCKED <slug>`"]) expect(skillGate, s).toContain(s);
  const cap = section("Cap rule");
  expect(cap).toMatch(/lead.*tells? the PM/s);
  expect(cap).toMatch(/PM.*tells? the user/s);
});

test("pm.md turns handed work into a board task, sends exploration to a Haiku Explore intern, sends a permission to the user as a request to approve in the office, picks up first, and ends a milestone", () => {
  const pm = role("pm").body;
  for (const s of ["including a slash command", "Haiku Explore intern", "never run its command", "Pick up", "claude logs", "f1rm letgo", "close this session"]) expect(pm).toContain(s);
  const lead = role("lead").body;
  expect(lead).toContain("f1rm letgo");
  expect(lead).toMatch(/cap.*Tell the PM/s);
  expect(role("reviewer").body).toContain("Nothing is merged by you");
});

test("the PM pauses and resumes when the user says so and never waits for agents by message; the guidelines say what a pause stops, verifies and saves, 'pause and close', the restart and the resume", () => {
  const pause = section("Pause and checkpoint");
  expect(pause).not.toBe("");
  for (const s of [
    "run `f1rm pause [reason]` yourself", "Never wait for the agents by message", "never ask a lead to pause its team",
    "the helpers inside them included", "background processes they started", "never the office, a terminal or the user's own sessions",
    "checks afterwards that nothing of the project still runs", "`refs/f1rm/checkpoint/<task>`", "without touching the files", "a manifest",
    "`All N stopped` and the checkpoint id only after that check", "does not see a detached job a lead or Reviewer started in the main checkout", "second office's own `claude` daemon", "is named `NOT saved`", "exits non-zero it names what still runs",
    "An orphan a user's own `claude -w` left in `.claude/worktrees` with no terminal is killed with the rest", "an application started from a worktree (such as an editor opened with `code .`) never is",
    "**Sleep.**", "After the Mac sleeps (a gap of more than 2 minutes between the office's ticks) nobody is judged stalled, woken or nudged for 5 minutes.",
    "**Pause and close.**", "`paused at <time>, checkpoint <id>`", "\"safe to close\"",
    "**Restart.**", "`f1rm pm` on a paused project", "the board, the milestones file and the manifest", "say in one line where everything stopped",
    "**Resume.**", "`f1rm resume`", "leads first, one at a time within the cap of 8", "a note of where it stopped", "is named in the output",
    "`f1rm hire`, `f1rm wake` and the office's Hire dialog are refused", "`f1rm pause --all` and `f1rm resume --all` are for the user's terminal",
  ]) expect(pause).toContain(s);
  for (const f of ["README.md", "plugin/skills/f1rm-guidelines/SKILL.md", "plugin/agents/pm.md"]) expect(readFileSync(join(REPO, f), "utf8"), f).not.toMatch(/work ?hours|work day/i); // the schedule is gone
  expect(readFileSync(join(REPO, "README.md"), "utf8").split("nobody is judged stalled, woken or nudged for 5 minutes").length).toBe(2); // the sleep grace, once
  expect(pause.split("nobody is judged stalled, woken or nudged for 5 minutes").length).toBe(2);
  expect(pause).not.toContain("or an orphan the user's own `claude -w` left"); // the old wording said the pause misses it
  const pm = role("pm").body;
  expect(pm).toContain("## Pause");
  for (const s of ["run `f1rm pause [reason]` yourself", "never wait for the agents by message", "checkpoint id", "if it exits non-zero, tell the user what still runs", "`paused at <time>, checkpoint <id>`", "\"safe to close\"", "the manifest your first prompt names", "say in one line where everything stopped", "run `f1rm resume` only when the user says \"resume\""]) expect(pm).toContain(s);
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

test("both READMEs and the hire skill state the machine cap as 8, never 6 or 30", () => {
  const texts = [join(REPO, "README.md"), join(PLUGIN, "README.md"), join(PLUGIN, "skills", "hire", "SKILL.md")].map((f) => readFileSync(f, "utf8"));
  expect(texts[0]).toContain("At most 8 background sessions work at once");
  expect(texts[1]).toContain("8 working sessions on the machine");
  expect(parts(join(PLUGIN, "skills", "hire", "SKILL.md")).fm.description).toContain("8 working sessions on the machine");
  for (const t of [...texts, guidelines]) expect(t).not.toMatch(/\b(6|six|30|thirty) (background|working) sessions/);
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
  expect(section("Review and landing")).toContain("docs/decisions.md");
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
  expect(guidelines.split("\n").find((l) => l.startsWith("Hierarchy:"))).toContain("hires leads for a milestone");
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
  expect(section("Who talks to whom")).toContain("A specialist reports only to the session in its `Report to`, its team's lead (the PM for a simple task), and messages only who the Messaging table allows.");
  expect(section("Who talks to whom")).not.toContain("another specialist");
  expect(section("Handoff via SendMessage")).toContain("A hire reports to the session in its `Report to` and messages only who the Messaging table allows.");
  expect(section("Handoff via SendMessage")).not.toContain("another hire");
  expect(section("Review and landing")).toContain("the PM (a simple task) or the team's lead marks the task's row `done` and lets the session go with `f1rm letgo <name>...`");
  for (const r of ["designer", "frontend-dev", "backend-dev", "reviewer", "researcher", ...SPECIALISTS]) expect(role(r).body, r).toMatch(/Report only to the session in your `Report to`: your team's lead( \(the PM on a simple task\))?\. Message only who the Messaging table in the guidelines allows\./);
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
  for (const s of ["the lead marks its team-board row `publish`", "`NEEDS YOU <team>: publish`", "The PM tells the user", "the PM tells the lead, who marks the row `done`"]) expect(drafts, s).toContain(s);
  expect(drafts).not.toContain("the PM marks its board row");
  expect(section("Board format")).toContain("On a team board the lead sets `publish` and `done`");
  const pm = role("pm").body, lead = role("lead").body;
  expect(pm).toContain("keep the `publish` list");
  expect(pm).toContain("`NEEDS YOU <team>: publish`");
  expect(pm).toContain("tell the lead");
  expect(pm).not.toContain("mark approved founder work");
  expect(lead).toContain("`NEEDS YOU <team>: publish`");
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
  expect(readme).toContain("The PM hires team leads, or one specialist directly for a simple task.");
  expect(readme).not.toContain("The PM hires the rest.");
  for (const text of [section("Review and landing"), role("reviewer").body]) {
    expect(text).toContain("research a brief puts in the repo");
    expect(text).not.toContain("docs/research/");
  }
});

test("B3-B5: leads filter team traffic, so the PM tells the user only what needs a decision or the user, plus one end-of-milestone report", () => {
  const talk = section("Who talks to whom");
  for (const s of ["big decisions;", "a permission request", "spend, credentials or inputs", "a `git push`", "a dirty main checkout", "one end-of-milestone report", 'the user asks "status?"']) expect(talk, s).toContain(s);
  expect(talk).toMatch(/lead receives all of its team's messages/);
  expect(talk).toMatch(/sends the PM only `NEEDS YOU <team>: <topic>` and `DONE <team>`/);
  expect(section("Team brief")).toContain("Report: NEEDS YOU <team>: <topic> for what needs the user, DONE <team> when the slice is merged. Nothing else goes to the PM.");
  for (const text of [guidelines, role("lead").body]) expect(text).not.toMatch(/status report/i);
  const teams = section("Teams");
  for (const s of ["checks each task's `DONE` against its brief", "sends the work back", "~/.f1rm/kept/<repo>/findings.md", "5-line summary", "runs `f1rm merge <task>`"]) expect(teams, s).toContain(s);
  const lead = role("lead").body;
  for (const s of ["receive every message from your team", "~/.f1rm/kept/<repo>/findings.md", "`NEEDS YOU <team>: <topic>` and `DONE <team>`"]) expect(lead, s).toContain(s);
  const pm = role("pm").body;
  for (const s of ["big decisions", "git push"]) expect(pm, s).toContain(s);
  expect(pmPromptText()).toContain("NEEDS YOU <team>");
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

test("R8b: the three workflows are said once in the guidelines; pm.md and the PM prompt point to them by name and carry the one-line form", () => {
  const w = section("Picking the workflow");
  for (const s of [
    "`Simple workflow: <what, which role>`", 'saying "milestone"', "**Ops**", "no file changes (run, start, open, install, status)", "at once",
    "**Simple**", "one deliverable", "one specialist role", "no business, product-scope, design or strategy decision", "fits one session", "at most one clarifying question", "no milestone section", "one board row", "ONE dev, designer or researcher",
    "**Milestone**", "2 or more tasks or roles", "a big decision", "research needed", '"milestone" or "grill"', "the full interview and teams",
  ]) expect(w, s).toContain(s);
  expect(guidelines.split("no business, product-scope, design or strategy decision")).toHaveLength(2);
  for (const [name, text] of [["pm.md", role("pm").body], ["prompt", pmPromptText()]] as const) {
    expect(text, name).toContain("Picking the workflow");
    expect(text, name).toContain("Simple workflow:");
    expect(text, name).toContain("milestone");
    expect(text, name).not.toContain("one specialist role");
  }
  expect(pmStep(2)).toContain("Load the guidelines");
  expect(pmStep(3)).toContain("Picking the workflow");
  const wf = section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))!;
  expect(wf.indexOf("2. Load `f1rm:f1rm-guidelines`")).toBeGreaterThan(-1);
  expect(wf.indexOf("2. Load `f1rm:f1rm-guidelines`")).toBeLessThan(wf.indexOf("3. Pick the workflow"));
  const prompt = pmPromptText();
  expect(prompt.indexOf("f1rm:f1rm-guidelines")).toBeGreaterThan(-1);
  expect(prompt.indexOf("f1rm:f1rm-guidelines")).toBeLessThan(prompt.indexOf("Picking the workflow"));
});

test("R8b: pm.md lets the PM run ops itself, and a lead records a direct Tell on its board instead of messaging the PM", () => {
  expect(role("lead").body).toContain("act on it and record what changed on your team board, which the PM reads");
  expect(role("lead").body).not.toContain("tell the PM what changed");
  expect(section("Who talks to whom")).toContain("(a lead records it on its team board, which the PM reads)");
  expect(section("Who talks to whom")).not.toContain("(a lead tells the PM)");
  expect(pmStep(1)).toContain("`~/.f1rm/boards/<repo>.team.<team>.md`");
  expect(pmStep(1)).toContain("team boards");
  expect(section("Workflows")).toContain("read the board, the team boards, the milestones file");
  expect(role("pm").body).toContain("Work handed to you, other than ops (see Picking the workflow), including a slash command, becomes a board task for a hire.");
});

test("R8b: a spend is a big decision that reaches the user through the lead, not a PM relay", () => {
  expect(section("Drafts only")).toContain("the lead asks the user for each spend as Who talks to whom says, records the answer on its team board and passes it down");
  expect(section("Drafts only")).not.toContain("the PM asks the user for each spend");
  expect(role("pm").body).not.toContain("Ask the user before any spend");
  expect(role("researcher").body).not.toContain("through the PM");
});

test("R8b: the hire skill says the lead asks the user in its own session before an override", () => {
  const skill = readFileSync(join(PLUGIN, "skills", "hire", "SKILL.md"), "utf8");
  expect(skill).toContain("The lead asks the user in its own session (the PM, for a hire of its own), and only after the user approves this hire in that conversation is it rerun with --override.");
  expect(skill).not.toContain("Only the PM asks the user");
});

test("R8b: the plugin README says the PM tells the user which lead needs them", () => {
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  expect(readme).toContain("the PM tells you which lead needs you");
  expect(readme).not.toContain("in the words");
});

test("R8b: PLAN and GO are gone from every role file, the guidelines, the prompt, hire.ts and both READMEs", () => {
  for (const [name, text] of Object.entries(WORKFLOW_FILES())) {
    expect(text, name).not.toMatch(/\bPLAN\b/);
    expect(text, name).not.toMatch(/\bGO\b/);
  }
  expect(role("lead").body).toContain("`NEEDS YOU <team>: <topic>` and `DONE <team>`");
  expect(role("pm").body).toContain("`NEEDS YOU <team>: <topic>`");
  expect(role("pm").body).toContain("After `DONE <team>`, mark its row done, then let the lead go");
  expect(section("Workflows")).toContain("`NEEDS YOU <team>: <topic>`");
});

test("R8b: the talk rules are stated once in the guidelines and pointed to from pm.md, lead.md and the prompt", () => {
  const talk = section("Who talks to whom");
  for (const s of [
    "The user talks to each lead directly", "in the lead's own session (the office's Jump)", "a numbered round", "its recommended answer", '"yes to all"', "open question on its team board",
    "`NEEDS YOU <team>: <topic>`", "a one-liner", "lead-<team> needs you about <topic>: Jump to lead-<team> in the office", "never an id or a `claude attach` command",
    "approve <name>'s request in the office", "helps the user decide when asked", "writes the end-of-milestone report",
    "In ops and the simple workflow the PM stays the user's contact", "Status, `BLOCKED`, `ESCALATE` and a cap override reach the user through the lead",
    "On `NEEDS YOU` the PM sends the user to the session that acts on the answer: the office's permission card for a permission, the lead for anything else, a cap included (the override needs the approval in the lead's own conversation). In the simple workflow the dev reports to the PM, so a dev's `NEEDS YOU <slug>` or `BLOCKED` is the PM's to put to the user, and the PM answers the dev; a cap goes to the user, and a permission to the office's card.",
  ]) expect(talk, s).toContain(s);
  expect(guidelines.split("lead-<team> needs you about <topic>: Jump to lead-<team> in the office")).toHaveLength(2);
  expect(guidelines).not.toMatch(/claude attach <id>/);
  expect(talk).not.toContain("never needs a Jump");
  expect(role("pm").body).not.toContain("including when a lead tells you");
  expect(role("pm").body).not.toContain("lead the work yourself");
  expect(role("pm").body).toContain("In ops and the simple workflow you stay the user's contact");
  expect(pmStep(6)).toContain("send the user where Who talks to whom in the guidelines says");
  expect(pmStep(6)).not.toContain("ask the user the question on the team board yourself");
  for (const [name, text] of [["pm.md", role("pm").body], ["lead.md", role("lead").body], ["prompt", pmPromptText()]] as const) {
    expect(text, name).toContain("Who talks to whom");
    expect(text, name).not.toContain("claude attach");
    expect(text, name).not.toContain("a numbered round");
  }
  expect(role("pm").body).toContain("needs you about <topic>: Jump to");
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
  expect(srows[0]).toContain("Leads, and one dev, designer or researcher with `--simple` (enforced)");
  expect(srows[1]).toContain("of its own team, never a dev or a lead (enforced)");
  expect(srows[2]).toContain("Nothing (enforced)");
  for (const s of ["At most 2", "never an `f1rm:*` role", "Never (enforced)", "`--bg --resume`", "temporary HOME", "bash -c", "not parsed"]) expect(spawn, s).toContain(s);
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
  expect(trows[1]).toContain("Leads of its project and its simple tasks' devs only (enforced)");
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

test("C2: the gate refuses every push, lands only f1rm merge on the base, and holds the Reviewer's git to an allowlist", () => {
  const gates = section("Gates");
  for (const s of ["`git push` in any form", "`gh pr merge`", "The Reviewer's git is an allowlist: reading commands, `git branch` as a listing, and `git worktree` add, list, prune and remove (a forced remove only of `.claude/worktrees/red-<task>`)", "merge, commit, checkout, switch, fetch, config and the rest are refused", "`gh api` call that writes to code-landing endpoints", "pull request and branch merges and updates, refs, commits, trees, blobs and contents, and graphql merge, update and ref mutations", "other `gh api` calls stay allowed", "behind `timeout`, `nice` or `stdbuf`", "`merge`, `cherry-pick`, `rebase`, `reset`, `commit`, `am`, `pull`, `revert`, `checkout <ref> -- <path>`, `checkout -B`, `switch -C` and `restore --source`", "`update-ref`, `branch -f` and `fetch . x:<base>`", "A dev's git in its own worktree is unchanged"]) expect(gates, s).toContain(s);
  expect(role("pm").body).toContain("Write and Edit work there too");
  const reviewer = readFileSync(join(PLUGIN, "agents", "reviewer.md"), "utf8");
  expect(reviewer).not.toContain("prompt-only");
  expect(reviewer).toMatch(/gate refuses/i);
});

test("archive: the milestone cleanup runs f1rm letgo --leftovers and f1rm archives --prune and reports what was archived and pruned; the decision is logged", () => {
  const md = section("Milestones and decisions");
  for (const s of ["the PM cleans up with `f1rm letgo --leftovers`", "`refs/f1rm/archive/<task>`", "never running `claude rm`", "`f1rm archives --prune`", "older than 30 days", "The report says what was archived and what was pruned."]) expect(md, s).toContain(s);
  for (const s of ["`f1rm letgo --leftovers`", "`f1rm archives --prune`", "list in the report what was archived and what was pruned"]) expect(role("pm").body, s).toContain(s);
  expect(readFileSync(join(REPO, "docs", "decisions.md"), "utf8")).toContain("## 2026-10-29 Archive, then remove\n");
  expect(readFileSync(join(REPO, "README.md"), "utf8")).toMatch(/^\| `f1rm archives` \|/m);
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
  for (const s of ["only blocking findings", "batch task"]) expect(pm, s).toContain(s);
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

test("P1: projects are isolated: the PM and leads filter to their own repo, address no other project, and report f1rm problems to the user", () => {
  const talk = section("Who talks to whom");
  for (const s of ["Projects are isolated", "`claude agents --json`", "own repo", "never name, address or rely on another project's sessions, boards, milestones or evidence", "`f1rm feedback: <problem> -> <suggestion>`", "addressed to no session"]) expect(talk, s).toContain(s);
  expect(section("Gates")).toContain("project gate");
  expect(section("Gates")).toContain("SendMessage");
  expect(section("Gates")).toContain("With the office stopped, none runs.");
  for (const r of ["pm", "lead"]) {
    for (const s of ["claude agents --json", "own repo", "another project's", "`f1rm feedback: <problem> -> <suggestion>`", "addressed to no session"]) expect(role(r).body, `${r}: ${s}`).toContain(s);
  }
  expect(section("Gates")).toContain("Elsewhere is no room");
  expect(guidelines.split("Elsewhere room").length - 1).toBe(0); // Elsewhere is no room: the old shared-room sentence is gone
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
test("S1: the guidelines state the watcher, the real-activity rule, and what to do on a wake for a limit stop, an ended session and a stalled one", () => {
  const w = section("Watching and waking");
  for (const s of [
    "never by status text", "`f1rm status --json`", "`idleMinutes`", "`limitUntil`", "`ended`", "`f1rm status --watch <names>`", "`name:waiting`", "`run_in_background`", "its exit wakes you",
    "idle for 20 minutes", "exits 1 when `claude agents --json` can't be read", "only when it and every hire of its team",
    "Pass a session waiting for an answer to its report (`DONE`, `BLOCKED`, `CHANGES REQUESTED`, `ESCALATE`, `APPROVED`, or a lead's `NEEDS YOU` or `DONE <team>`) as `name:waiting`",
    "a waiting name is judged only for ended, missing or a limit stop, never for being quiet",
    "When you answer a session's report (and it works again), restart the watcher with it as a plain name.", "a waiting name is watched as a plain name as soon as it writes again",
    "Leave out a hire waiting on a reset timer you hold.", "Start no watcher when no name is left; the reset timers wake you.",
    "After `f1rm letgo`, restart the watcher without the names you let go.", "For a wake about a session you already handled (or took a report from) since that watcher started: ignore it, but still restart the watcher.", "When a session sends its report, restart the watcher with it as `name:waiting`.",
    "A message you send to a waiting session counts as a write and makes it plain.", "Until it writes, a waiting name is woken only for ended, missing or a limit stop.",
    "**Limit stop**", "wait until a minute after that time", "so the watcher does not race it", "Run `f1rm wake <name>` when its NOTE says the office could not, and when it is still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported` (the office may have stopped after writing its NOTE; a live session is refused, so racing it is harmless).", "A `resume` sent at the reset time itself reaches no process", "the text after \"resets\"", "send it `resume`", "`resume.md`",
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
  expect(decisions).toContain(known); // the history keeps what was true then; the guidelines now say the office wakes the leads (R9b)
  for (const text of [w, decisions]) expect(text).toContain(pmStop);
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
    // The PM's report is prose to the user, which the office never reads; every other role reports with SendMessage.
    if (name === "pm") expect(line, name).not.toContain("before the report");
    else expect(line, name).toContain("before the report (the report is the turn's last tool call: see Handoff in the guidelines)");
    if (!["pm", "lead", "reviewer"].includes(name)) expect(line, name).toContain("wip commit");
  }
});

test("R9b: the guidelines say the office wakes first and the watcher is the second line; pm.md and lead.md say what the office does; both READMEs and the decisions log carry it", () => {
  const w = section("Watching and waking");
  for (const s of [
    "**The office wakes first.**", "whose process has ended while their board row is `doing` or `review`", "through the same checks as `f1rm wake`, caps included",
    "`resumed after the session limit; continue your task`", "a minute after its reset time", "`resumed after your session ended; continue your task`", "(an update, a crash, a shutdown) at once", "Each stop is woken once.",
    "(no reset time, a cap, an error)", "within 10 minutes of a wake with no new commit and no more than one assistant message after it (the reply to the wake)", "it tells the session in the hire's `Report to`",
    "`<name> stopped again after a wake; f1rm wake <name>`", "`<name> stopped at the session limit; f1rm wake <name>`", "NOTE column (`recovery` in `--json`)",
    "`your turn ended without a report; send your DONE or BLOCKED`", "the turn delivered no `SendMessage` whose first word is `DONE`, `APPROVED`, `CHANGES REQUESTED`, `BLOCKED`, `ESCALATE` or `NEEDS YOU`; text never counts",
    "wakes no interactive session, no PM, no hire that was let go", "no project that is not registered", "The watcher below is the second line",
    "**Ended**: the office wakes it within a minute", "the office wakes the leads after the reset and the PM waits for the user",
  ]) expect(w, s).toContain(s);
  expect(w).not.toContain("nothing wakes them");
  // The row goes done before the session is let go, since the office wakes a hire whose row still says doing or review.
  const closing = section("Teams");
  for (const s of ["marks each task's row `done` on its team board, lets its specialists go", "The PM then marks the team's row `done` and only after that lets the lead go with `f1rm letgo lead-<team>`"]) expect(closing, s).toContain(s);
  expect(role("lead").body).toContain("mark each task's row `done`, let your specialists");
  expect(guidelines).toContain("the PM (a simple task) or the team's lead marks the task's row `done` and lets the session go with `f1rm letgo <name>...`");
  expect(w).toContain("so does a hire still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported`");
  expect(w).toContain("A NOTE that says `reported` needs no wake: send your answer with `f1rm wake <name> \"<answer>\"` when you have one.");
  // F1: the report is the turn's last tool call, so the checkpoint comes first.
  expect(section("Handoff via SendMessage")).toContain("Checkpoint (wip commit, `resume.md`) before you send it, so the report is the turn's last tool call: the office skips an ended hire whose turn ended with a delivered report, and wakes one that kept working after it. A hire that sent a report and went on working is not nudged for a missing one.");
  expect(section("Handoff via SendMessage")).toContain("Send one `BLOCKED` message that lists every open question, and keep working on the rest.");
  expect(section("Handoff via SendMessage")).not.toContain("end that turn with your");
  expect(guidelines).toContain("A hire checkpoints before its report, so that it is the turn's last tool call (see Handoff); the PM's report is prose, not this.");
  for (const r of ["pm", "lead"]) {
    expect(role(r).body, r).toContain("woken by the office within a minute");
    expect(role(r).body, r).toContain("when `f1rm status` says it could not, or it is still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported`, run `f1rm wake");
    expect(role(r).body, r).toContain("or when it is still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported` (Watching");
    expect(role(r).body, r).toContain("A NOTE that says `reported` needs no wake.");
  }
  for (const file of [join(REPO, "README.md"), join(PLUGIN, "README.md")]) expect(readFileSync(file, "utf8"), file).toMatch(/office[^|\n]* (?:runs it|also wakes)[^|\n]*by itself/);
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const wakes = entries.find((e) => e.startsWith("2026-10-22 The office wakes limit-stopped hires"));
  const nudge = entries.find((e) => e.startsWith("2026-10-22 A hire whose turn ended without its report gets one nudge"));
  for (const part of ["about 1 minute after the parsed reset time", "resumed after the session limit; continue your task", "resumed after your session ended; continue your task", "each stop is woken once", "10 minutes", "stopped again after a wake; f1rm wake", "stopped at the session limit; f1rm wake", "never wakes interactive sessions, the PM, or a let-go hire", "lists a STOPPED worktree hire with the main repo as its folder", "resumes a specialist from `<repo>/.claude/worktrees/<task>` when that folder exists"]) expect(wakes, part).toContain(part);
  for (const part of ["20 minutes", "your turn ended without a report; send your DONE or BLOCKED", "it delivered no SendMessage whose first word is DONE, APPROVED, CHANGES REQUESTED, BLOCKED, ESCALATE or NEEDS YOU; text never counts", "once"]) expect(nudge, part).toContain(part);
  expect(wakes).toMatch(/- Where: office-recovery, [0-9a-f]{7,}/);
  expect(nudge).toMatch(/- Where: office-recovery, [0-9a-f]{7,}/);
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
  const refusals = "any `pstack:` skill other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only) is refused";
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
  expect(who).toMatch(/a cap override reach the user through the lead/);
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

test("K3: leads get pstack:architect or pstack:how only as a first command the PM names with --skills; the Reviewer runs no interrogate; the PM keeps grilling", () => {
  const lead = role("lead").body;
  for (const s of ["pstack:architect", "pstack:how", "tell the PM", "Haiku Explore"]) expect(lead, s).toContain(s);
  expect(role("lead").fm.skills).toEqual([GUIDELINES, "f1rm:hire"]);
  const reviewer = role("reviewer").body;
  expect(reviewer).toContain("the brief");
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
  for (const s of ["no PR opening", "no babysit loops", "no `/loop` ticks", "no `afk`", "`pstack:arena` and `pstack:swarm` are not wired inside hires", "at most 2 interns", "pushing stays the user's"]) expect(md, s).toContain(s);
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
  expect(section("Review and landing")).toContain("A conflict or a moved tip goes back to the dev as `CHANGES REQUESTED <slug> conflict`");
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
    "`resumed; continue your task`", "new session id", "counts against the caps like a hire", "refuses a hire that was let go, another project's hire, a live one (message it instead) and an unknown name",
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

test("W3: the pm and lead pickup steps wake any doing or review row whose hire has no live process, and their watcher rules wake an ended session", () => {
  const pick = /^1\. \*\*Pick up\.\*\*.*$/m.exec(role("pm").body)?.[0] ?? "";
  for (const s of ["no live process", "`f1rm status`", "run `f1rm wake <name>`", "Watching and waking"]) expect(pick, s).toContain(s);
  const read = /^2\. \*\*Read the brief and the board\.\*\*.*$/m.exec(role("lead").body)?.[0] ?? "";
  for (const s of ["`doing` or `review`", "no live process", "`f1rm status`", "run `f1rm wake <name>`", "Watching and waking"]) expect(read, s).toContain(s);
  for (const r of ["pm", "lead"]) {
    const body = role(r).body;
    expect(body, r).toMatch(/The office wakes an ended (session|lead) itself; when `f1rm status` says it could not, or it is still ended two minutes after the reset \(a limit stop\) or after the end \(any other stop\), unless its NOTE says `reported`, run `f1rm wake /);
    expect(body, r).toContain("re-hire only a hire that was let go or whose wake failed");
    expect(body, r).not.toMatch(/run `f1rm letgo/);
    expect(body, r).not.toContain("no live session; f1rm wake"); // the guidelines say it once
  }
});

test("W4: docs/decisions.md has the entries f1rm wake and A message to a hire with no live process says so", () => {
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const wake = entries.find((e) => e.startsWith("2026-10-22 f1rm wake\n"))!;
  const gate = entries.find((e) => e.startsWith("2026-10-22 A message to a hire with no live process says so\n"))!;
  for (const s of ["claude --bg --resume <session-id> --agent f1rm:<role> --name <name>", "same cap code", "was let go; hire a new one", "is live: message it instead", "claude attach"]) expect(wake, s).toContain(s);
  for (const s of ["no live session; f1rm wake <name>", "name [ref]", "unknown to the office", "root cause"]) expect(gate, s).toContain(s);
  for (const e of [wake, gate]) expect(e.split("\n").filter((l) => l.trim()).slice(1).map((l) => /^- (Decision|Why|Rejected|Where): \S/.exec(l)?.[1])).toEqual(["Decision", "Why", "Rejected", "Where"]);
});

test("R10a: a permission is answered in the office, and the rule is said once in the guidelines and pointed to from the roles", () => {
  const talk = section("Who talks to whom");
  const rule = /^- \*\*A permission is answered in the office\.\*\*.*$/m.exec(talk)?.[0] ?? "";
  for (const s of [
    "`BLOCKED <slug> permission`", "`NEEDS YOU <team>: permission for <hire>`", "approve <name>'s request in the office", "never runs the command itself",
    "at least 30 minutes", "a card on the hire's desk and in the top bar", "who asks, why", "Approve once", "Deny", "Always for this project", "exactly the allow rule Claude Code suggested", ".claude/settings.local.json",
    "falls back to the hire's own prompt", "Only the user's browser answers", "(see Gates)", "`--allowedTools",
  ]) expect(rule, s).toContain(s);
  expect(guidelines.split("approve <name>'s request in the office").length).toBe(3); // the rule, and the PM's line in the talk rules
  const gate = /^- A session can't answer a permission request\..*$/m.exec(section("Gates"))?.[0] ?? "";
  for (const s of ["approve, deny and always", "Bash", "refused", "Only the user's browser", "reads the command text", "`git commit -F`"]) expect(gate, s).toContain(s);
  expect(talk).toContain("`## Open question for the user`");
  for (const [name, text] of [["pm.md", role("pm").body], ["lead.md", role("lead").body]] as const) {
    expect(text, name).toContain("approve <name>'s request in the office");
    expect(text, name).toContain("Who talks to whom");
  }
  // No "until the card exists" (it exists) and no send to the hire's desk; the roles and the prompt never name `claude attach` (R8b).
  for (const [name, text] of [["guidelines", guidelines], ["pm.md", role("pm").body], ["lead.md", role("lead").body], ["prompt", pmPromptText()]] as const) {
    expect(text, name).not.toContain("permission card exists");
    expect(text, name).not.toContain("Jump to <name> in the office");
    expect(text, name).not.toMatch(/permission (?:block )?(?:goes )?(?:to|on) (?:the |a )?hire's (?:own )?desk/);
  }
  for (const [name, text] of [["README", readFileSync(join(REPO, "README.md"), "utf8")], ["plugin README", readFileSync(join(PLUGIN, "README.md"), "utf8")]] as const) {
    for (const s of ["Always for this project", "needs you"]) expect(text, name).toContain(s);
  }
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

test("W5: both READMEs list f1rm wake", () => {
  expect(readFileSync(join(REPO, "README.md"), "utf8")).toMatch(/^\| `f1rm wake` \|/m);
  expect(readFileSync(join(PLUGIN, "README.md"), "utf8")).toContain("`f1rm wake <name|id> [message]`");
});

test("report-files: the guidelines say once that every report is also a file, every sending role points to it, the lead reads reports from the watcher, and both READMEs and the log carry it", () => {
  const handoff = section("Handoff via SendMessage");
  expect(guidelines.split("**Every report is also a file.**")).toHaveLength(2);
  for (const s of [
    "`SendMessage` can return success while the message never arrives", "first runs `f1rm report <KIND> [<slug>]", "then sends its message, which stays the turn's last tool call; both carry the same words",
    "`CHANGES` (for `CHANGES REQUESTED`)", "a Reviewer's `<slug>` is `review-<task>`", "`~/.f1rm/evidence/<repo>/<slug>/report.json`", "`seq` rises by 1 on every write", "wakes the lead once for each new `seq` of a watched name (a `name:waiting` one too)",
    "REPORT column", "counts a report file written in the hire's turn as a delivered report", "The lead acts on a report it has not handled whether or not the message arrived",
  ]) expect(handoff, s).toContain(s.replace("[<slug>]", "<slug>"));
  expect(section("Watching and waking")).toContain("`<name>: reported <KIND> (commit <sha>, report.json seq <n>)`");
  expect(section("Watching and waking")).toContain("**Reported**: take the report as you would its message");
  for (const name of Object.keys(ROLES)) {
    const sends = !["pm", "lead"].includes(name);
    expect(role(name).body.includes("Every report is also a file"), name).toBe(sends);
    if (sends) expect(role(name).body, name).toContain("`f1rm report <KIND> " + (name === "reviewer" ? "review-<task>" : "<slug>") + " --commit <sha>`");
  }
  expect(role("lead").body).toContain("`<name>: reported <KIND> (...)` for each new report of a hire, which is how you read reports");
  expect(readFileSync(join(REPO, "README.md"), "utf8")).toMatch(/^\| `f1rm report` \|/m);
  expect(readFileSync(join(PLUGIN, "README.md"), "utf8")).toContain("`f1rm report <KIND> <slug> [--commit <sha>] [--note \"<one line>\"]`");
  const log = readFileSync(join(REPO, "docs", "decisions.md"), "utf8");
  expect(log.split("## 2026-10-23 Reports are also files")).toHaveLength(2);
});

// F3c: the text describes the flat workflow that `f1rm hire --simple`, `f1rm merge` and the owner sub-agent gate put in code.
const pluginReadme = () => readFileSync(join(PLUGIN, "README.md"), "utf8");
const hireSkill = () => readFileSync(join(PLUGIN, "skills", "hire", "SKILL.md"), "utf8");
const pmDecides = () => /const PM_DECIDES =\s*("[^\n]*");/.exec(readFileSync(join(REPO, "office", "server", "server.ts"), "utf8"))![1];

test("flat: a simple task is one specialist hired with --simple, landed by f1rm merge, then let go", () => {
  const w = section("Picking the workflow");
  for (const s of ["`f1rm hire --simple <role> <name> <task> \"<brief>\"`", "no lead, no team", "named `<role>-<task>`", "reports to the PM", "`f1rm merge <task>`", "`f1rm letgo <name>`", "a team of one in the project's cap of 2"]) expect(w, s).toContain(s);
  expect(w).not.toContain("one lead with a short team brief");
  const forms = section("Roster and hiring playbook").split("```")[1];
  expect(forms).toContain('f1rm hire --simple <role> <name> <task> "<brief>"');
  for (const [name, text] of [["pm.md", role("pm").body], ["prompt", pmPromptText()]] as const) {
    for (const s of ["f1rm hire --simple", "f1rm merge", "f1rm letgo", "Hire only leads for a milestone"]) expect(text, `${name}: ${s}`).toContain(s);
  }
  expect(pmDecides()).toContain("f1rm hire --simple");
  expect(pmDecides()).toContain("f1rm hire lead");
  expect(hireSkill()).toContain("--simple");
  expect(section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))).toContain("`f1rm merge <task>`");
});

test("flat: a dev reviews its own branch inside its session, once, and a second blocking round is NEEDS YOU", () => {
  const flow = section("Review and landing");
  for (const s of [
    "**Review inside the session.**", "ONE review in a fresh context", "general-purpose subagent", "`code-review` skill", "`git diff <base>...HEAD`", "`security-review`", "`--level high`",
    "so tell the subagent to read the diff itself", "Fix the blocking findings ONCE", "~/.f1rm/kept/<repo>/findings.md", "| date | area | status | finding | evidence |",
    "If a second review would still have blocking findings, do not fix again: send `NEEDS YOU <slug>`", "never delegates the implementation", "at least one failing test", "`f1rm merge` does not land it",
    "The `DONE` states the review round count and the review level",
  ]) expect(flow, s).toContain(s);
  for (const r of ["frontend-dev", "backend-dev"]) {
    const body = role(r).body;
    for (const s of ["Review inside your session", "Review and landing in the guidelines", "`NEEDS YOU <slug>`", "never delegate the implementation", "the review round count and level", "at least one failing test"]) expect(body, `${r}: ${s}`).toContain(s);
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

test("flat: owners run implementer subagents, plan once, get the plan approved once, and cannot hire devs", () => {
  const teams = section("Teams");
  for (const s of ["implementer subagents", "`implement-spec`", "plans once", "asks the user to approve the plan once", "`NEEDS YOU <team>: plan`", "then runs without asking again", "at most 2 implementers at a time", "its own worktree", "`worktree-<task>`", "`f1rm merge <task>`", "cannot hire a frontend-dev or a backend-dev"]) expect(teams, s).toContain(s);
  const lead = role("lead").body;
  for (const s of ["implementer subagent", "Plan once", "`NEEDS YOU <team>: plan`", "`f1rm merge", "never a dev", "`implement-spec`"]) expect(lead, s).toContain(s);
  expect(section("Spawning table").split("\n").find((l) => l.startsWith("| Lead"))).toContain("never a dev or a lead (enforced)");
  expect(section("Roster and hiring playbook")).toContain("never a dev");
  expect(section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("lead**"))).toContain("implementer");
});

test("flat: no sentence says a Reviewer reviews code or merges, that a lead hires a dev, or that the Reviewer is the only role that merges", () => {
  const stale = [/only role that merges/i, /\bReviewer\b[^.\n]*\bmerges\b/i, /Review and merge flow/i, /review-and-merge flow/i, /\bhire a Reviewer\b/i, /Reviewer after every/i, /lead hires? (?:a |its |the )?(?:frontend|backend)/i, /APPROVED[^\n]*merged=/, /Leave merging to the Reviewer/, /Reviewer's merge flow/i, /\bwho hire the rest\b/];
  const { hire: _hire, ...texts } = { ...WORKFLOW_FILES(), "hire skill": hireSkill(), PM_DECIDES: pmDecides() }; // hire.ts holds the dev's own-review paragraph
  for (const [name, text] of Object.entries(texts)) for (const re of stale) expect(text, `${name} ${re}`).not.toMatch(re);
});

test("flat: a simple task whose DONE has no landable commit is checked by the PM and let go without f1rm merge", () => {
  const w = section("Picking the workflow");
  for (const s of ["has no repo change, or only files `f1rm merge` refuses", "the PM checks the result against the brief and the content checklist itself", "marks the row `done` without running `f1rm merge`", "`f1rm letgo`, which archives any unmerged work first", "A simple designer or researcher gets no review session"]) expect(w, s).toContain(s);
  const wf = section("Workflows").split(/^- \*\*/m).find((e) => e.startsWith("pm**"))!;
  expect(wf).toContain("without running `f1rm merge`");
  expect(role("pm").body).toContain("without running `f1rm merge`");
  expect(pmPromptText()).toContain("without running f1rm merge");
  expect(section("Teams")).toContain("`git worktree remove` and `git branch -d`");
  expect(section("Teams")).toContain("git worktree add -b worktree-<task> .claude/worktrees/<task> <base>");
  expect(section("Definition of done")).toContain("the PM's own check against the brief and the content checklist");
  expect(section("Review and landing")).not.toContain("as before");
  expect(section("Messaging table")).not.toContain("back to a dev");
  expect(role("lead").body).not.toContain("back to its dev");
  expect(pluginReadme()).toContain("its simple tasks' devs");
});

test("flat: the plugin is 0.5.0 everywhere it is repeated, and docs/decisions.md has the Flat workflow entry", () => {
  expect(JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.5.0");
  const entries = readFileSync(join(REPO, "docs", "decisions.md"), "utf8").split(/^## /m).slice(1);
  const flat = entries.find((e) => e.startsWith("2026-10-28 Flat workflow\n")) ?? "";
  for (const s of ["f1rm hire --simple", "f1rm merge", "implementer", "plan once", "baseline-2026-10.md", "11099a6", "f517e70", "flat-prose"]) expect(flat, s).toContain(s);
});
