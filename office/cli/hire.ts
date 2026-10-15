// `f1rm hire`: the only way a PM starts a specialist, so the cap lives in code. The office's Hire dialog uses `planHire` too.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MODELS } from "../people.ts";
import { claudeEnv, machine } from "../server/machine.ts";

export const USAGE =
  "usage: f1rm hire [--override] [--report-to <pm session>] <role> <name> <task> <brief> [claude flags...]";

const AGENTS = join(import.meta.dir, "..", "..", "plugin", "agents");
const CAP = 4;
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
  name: string;
  task: string;
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
export async function planHire(req: HireRequest, m: Pick<typeof machine, "workingHires"> = machine): Promise<string[]> {
  const { role, name, task, brief, reportTo, model, override, extra = [] } = req;
  const roles = readRoles();
  if (!roles.some((r) => r.id === role)) {
    throw new Error(`unknown role "${role}": hire one of ${roles.map((r) => r.id).join(", ")}. The PM is started with \`f1rm pm\`.`);
  }
  if (!name || !task || !brief) throw new Error(USAGE);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task)) throw new Error(`task "${task}" must be lowercase words joined by hyphens`);
  if (model && !MODELS.includes(model)) throw new Error(`model "${model}" must be one of ${MODELS.join(", ")}`);

  if (!override) {
    const working = await m.workingHires();
    if (working === null) throw new HireRefused("can't count the working hires (`claude agents --json` failed), so not hiring", null);
    if (working >= CAP) throw new HireRefused(`${working} hires are already working (the cap is ${CAP}).`, working);
  }

  // Live on Claude Code 2.1.300 only the first slash command of a chain expands, so the rest go through the Skill tool.
  // ponytail: the Skill-tool step loaded a skill in 6 of 8 spike runs; inline the skill text with --append-system-prompt-file if hires miss it.
  const [first, ...rest] = roles.find((r) => r.id === role)!.skills;
  const more = rest.length ? ` Before you start, load these with the Skill tool: ${rest.join(", ")}.` : "";
  const prompt = `/${first}${more}${reportTo ? ` Report to: ${reportTo}` : ""}\n\n${brief}`;
  // The flags go after the prompt: --disallowedTools takes any number of values and would swallow a prompt that follows it.
  const argv = ["claude", "--bg", "--agent", `f1rm:${role}`, "--name", name, "--worktree", task, prompt, ...extra];
  if (model) argv.push("--model", model);
  if (role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return argv;
}

/** Runs `f1rm hire` and returns the exit code. */
export async function hire(args: string[]): Promise<number> {
  let override = false;
  let reportTo: string | undefined;
  for (;;) {
    if (args[0] === "--override") override = !!args.shift();
    else if (args[0] === "--report-to") (args.shift(), (reportTo = args.shift()));
    else break;
  }
  const [role, name, task, brief, ...extra] = args;
  if (role === "--help" || role === "-h") return console.log(USAGE), 0;
  if (!role) throw new Error(USAGE);
  let argv: string[];
  try {
    argv = await planHire({ role, name, task, brief, reportTo: reportTo ?? pmName(process.cwd()), override, extra });
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
