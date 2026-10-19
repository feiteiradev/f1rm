// `f1rm hire`: the only way the PM starts a lead or a specialist and a lead starts its team, so the caps live in code. The office's Hire dialog uses `planHire` too.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FOUNDER_ONLY, MODELS, roleOfAgentType } from "../people.ts";
import { editionFile, readEdition, type Edition } from "../server/editions.ts";
import { claudeEnv, machine } from "../server/machine.ts";

export const USAGE =
  "usage: f1rm hire [--override] [--report-to <pm session>] [--team <team>] [--skills a,b] [--level low|medium|high] [--content] <role> <name> <task> <brief> [claude flags...]\n" +
  "       f1rm hire lead lead-<team> <team> <brief>";

const AGENTS = join(import.meta.dir, "..", "..", "plugin", "agents");
/** Working background sessions on the whole machine, leads and the user's own included. */
export const CAP = 6;
/** Live leads in one repo, and working sessions in one team (its Reviewer included). */
export const TEAMS = 2, TEAM_CAP = 2;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// /research is a slash command: given in `--skills` it becomes the brief's first command instead of joining the list.
const SLASH_ONLY = ["research"];
// /security-review reviews the git state where it runs, so it never runs at the start: a high-level Reviewer runs it on the merge.
// The skill gate (server.ts) reads these two sentences from the first prompt: the list to load, and the APPROVED hold.
export const LOAD_FIRST = " Before you start, load these with the Skill tool: ";
export const SECURITY = " Before you send APPROVED, run security-review with the Skill tool from the scratch worktree, with <base>...<merge sha> as its args.";
const LEVELS = ["low", "medium", "high"];
/** What a content review (no code) drops from the reviewer's skills. */
const CODE_REVIEW = ["code-review", "ponytail:ponytail-review", "security-review"];
// ponytail: a deny rule only slows an honest model down; `git -C . push` gets past it. A real block needs a hook.
const REVIEWER_DISALLOWED = ["--disallowedTools", "Bash(git push *)"];

/** The PM session name `f1rm pm` gives this repo; a hire reports to it. */
export function pmName(cwd: string, m: Pick<typeof machine, "gitCommonDir"> = machine): string {
  const common = m.gitCommonDir(cwd);
  return `pm-${basename(common ? dirname(common) : cwd).replace(/[^\w.-]+/g, "-")}`;
}

export type Role = { id: string; description: string; model: string; skills: string[] };

/** The hireable roles, read from the plugin folder on every call: its role files minus the PM. Skills are in the order the brief loads them. */
export function readRoles(): Role[] {
  return readdirSync(AGENTS)
    .map((f) => basename(f, ".md"))
    .filter((id) => id !== "pm")
    .map((id) => {
      const file = readFileSync(join(AGENTS, `${id}.md`), "utf8");
      const fm = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(file)![1]) as { description?: string; model?: string; skills?: string[] };
      return { id, description: fm.description ?? "", model: fm.model ?? "", skills: fm.skills ?? [] };
    });
}

/** The cap, or a count that can't be made, stopped a hire. `working` is null when it couldn't count. */
export class HireRefused extends Error {
  constructor(message: string, readonly working: number | null) {
    super(message);
  }
}

export type HireRequest = {
  role: string;
  /** Checked against the name the hire must have, when given. */
  name?: string;
  /** For a lead, the team's slug. */
  task: string;
  /** The team a specialist joins: it reports to `lead-<team>`. */
  team?: string | null;
  /** The repo's main working directory, where leads run and worktrees live. */
  cwd: string;
  /** The project's edition; a founder role is hired only in a Founder project. Work when not chosen. */
  edition?: Edition | null;
  brief: string;
  /** The PM session the hire reports to, or null when the project has none. */
  reportTo: string | null;
  /** `haiku`, `sonnet` or `opus` in place of the role's own model. */
  model?: string | null;
  override?: boolean;
  /** Skills added to the brief's list; a slash-only one becomes its first command. */
  skills?: string[];
  /** The reviewer's `/code-review` level: low, medium (the default) or high, which also loads `security-review`. */
  level?: string | null;
  /** A reviewer of a branch with no code: the guidelines' content checklist, on sonnet unless a model is given. */
  content?: boolean;
  /** Flags that go to claude as given. */
  extra?: string[];
};

