// `f1rm hire`: the only way the PM starts a lead or a specialist and a lead starts its team, so the caps live in code. The office's Hire dialog uses `planHire` too.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FOUNDER_ONLY, MODELS, roleOfAgentType } from "../people.ts";
import { editionFile, readEdition, type Edition } from "../server/editions.ts";
import { hireRefusal, pausedDirOf, pausedFile, readPaused, type Paused } from "../server/pause.ts";
import { claudeEnv, machine } from "../server/machine.ts";
import { withUsageTap } from "../usage.ts";

export const USAGE =
  "usage: f1rm hire [--override] (the user's own terminal only) [--report-to <pm session>] [--team <team>] [--simple] [--skills a,b] [--level low|medium|high] [--content] <role> <name> <task> <brief> [claude flags...]\n" +
  "       f1rm hire lead lead-<team> <team> <brief>";

const AGENTS = join(import.meta.dir, "..", "..", "plugin", "agents");
/** Working background sessions on the whole machine, leads and the user's own included. */
export const CAP = 8;
/** Live leads in one repo, and working sessions in one team (its Reviewer included). */
export const TEAMS = 2, TEAM_CAP = 2;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// /research is a slash command: given in `--skills` it becomes the brief's first command instead of joining the list.
// pstack's poteto-mode, architect and how carry disable-model-invocation, so the Skill tool refuses them: each runs only as the first command, and a hire has one.
// A dev's own first skill is poteto-mode, so no other slash-only skill can be added to a dev; architect and how are for a lead.
const SLASH_ONLY = ["research", "pstack:poteto-mode", "pstack:architect", "pstack:how"];
const LEAD_ONLY = ["pstack:architect", "pstack:how"];
// The skill gate (server.ts) reads these two sentences from the first prompt: the list to load, and the APPROVED hold (SECURITY: only a session from before the Reviewer left the normal flow carries it, and a wake keeps it).
export const LOAD_FIRST = " Before you start, load these with the Skill tool: ";
export const SECURITY = " Before you send APPROVED, run security-review with the Skill tool from the scratch worktree, with <base>...<merge sha> as its args.";
const LEVELS = ["low", "medium", "high"];
/** The two roles that write code: they review their own work (see `reviewParagraph`), and a lead's team has none of them. */
const DEVS = ["frontend-dev", "backend-dev"];
/** What a content review (no code) drops from the reviewer's skills. */
const CODE_REVIEW = ["code-review", "mattpocock-skills:code-review", "ponytail:ponytail-review", "security-review"];
// The office's delegation gate refuses every push in any form; this deny rule is the fallback for when the office is down and the hooks fail open.
// ponytail: it only slows an honest model down; `git -C . push` gets past it.
export const REVIEWER_DISALLOWED = ["--disallowedTools", "Bash(git push *)"];

/**
 * The claude flags that start a hire at ponytail full, ahead of the caller's own flags. Ultra adds "question the request, push back", which stalls an unattended worker, so only a lead keeps the config default.
 * The level rides in the session's `--settings` env: the daemon starts a `--bg` session with its own environment, so a variable set on the `claude --bg` process never reaches the SessionStart hook (measured on Claude Code 2.1.309).
 * A `--settings` the caller passes gets the env merged in (their own PONYTAIL_DEFAULT_MODE wins), since only the last of two flags would count.
 * ponytail shortcut: a `--settings` that is a file path, not JSON, is left as given and that hire gets the config default; merge the file's JSON if one is ever passed.
 */
export function withPonytail(role: string, flags: string[]): string[] {
  if (role === "lead") return flags;
  const at = flags.indexOf("--settings");
  if (at < 0) return ["--settings", JSON.stringify({ env: { PONYTAIL_DEFAULT_MODE: "full" } }), ...flags];
  try {
    const own = JSON.parse(flags[at + 1] ?? "");
    if (own === null || typeof own !== "object" || Array.isArray(own)) return flags;
    const merged = JSON.stringify({ ...own, env: { PONYTAIL_DEFAULT_MODE: "full", ...own.env } });
    return flags.map((f, i) => (i === at + 1 ? merged : f));
  } catch {
    return flags;
  }
}

/** Coordination (the PM and every lead) starts at `--effort medium`, every other role at high; an `--effort` the caller passes wins, so none is added twice. */
export function withEffort(role: string, flags: string[]): string[] {
  if (flags.some((f) => f === "--effort" || f.startsWith("--effort="))) return flags;
  return [...flags, "--effort", role === "lead" || role === "pm" ? "medium" : "high"];
}

