// `f1rm hire`: the only way a PM starts a specialist, so the cap lives in code.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agents, claudeEnv, machine } from "../server/machine.ts";

export const USAGE =
  "usage: f1rm hire [--override] [--report-to <pm session>] <role> <name> <task> <brief> [claude flags...]";

const AGENTS = join(import.meta.dir, "..", "..", "plugin", "agents");
const CAP = 4;
// /research and /security-review are slash commands, not Skill-tool skills, so no role lists them under `skills:`.
const SLASH_ONLY: Record<string, string[]> = { reviewer: ["security-review"], researcher: ["research"] };
// ponytail: a deny rule only slows an honest model down; `git -C . push` gets past it. A real block needs a hook.
const REVIEWER_DISALLOWED = ["--disallowedTools", "Bash(git push *)"];

/** The PM session name `f1rm pm` gives this repo; a hire reports to it. */
export function pmName(cwd: string): string {
  const common = machine.gitCommonDir(cwd);
  return `pm-${basename(common ? dirname(common) : cwd).replace(/[^\w.-]+/g, "-")}`;
}

/** The role's skills from its plugin file, then its slash-only commands, in the order the brief loads them. */
function slashCommands(role: string): string[] {
  const file = readFileSync(join(AGENTS, `${role}.md`), "utf8");
  const fm = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(file)![1]) as { skills?: string[] };
  return [...(fm.skills ?? []), ...(SLASH_ONLY[role] ?? [])];
}

async function workingHires(): Promise<number> {
  const list = await agents(false);
  if (!list) throw new Error("can't count the working hires (`claude agents --json` failed), so not hiring");
  // A blocked hire waits on a person and still holds its slot. Interactive sessions are the user's, not hires.
  return list.filter((a) => a?.kind === "background" && (a.state === "working" || a.state === "blocked")).length;
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
  const roles = readdirSync(AGENTS).map((f) => basename(f, ".md")).filter((r) => r !== "pm");
  if (!roles.includes(role)) throw new Error(`unknown role "${role}": hire one of ${roles.join(", ")}. The PM is started with \`f1rm pm\`.`);
  if (!name || !task || !brief) throw new Error(USAGE);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task)) throw new Error(`task "${task}" must be lowercase words joined by hyphens`);

  if (!override) {
    const working = await workingHires();
    if (working >= CAP)
      throw new Error(
        `${working} hires are already working (the cap is ${CAP}). Do not hire. Tell the user, leave the task todo, and ask whether to wait or exceed the cap. Only if they approve this hire, rerun with --override.`,
      );
  }

  // Live on Claude Code 2.1.300 only the first slash command of a chain expands, so the rest go through the Skill tool.
  // ponytail: the Skill-tool step loaded a skill in 6 of 8 spike runs; inline the skill text with --append-system-prompt-file if hires miss it.
  const [first, ...rest] = slashCommands(role);
  const more = rest.length ? ` Before you start, load these with the Skill tool: ${rest.join(", ")}.` : "";
  const prompt = `/${first}${more} Report to: ${reportTo ?? pmName(process.cwd())}\n\n${brief}`;
  // The flags go after the prompt: --disallowedTools takes any number of values and would swallow a prompt that follows it.
  const argv = ["claude", "--bg", "--agent", `f1rm:${role}`, "--name", name, "--worktree", task, prompt, ...extra];
  if (role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  const proc = Bun.spawn(argv, { env: claudeEnv(), stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}
