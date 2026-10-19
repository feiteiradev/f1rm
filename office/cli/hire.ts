// `f1rm hire`: the only way the PM starts a lead or a specialist and a lead starts its team, so the caps live in code. The office's Hire dialog uses `planHire` too.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FOUNDER_ONLY, MODELS, roleOfAgentType } from "../people.ts";
import { editionFile, readEdition, type Edition } from "../server/editions.ts";
import { claudeEnv, machine } from "../server/machine.ts";

export const USAGE =
  "usage: f1rm hire [--override] [--report-to <pm session>] [--team <team>] <role> <name> <task> <brief> [claude flags...]\n" +
  "       f1rm hire lead lead-<team> <team> <brief>";

const AGENTS = join(import.meta.dir, "..", "..", "plugin", "agents");
/** Working background sessions on the whole machine, leads and the user's own included. */
export const CAP = 6;
/** Live leads in one repo, and working sessions in one team (its Reviewer included). */
export const TEAMS = 2, TEAM_CAP = 2;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// /research and /security-review are slash commands, not Skill-tool skills, so no role lists them under `skills:`.
const SLASH_ONLY: Record<string, string[]> = { reviewer: ["security-review"], researcher: ["research"] };
// ponytail: a deny rule only slows an honest model down; `git -C . push` gets past it. A real block needs a hook.
const REVIEWER_DISALLOWED = ["--disallowedTools", "Bash(git push *)"];

/** The PM session name `f1rm pm` gives this repo; a hire reports to it. */
export function pmName(cwd: string, m: Pick<typeof machine, "gitCommonDir"> = machine): string {
  const common = m.gitCommonDir(cwd);
  return `pm-${basename(common ? dirname(common) : cwd).replace(/[^\w.-]+/g, "-")}`;
}

export type Role = { id: string; description: string; model: string; skills: string[] };

/** The hireable roles, read from the plugin folder on every call: its role files minus the PM. Skills are in the order the brief loads them, slash-only commands last. */
export function readRoles(): Role[] {
  return readdirSync(AGENTS)
    .map((f) => basename(f, ".md"))
    .filter((id) => id !== "pm")
    .map((id) => {
      const file = readFileSync(join(AGENTS, `${id}.md`), "utf8");
      const fm = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(file)![1]) as { description?: string; model?: string; skills?: string[] };
      return { id, description: fm.description ?? "", model: fm.model ?? "", skills: [...(fm.skills ?? []), ...(SLASH_ONLY[id] ?? [])] };
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
  /** Flags that go to claude as given. */
  extra?: string[];
};

/**
 * Checks a hire and returns the exact `claude` argv that starts it. Throws an Error for a bad role, task name or model,
 * and a HireRefused when the cap is full or the working hires can't be counted. The caller spawns it.
 */
export async function planHire(req: HireRequest, m: Pick<typeof machine, "backgroundSessions"> = machine): Promise<string[]> {
  const { role, task, team, cwd, brief, model, override, extra = [] } = req;
  const roles = readRoles();
  if (!roles.some((r) => r.id === role)) {
    throw new Error(`unknown role "${role}": hire one of ${roles.map((r) => r.id).join(", ")}. The PM is started with \`f1rm pm\`.`);
  }
  if (!task || !brief) throw new Error(USAGE);
  if (!SLUG.test(task)) throw new Error(`${role === "lead" ? "team" : "task"} "${task}" must be lowercase words joined by hyphens`);
  if (team != null && !SLUG.test(team)) throw new Error(`team "${team}" must be lowercase words joined by hyphens`);
  if (team != null && role === "lead") throw new Error("a lead heads a team and joins none: only the PM hires leads, without --team");
  if (model && !MODELS.includes(model)) throw new Error(`model "${model}" must be one of ${MODELS.join(", ")}`);
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
  const [first, ...rest] = roles.find((r) => r.id === role)!.skills;
  const more = rest.length ? ` Before you start, load these with the Skill tool: ${rest.join(", ")}.` : "";
  const prompt = `/${first}${more}${reportTo ? ` Report to: ${reportTo}` : ""}\n\n${brief}`;
  // The flags go after the prompt: --disallowedTools takes any number of values and would swallow a prompt that follows it.
  // A lead writes no code, and a Reviewer merges into the main checkout (from its own scratch worktree), so both work in the repo itself, where `f1rm hire` runs.
  const argv = ["claude", "--bg", "--agent", `f1rm:${role}`, "--name", name, ...(lead || role === "reviewer" ? [] : ["--worktree", task]), prompt, ...extra];
  if (model) argv.push("--model", model);
  if (role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return argv;
}

/** Runs `f1rm hire` and returns the exit code. */
export async function hire(args: string[]): Promise<number> {
  let override = false;
  let reportTo: string | undefined, team: string | undefined;
  for (;;) {
    if (args[0] === "--override") override = !!args.shift();
    else if (args[0] === "--report-to") (args.shift(), (reportTo = args.shift()));
    else if (args[0] === "--team") (args.shift(), (team = args.shift()));
    else break;
  }
  const [role, name, task, brief, ...extra] = args;
  if (role === "--help" || role === "-h") return console.log(USAGE), 0;
  if (!role) throw new Error(USAGE);
  let argv: string[];
  try {
    argv = await planHire({ role, name, task, team, cwd: process.cwd(), edition: readEdition(editionFile(process.cwd())), brief, reportTo: reportTo ?? pmName(process.cwd()), override, extra });
  } catch (err) {
    if (err instanceof HireRefused && err.working !== null) {
      throw new Error(
        `${err.message} Do not hire. Tell the user, leave the task todo, and ask whether to wait or exceed the cap. Only if they approve this hire, rerun with --override.`,
      );
    }
    throw err;
  }
  const proc = Bun.spawn(argv, { env: claudeEnv(), stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}