/** Claude Code's name for a working directory's project folder: every character that is not a letter or digit becomes `-`. */
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Claude Code cuts a project folder name at 200 characters (and adds a hash). A worktree's folder is the repo's plus `--claude-worktrees-<task>`, found by that prefix, so a cut name
 * still matches while the cut keeps the whole prefix. 150 leaves room for it with a margin; a task slug has no cap, but the prefix stays whole whatever its length.
 */
export const MAX_FOLDER = 150;

/** Why `f1rm status` can't serve a repo (the PM and the leads watch with it), or null: its project folder name is too long. Checked by `f1rm status` on the repo it runs in, and by `f1rm pm`, `f1rm hire` and the office's Hire endpoint (through planHire) on the root of a git repo (see `rootTooLong`). */
export const pathTooLong = (repo: string): string | null =>
  projectFolder(repo).length > MAX_FOLDER
    ? `this repo's path is too long for f1rm status (Claude Code cuts the project folder name; the limit is ${MAX_FOLDER} characters, so the \`--claude-worktrees-\` prefix of a worktree's folder stays whole)`
    : null;

/** `pathTooLong` for the repo a command runs in, given its git common dir: the root of a git repo (not the subfolder it ran from), and nothing outside git, where `f1rm pm` and `f1rm hire` still work. */
export const rootTooLong = (common: string | null): string | null => (common ? pathTooLong(dirname(common)) : null);

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

/**
 * A hire was refused. `working` is the number of working hires when a cap refused it: the caller then adds the advice to leave the task todo and tell the session to report to.
 * It is null for any other refusal (the hires couldn't be counted, the repo's path is too long): the message then stands alone.
 */
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
  /** The session the hire reports to: a name, none, or a lookup planHire calls only after its checks (it may run git). */
  reportTo: string | null | (() => string | null);
  /** `haiku`, `sonnet` or `opus` in place of the role's own model. */
  model?: string | null;
  override?: boolean;
  /** Skills added to the brief's list; a slash-only one becomes its first command. */
  skills?: string[];
  /** The level of a dev's own review: low, medium (the default) or high, which also runs `security-review` on the diff. The two devs only. */
  level?: string | null;
  /** A reviewer of a branch with no code: the guidelines' content checklist, on sonnet unless a model is given. The only Reviewer there is. */
  content?: boolean;
  /** A simple task: the PM's one dev, designer or researcher with no lead and no team. It counts as a team of one in the project's cap. */
  simple?: boolean;
  /** Flags that go to claude as given. */
  extra?: string[];
  /** The project's pause, when it is paused: nothing is hired into it. */
  paused?: Paused | null;
};

/** The live background sessions Claude Code lists, as `machine.backgroundSessions` gives them. */
export type LiveHires = { name: string; state: string; cwd: string; status?: "busy" | "idle" }[];

/**
 * The checks every start of a session passes, a new hire or a woken one (`f1rm wake`): the team's lead runs, one Reviewer and one specialist per task, and the caps
 * (8 working on the machine, 2 teams per project, 2 working per team). A simple task is a team of one: live leads and live simple tasks make up the teams. Throws an Error, or a HireRefused for a cap. `override` skips the caps only.
 */
export function checkSlots(live: LiveHires, { role, name, task, team, cwd, override }: { role: string; name: string; task: string; team?: string | null; cwd: string; override?: boolean }): void {
  const lead = role === "lead";
  // A hire with no team that is no lead and no Reviewer is a team of one, whoever starts it (the PM's --simple, the Hire dialog) and whether it is started or woken.
  const simple = !lead && !team && role !== "reviewer";
  const busy = live.filter((s) => s.state === "working" || s.state === "blocked");
  if (team && !live.some((s) => s.name === `lead-${team}` && s.cwd === cwd)) throw new Error(`team "${team}" has no lead running in this repo (lead-${team})`);
  // A Reviewer has no worktree of its own, so its name is what tells two reviews of one task apart.
  if (role === "reviewer" && live.some((s) => s.name === name && s.cwd === cwd)) throw new Error(`a session named "${name}" is already running: one Reviewer per task`);
  // One specialist per task, whatever the caps say: a second hire there would work the same branch.
  if (!lead && live.some((s) => s.cwd === join(cwd, ".claude", "worktrees", task))) throw new Error(`a session already works on task "${task}": one specialist per task`);
  if (!override) {
    if (busy.length >= CAP) throw new HireRefused(`${busy.length} hires are already working (the cap is ${CAP}).`, busy.length);
    // A simple task is a hire named <role>-<task> (no team, no lead, no Reviewer) in a worktree of this repo; a session of the user's own with another name is none.
    const worktrees = join(cwd, ".claude", "worktrees") + "/";
    const solo = new RegExp(`^(?:${readRoles().map((r) => r.id).filter((id) => id !== "lead" && id !== "reviewer").join("|")})-${SLUG.source.slice(1, -1)}$`);
    const teams = live.filter((s) => (s.name.startsWith("lead-") && s.cwd === cwd) || (solo.test(s.name) && s.cwd.startsWith(worktrees))).length;
    if ((lead || simple) && teams >= TEAMS) throw new HireRefused(`this project already has ${teams} teams (the cap is ${TEAMS}).`, busy.length);
    // A member that ended its turn (after its DONE, say) sits idle but keeps state "working", so only that pair frees the slot; a blocked member, or one with no or another status, counts as working.
    const members = team ? busy.filter((s) => s.name.startsWith(`${team}.`) && !(s.state === "working" && s.status === "idle")).length : 0;
    if (members >= TEAM_CAP) throw new HireRefused(`team ${team} already has ${members} working (the cap is ${TEAM_CAP} per team).`, busy.length);
  }
}