/**
 * Checks a hire and returns the exact `claude` argv that starts it. Throws an Error for a bad role, task name or model,
 * and a HireRefused when the cap is full or the working hires can't be counted. The caller spawns it.
 */
export async function planHire(req: HireRequest, m: Pick<typeof machine, "backgroundSessions"> = machine): Promise<string[]> {
  const { role, task, team, cwd, brief, model, override, level, content, skills: added = [], extra = [] } = req;
  const roles = readRoles();
  if (!roles.some((r) => r.id === role)) {
    throw new Error(`unknown role "${role}": hire one of ${roles.map((r) => r.id).join(", ")}. The PM is started with \`f1rm pm\`.`);
  }
  if (!task || !brief) throw new Error(USAGE);
  if (!SLUG.test(task)) throw new Error(`${role === "lead" ? "team" : "task"} "${task}" must be lowercase words joined by hyphens`);
  if (team != null && !SLUG.test(team)) throw new Error(`team "${team}" must be lowercase words joined by hyphens`);
  if (role === "reviewer" && !task.startsWith("review-")) throw new Error(`a Reviewer's task is review-<task>, for the task it reviews, not "${task}"`);
  if (team != null && role === "lead") throw new Error("a lead heads a team and joins none: only the PM hires leads, without --team");
  if (model && !MODELS.includes(model)) throw new Error(`model "${model}" must be one of ${MODELS.join(", ")}`);
  if (level != null && !LEVELS.includes(level)) throw new Error(`level "${level}" must be one of ${LEVELS.join(", ")}`);
  if ((level != null || content) && role !== "reviewer") throw new Error(`--level and --content are for the reviewer only, not ${role}`);
  if (level != null && content) throw new Error("--level is for a code review, and --content has none");
  if (added.includes("security-review")) throw new Error("security-review runs on the merge, not at the start: hire the reviewer with --level high");
  const known = roleOfAgentType(`f1rm:${role}`);
  if (known && FOUNDER_ONLY.has(known) && req.edition !== "founder") {
    throw new Error(`${role} is a Founder role and this is a Work project. Switch it with \`f1rm edition founder\` to hire one.`);
  }
  const lead = role === "lead";
  const name = lead ? `lead-${task}` : team ? `${team}.${role}-${task}` : `${role}-${task}`;
  if (req.name && req.name !== name) throw new Error(`this hire's name must be "${name}"`);
  const reportTo = team ? `lead-${team}` : req.reportTo;

  const live = await m.backgroundSessions();
  if (live === null) throw new HireRefused("can't count the working hires (`claude agents --json` failed), so not hiring", null);
  const busy = live.filter((s) => s.state === "working" || s.state === "blocked");
  if (team && !live.some((s) => s.name === `lead-${team}` && s.cwd === cwd)) throw new Error(`team "${team}" has no lead running in this repo (lead-${team})`);
  // A Reviewer has no worktree of its own, so its name is what tells two reviews of one task apart.
  if (role === "reviewer" && live.some((s) => s.name === name && s.cwd === cwd)) throw new Error(`a session named "${name}" is already running: one Reviewer per task`);
  // One specialist per task, whatever the caps say: a second hire there would work the same branch.
  if (!lead && live.some((s) => s.cwd === join(cwd, ".claude", "worktrees", task))) throw new Error(`a session already works on task "${task}": one specialist per task`);
  if (!override) {
    if (busy.length >= CAP) throw new HireRefused(`${busy.length} hires are already working (the cap is ${CAP}).`, busy.length);
    const leads = live.filter((s) => s.name.startsWith("lead-") && s.cwd === cwd).length;
    if (lead && leads >= TEAMS) throw new HireRefused(`this project already has ${leads} teams (the cap is ${TEAMS}).`, busy.length);
    const members = team ? busy.filter((s) => s.name.startsWith(`${team}.`)).length : 0;
    if (members >= TEAM_CAP) throw new HireRefused(`team ${team} already has ${members} working (the cap is ${TEAM_CAP} per team).`, busy.length);
  }

  // Live on Claude Code 2.1.300 only the first slash command of a chain expands, so the rest go through the Skill tool.
  // ponytail: the Skill-tool step loaded a skill in 6 of 8 spike runs; inline the skill text with --append-system-prompt-file if hires miss it.
  let own = roles.find((r) => r.id === role)!.skills;
  if (content) own = own.filter((s) => !CODE_REVIEW.includes(s));
  const slash = added.find((s) => SLASH_ONLY.includes(s));
  const [first, ...rest] = slash ? [slash, ...own, ...added.filter((s) => s !== slash)] : [...own, ...added];
  // The branch under review is named, so the review reads it and not the main checkout's working tree.
  const command = role === "reviewer" && !content && !slash ? `${first} ${level ?? "medium"} worktree-${task.replace(/^review-/, "")}` : first;
  const more = (rest.length ? `${LOAD_FIRST}${rest.join(", ")}.` : "") + (level === "high" ? SECURITY : "");
  const prompt = `/${command}${more}${reportTo ? ` Report to: ${reportTo}` : ""}\n\n${content ? "This branch holds no code: use the content checklist.\n" : ""}${brief}`;
  // The flags go after the prompt: --disallowedTools takes any number of values and would swallow a prompt that follows it.
  // A lead writes no code, and a Reviewer merges into the main checkout (from its own scratch worktree), so both work in the repo itself, where `f1rm hire` runs.
  const argv = ["claude", "--bg", "--agent", `f1rm:${role}`, "--name", name, ...(lead || role === "reviewer" ? [] : ["--worktree", task]), prompt, ...extra];
  if (model) argv.push("--model", model);
  else if (content && !extra.includes("--model")) argv.push("--model", "sonnet");
  if (role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return argv;
}

/** Runs `f1rm hire` and returns the exit code. */
export async function hire(args: string[]): Promise<number> {
  let override = false;
  let reportTo: string | undefined, team: string | undefined, level: string | undefined, content = false, skills: string[] = [];
  for (;;) {
    if (args[0] === "--override") override = !!args.shift();
    else if (args[0] === "--report-to") (args.shift(), (reportTo = args.shift()));
    else if (args[0] === "--team") (args.shift(), (team = args.shift()));
    else if (args[0] === "--skills") (args.shift(), (skills = (args.shift() ?? "").split(",").filter(Boolean)));
    else if (args[0] === "--level") (args.shift(), (level = args.shift()));
    else if (args[0] === "--content") content = !!args.shift();
    else break;
  }
  const [role, name, task, brief, ...extra] = args;
  if (role === "--help" || role === "-h") return console.log(USAGE), 0;
  if (!role) throw new Error(USAGE);
  let argv: string[];
  try {
    argv = await planHire({ role, name, task, team, cwd: process.cwd(), edition: readEdition(editionFile(process.cwd())), brief, reportTo: reportTo ?? pmName(process.cwd()), override, skills, level, content, extra });
  } catch (err) {
    if (err instanceof HireRefused && err.working !== null) {
      throw new Error(
        `${err.message} Do not hire; leave the task todo. Tell the session you report to. Only the PM asks the user, and only after the user approves this hire is it rerun with --override.`,
      );
    }
    throw err;
  }
  const proc = Bun.spawn(argv, { env: claudeEnv(), stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}