/** The paragraph a dev's prompt carries ahead of its brief: its own review, in its session, at the level the PM or lead chose. `repo` is the repo folder's name, `task` the dev's report slug. */
const reviewParagraph = (task: string, repo: string, level: string) =>
  `Review inside your session. After your checks pass, run ONE review in a fresh context: start a general-purpose subagent with the Agent tool and tell it to run the code-review skill at level ${level} on \`git diff <base>...HEAD\` (<base> is the branch your task started from)` +
  `${level === "high" ? ", and the security-review skill on that same diff" : ""}. Have it sort its findings as blocking or non-blocking. Fix the blocking findings ONCE and run your checks again. ` +
  `Send the non-blocking findings to ~/.f1rm/kept/${repo}/findings.md as lines in its table format (| date | area | status | finding | evidence |). ` +
  `If a second review would still have blocking findings, run \`f1rm report ESCALATE ${task}\` and send \`ESCALATE ${task}\` to your Report to session instead of fixing again: its owner decides (re-scope, one more fix pass, or accept with the finding logged). ` +
  `Implement inline and never delegate the implementation: the one subagent you start is this reviewer (and at most 2 interns, as before). Your DONE states the review round count and the review level. ` +
  `Put at least one failing test in every task: a branch of test-only or renamed tests has no failing new test, and \`f1rm merge\` will not land it. If the task cannot have one, send \`ESCALATE ${task}\`: its owner decides.`;

/**
 * Checks a hire and returns the exact `claude` argv that starts it. Throws an Error for a bad role, task name or model,
 * and a HireRefused when the cap is full, the working hires can't be counted, or the repo's path is too long. The caller spawns it.
 */
export async function planHire(req: HireRequest, m: Pick<typeof machine, "backgroundSessions" | "gitCommonDir"> = machine): Promise<string[]> {
  const { role, task, team, cwd, brief, model, override, level, simple, skills: added = [], extra = [] } = req;
  const content = role === "reviewer"; // the only Reviewer left reviews a branch with no code
  const dev = DEVS.includes(role);
  const roles = readRoles();
  if (!roles.some((r) => r.id === role)) {
    throw new Error(`unknown role "${role}": hire one of ${roles.map((r) => r.id).join(", ")}. The PM is started with \`f1rm pm\`.`);
  }
  if (!task || !brief) throw new Error(USAGE);
  if (!SLUG.test(task)) throw new Error(`${role === "lead" ? "team" : "task"} "${task}" must be lowercase words joined by hyphens`);
  if (team != null && !SLUG.test(team)) throw new Error(`team "${team}" must be lowercase words joined by hyphens`);
  if (simple && (team != null || role === "lead" || role === "reviewer")) throw new Error("--simple is for one dev, designer or researcher the PM hires with no team: not with --team, and not for a lead or a reviewer");
  if (role === "reviewer" && !task.startsWith("review-")) throw new Error(`a Reviewer's task is review-<task>, for the task it reviews, not "${task}"`);
  if (team != null && role === "lead") throw new Error("a lead heads a team and joins none: only the PM hires leads, without --team");
  if (team != null && dev) throw new Error(`an owner runs implementer subagents, not a session per task; hire a designer, a researcher, or a --content reviewer, not a ${role}`);
  if (model && !MODELS.includes(model)) throw new Error(`model "${model}" must be one of ${MODELS.join(", ")}`);
  if (level != null && !LEVELS.includes(level)) throw new Error(`level "${level}" must be one of ${LEVELS.join(", ")}`);
  if (level != null && !dev) throw new Error(`--level is for the two devs (frontend-dev, backend-dev): it sets the level of their own review, not ${role}'s`);
  if (req.content && role !== "reviewer") throw new Error(`--content is for the reviewer only, not ${role}`);
  if (role === "reviewer" && !req.content) throw new Error("a Reviewer reviews a branch with no code: hire it with --content");
  const own_ = extra.find((a) => /^(?:--(?:agent|name|worktree)|-n|-w)(?:=|$)/.test(a));
  if (own_) throw new Error(`${own_.split("=")[0]} is the hire's own: f1rm hire sets its agent, name and worktree`);
  if (added.includes("security-review")) throw new Error("security-review runs in a dev's own review, at --level high: it is not added to a hire");
  // Every pstack skill but setup-pstack carries disable-model-invocation, so the Skill tool refuses it: only the three pstack skills in SLASH_ONLY can be a first command.
  const unwired = added.find((s) => s.startsWith("pstack:") && !SLASH_ONLY.includes(s));
  if (unwired) throw new Error(`${unwired} is not wired inside hires`);
  const leadOnly = added.find((s) => LEAD_ONLY.includes(s));
  if (leadOnly && role !== "lead") throw new Error(`${leadOnly} is for a lead only: the PM gives it when it hires one`);
  let own = roles.find((r) => r.id === role)!.skills;
  if (content) own = own.filter((s) => !CODE_REVIEW.includes(s));
  const slashes = [...new Set([...own.slice(0, 1), ...added])].filter((s) => SLASH_ONLY.includes(s));
  if (added.includes("pstack:poteto-mode") && own[0] !== "pstack:poteto-mode") throw new Error(`pstack:poteto-mode is for the two devs only: its playbooks would replace a ${role}'s own work`);
  if (slashes.length > 1) {
    throw new Error(
      SLASH_ONLY.includes(own[0])
        ? `${slashes[1]} is slash-only, and a ${role}'s first command is ${own[0]}: drop it`
        : `${slashes.join(" and ")} are slash-only (the Skill tool refuses them) and a hire has one first command: drop one`,
    );
  }
  const known = roleOfAgentType(`f1rm:${role}`);
  if (known && FOUNDER_ONLY.has(known) && req.edition !== "founder") {
    throw new Error(`${role} is a Founder role and this is a Work project. Switch it with \`f1rm edition founder\` (after \`f1rm pm\` has registered the project) to hire one.`);
  }
  const lead = role === "lead";
  const name = lead ? `lead-${task}` : team ? `${team}.${role}-${task}` : `${role}-${task}`;
  if (req.name && req.name !== name) throw new Error(`this hire's name must be "${name}"`);
  const reportTo = team ? `lead-${team}` : req.reportTo;

  if (req.paused) throw new HireRefused(hireRefusal(basename(cwd), req.paused), null);
  const tooLong = rootTooLong(m.gitCommonDir(cwd));
  if (tooLong) throw new HireRefused(tooLong, null);

  const live = await m.backgroundSessions();
  if (live === null) throw new HireRefused("can't count the working hires (`claude agents --json` failed), so not hiring", null);
  checkSlots(live, { role, name, task, team, cwd, override });

  // Live on Claude Code 2.1.300 only the first slash command of a chain expands, so the rest go through the Skill tool.
  // ponytail: the Skill-tool step loaded a skill in 6 of 8 spike runs; inline the skill text with --append-system-prompt-file if hires miss it.
  // Every added skill loads ahead of the role's later ones (a bug's diagnosing-bugs before tdd).
  const slash = added.find((s) => SLASH_ONLY.includes(s));
  const [first, ...rest] = [...new Set([slash ?? own[0], ...added, ...own])];
  const more = rest.length ? `${LOAD_FIRST}${rest.join(", ")}.` : "";
  const reportName = typeof reportTo === "function" ? reportTo() : reportTo;
  const prompt = `/${first}${more}${reportName ? ` Report to: ${reportName}` : ""}\n\n${content ? "This branch holds no code: use the content checklist.\n" : ""}${dev ? reviewParagraph(task, basename(cwd), level ?? "medium") + "\n\n" : ""}${brief}`;
  // The flags go after the prompt: --disallowedTools takes any number of values and would swallow a prompt that follows it.
  // A lead writes no code, and a content Reviewer reads the branch from its own scratch worktree, so both work in the repo itself: they start at its root, whatever folder `f1rm hire` ran from.
  const argv = ["claude", "--bg", "--agent", `f1rm:${role}`, "--name", name, ...(lead || role === "reviewer" ? [] : ["--worktree", task]), prompt, ...withUsageTap(withEffort(role, withPonytail(role, extra)))];
  if (model) argv.push("--model", model);
  else if (content && !extra.includes("--model")) argv.push("--model", "sonnet");
  if (role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return argv;
}

/** The flags `f1rm hire` takes before the role, and the words after them. The delegation gate reads a hire with this too, so the two can't drift. */
export function parseHireFlags(words: string[]) {
  const args = [...words];
  let override = false, simple = false;
  let reportTo: string | undefined, team: string | undefined, level: string | undefined, content = false, skills: string[] = [];
  for (;;) {
    if (args[0] === "--override") override = !!args.shift();
    else if (args[0] === "--report-to") (args.shift(), (reportTo = args.shift()));
    else if (args[0] === "--team") (args.shift(), (team = args.shift()));
    else if (args[0] === "--skills") (args.shift(), (skills = (args.shift() ?? "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean)));
    else if (args[0] === "--level") (args.shift(), (level = args.shift()));
    else if (args[0] === "--content") content = !!args.shift();
    else if (args[0] === "--simple") simple = !!args.shift();
    else break;
  }
  return { override, reportTo, team, level, content, simple, skills, args };
}

/** How long a hire or a wake refused by a counted cap waits (under the 10 minutes a Bash call lasts), how often it looks again, and how often it says it still waits. */
export const WAIT_MS = 8 * 60_000, POLL_MS = 20_000, SAY_MS = 60_000;
export const NO_SLOT = "no slot yet: run the same command again. Ask nobody; it is not a decision for the user.";
/** The exit code of a hire or a wake that found no slot in time: EX_TEMPFAIL, run it again. */
export const EX_TEMPFAIL = 75;
export type Wait = { sleep: (ms: number) => Promise<unknown>; now: () => number; total: number; say: (line: string) => void };
// F1RM_SLOT_WAIT_MS is the tests' way to shorten the total wait of the real command (0 gives up at the first refusal).
export const realWait = (): Wait => ({ sleep: Bun.sleep, now: Date.now, total: Number(process.env.F1RM_SLOT_WAIT_MS ?? WAIT_MS) || (process.env.F1RM_SLOT_WAIT_MS === "0" ? 0 : WAIT_MS), say: (line) => console.error(line) });

/**
 * Runs `attempt` until no counted cap (a HireRefused with a working count) refuses it, polling every POLL_MS and saying `waiting for a slot: <the cap>` at the start and then once a minute.
 * Returns null, after saying NO_SLOT, when `total` has passed. Any other refusal is thrown at once.
 */
export async function untilSlot<T>(attempt: () => Promise<T>, w: Wait): Promise<T | null> {
  const end = w.now() + w.total;
  let said = -Infinity;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof HireRefused && err.working !== null)) throw err;
      if (w.now() - said >= SAY_MS) (w.say(`waiting for a slot: ${err.message}`), (said = w.now()));
      if (w.now() >= end) return (w.say(NO_SLOT), null);
      await w.sleep(POLL_MS);
    }
  }
}

/** Runs `f1rm hire` and returns the exit code. A cap waits for a free slot (see untilSlot); `--override` is the user's own terminal's. */
export async function hire(words: string[], wait: Wait = realWait()): Promise<number> {
  const { override, reportTo, team, level, content, simple, skills, args } = parseHireFlags(words);
  const [role, name, task, brief, ...extra] = args;
  if (role === "--help" || role === "-h") return console.log(USAGE), 0;
  if (!role) throw new Error(USAGE);
  // Git is asked once; the edition file, the PM's name and the path limit all read it.
  const common = machine.gitCommonDir(process.cwd());
  const git = { gitCommonDir: () => common };
  // The session starts in the repo's root, not in a subfolder the command ran from: that is where `f1rm status` looks for it.
  const root = common ? dirname(common) : process.cwd();
  const argv = await untilSlot(() => planHire({ role, name, task, team, cwd: root, edition: readEdition(editionFile(root, git)), paused: readPaused(pausedFile(pausedDirOf(process.env.HOME!), root)), brief, reportTo: reportTo ?? pmName(root, git), override, skills, level, content, simple, extra }, { backgroundSessions: machine.backgroundSessions, ...git }), wait);
  if (!argv) return EX_TEMPFAIL;
  const proc = Bun.spawn(argv, { cwd: root, env: claudeEnv(), stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}
