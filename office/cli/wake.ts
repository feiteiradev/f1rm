// `f1rm wake <name|id> [message]`: resumes a stopped, blocked or done hire (or lead) of this project in place, with its history, name and Report to.
// A session whose process ended is resumed as a NEW session (new id, the old history copied, the old transcript untouched); name and folder are kept only because they are passed here.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { agents, claudeEnv, machine } from "../server/machine.ts";
import { checkSlots, HireRefused, pmName, projectFolder, REVIEWER_DISALLOWED, rootTooLong, type LiveHires } from "./hire.ts";
import { hireName, repoOf, type HireName } from "./letgo.ts";
import { head, hires, tail } from "./status.ts";

export const USAGE = "usage: f1rm wake [--override] <name|id> [message] [claude flags...]";
export const DEFAULT_NOTE = "resumed; continue your task";

/** Who may wake a hire follows who may hire it: the PM wakes leads, a lead wakes the members of its own team, a specialist wakes nobody. */
export const mayWake = (waker: { role: string | null; team: string | null }, target: HireName): boolean =>
  waker.role === "pm" ? target.role === "lead" : waker.role === "lead" ? target.role !== "lead" && !!waker.team && target.team === waker.team : false;

export type WakeRequest = {
  /** A session's name, session id or short id. */
  target: string;
  /** What the hire is told; the default says it was resumed. */
  message?: string;
  /** The folder the command runs in: any folder of the repo. */
  cwd: string;
  override?: boolean;
  /** Flags that go to claude as given. */
  extra?: string[];
};

export type WakeDeps = {
  /** `claude agents --json`, with `--all` for the finished sessions too; null if it can't say. */
  agents: (all: boolean) => Promise<any[] | null>;
  gitCommonDir: (cwd: string) => string | null;
  home: string;
  now: number;
  exists: (path: string) => boolean;
  /** The model a session last answered with, or null when its transcript says none. */
  modelOf: (cwd: string, sessionId: string) => string | null;
  /** The text of the session's first prompt, the one `f1rm hire` wrote, or null when its transcript can't be read. */
  promptOf: (cwd: string, sessionId: string) => string | null;
};

/** The text of the first user line in the start of a transcript: a string, or the text blocks of a list. */
export function firstPrompt(start: string): string | null {
  for (const l of start.split("\n")) {
    if (!l.includes('"type":"user"')) continue;
    try {
      const line = JSON.parse(l);
      if (line.type !== "user") continue;
      const c = line.message?.content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => String(b?.text ?? "")).join("") : null;
    } catch {} // a cut or odd line is no prompt
  }
  return null;
}

/**
 * The model of the conversation's last answer in a piece of transcript: an assistant line that is no sub-agent's and no synthetic error line (`<synthetic>`). A resume with no `--model`
 * runs the role's own model, so a hire started on Haiku would wake on Sonnet, and an Opus one on less.
 */
export function lastModel(end: string): string | null {
  for (const l of end.split("\n").reverse()) {
    if (!l.includes('"type":"assistant"')) continue;
    try {
      const line = JSON.parse(l);
      const model = line.message?.model;
      if (line.type === "assistant" && !line.isSidechain && typeof model === "string" && !model.startsWith("<")) return model;
    } catch {} // a cut or odd line is no answer
  }
  return null;
}

export type WakePlan = { argv: string[]; cwd: string; name: string; sessionId: string };

const background = (list: any[]) => list.filter((a) => a?.kind === "background" && typeof a.name === "string");

/**
 * Checks a wake and returns the `claude --bg --resume` argv that does it, with the folder it runs in (the hire's own, so the resumed session works in its worktree).
 * Throws an Error for a hire that can't be woken (let go, another project's, live, unknown, not a hire), and a HireRefused when a cap, the team's lead or the task's one specialist stops it,
 * through the same checks as a hire. Who may wake is the gate's to judge (see mayWake), not this command's: it cannot tell who runs it.
 */
export async function planWake(req: WakeRequest, d: WakeDeps): Promise<WakePlan> {
  const common = d.gitCommonDir(req.cwd);
  if (!common) throw new Error("not in a git repo");
  const repo = dirname(common);
  const tooLong = rootTooLong(common);
  if (tooLong) throw new HireRefused(tooLong, null);
  const all = await d.agents(true);
  if (!all) throw new Error("can't list the sessions (`claude agents --json --all` failed)");

  const given = background(all).filter((a) => a.name === req.target || a.sessionId === req.target || a.id === req.target);
  const name: string = given[0]?.name ?? req.target;
  if (!given.length) {
    // Letting a hire go removes it from the listing but leaves its transcript for a day.
    if (hires({ repo, home: d.home, agents: all, now: d.now, commitTime: () => null }).some((h) => h.ended && h.name === name)) throw new Error(`${name} was let go; hire a new one`);
    throw new Error(`no hire named ${name} in this project`);
  }
  const same = background(all).filter((a) => a.name === name);
  const mine = same.filter((a) => repoOf(String(a.cwd)) === repo);
  if (!mine.length) throw new Error(`${name} belongs to another project: wake it from there`);
  const hire = hireName(name);
  if (!hire) throw new Error(`${name} is not a hire: only a lead or a specialist is woken`);
  if (mine.some((a) => a.pid)) throw new Error(`${name} is live: message it instead`);
  const target = mine.reduce((best, a) => ((a.startedAt ?? 0) > (best.startedAt ?? 0) ? a : best));
  const cwd = String(target.cwd);
  if (!d.exists(cwd)) throw new Error(`${name} was let go; hire a new one`);

  // The same checks as a hire. The sessions of this name that have no process are the one being woken and its older copies: a blocked one still holds a slot, and must not count against itself.
  const listed = (await d.agents(false)) ?? [];
  const live: LiveHires = background(listed)
    .filter((a) => !(a.name === name && !a.pid))
    .map((a) => ({ name: String(a.name), state: String(a.state ?? ""), cwd: String(a.cwd ?? ""), ...((a.status === "busy" || a.status === "idle") && { status: a.status as "busy" | "idle" }) }));
  // A Reviewer's task is review-<task>, as `f1rm hire` names it; hireName gives the task it reviews, whose dev may be idle in its worktree.
  checkSlots(live, { role: hire.role, name, task: hire.reviewer ? `review-${hire.task}` : hire.task, team: hire.role === "lead" ? null : hire.team, cwd: repo, override: req.override });

  // A woken hire starts with what `f1rm hire` gave it: the session it reports to is the one its first prompt named, and a Reviewer keeps its push block. A resume with flags does not inherit the saved options.
  const sessionId = String(target.sessionId);
  const first = d.promptOf(cwd, sessionId);
  const reportTo = (first && /Report to: (\S+)/.exec(first)?.[1]) || (hire.role !== "lead" && hire.team ? `lead-${hire.team}` : pmName(repo, { gitCommonDir: () => common }));
  const note = `${req.message?.trim() || DEFAULT_NOTE}\nReport to: ${reportTo}`;
  const extra = req.extra ?? [];
  const model = extra.some((a) => a === "--model" || a.startsWith("--model=")) ? null : d.modelOf(cwd, sessionId);
  const argv = ["claude", "--bg", "--resume", sessionId, "--agent", `f1rm:${hire.role}`, "--name", name, note, ...extra, ...(model ? ["--model", model] : [])];
  if (hire.role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return { argv, cwd, name, sessionId };
}

/** Runs `f1rm wake` and returns the exit code. */
export async function wake(words: string[]): Promise<number> {
  const args = [...words];
  const override = args[0] === "--override" && !!args.shift();
  if (args[0] === "--help" || args[0] === "-h") return console.log(USAGE), 0;
  if (!args[0]) throw new Error(USAGE);
  const [target, ...rest] = args;
  const message = rest[0] && !rest[0].startsWith("-") ? rest.shift() : undefined;
  let plan: WakePlan;
  try {
    const home = process.env.HOME!;
    const file = (cwd: string, sessionId: string) => join(home, ".claude", "projects", projectFolder(cwd), `${sessionId}.jsonl`);
    const modelOf = (cwd: string, sessionId: string) => lastModel(tail(file(cwd, sessionId)));
    const promptOf = (cwd: string, sessionId: string) => firstPrompt(head(file(cwd, sessionId)));
    plan = await planWake({ target, message, cwd: process.cwd(), override, extra: rest }, { agents, gitCommonDir: machine.gitCommonDir, home, now: Date.now(), exists: existsSync, modelOf, promptOf });
  } catch (err) {
    if (err instanceof HireRefused && err.working !== null) {
      throw new Error(`${err.message} Do not wake it; tell the session you report to. Only after the user approves this wake in that conversation is it rerun with --override.`);
    }
    throw err;
  }
  const proc = Bun.spawn(plan.argv, { cwd: plan.cwd, env: claudeEnv(), stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0) return console.error(out), code;
  // The new session has its own id; the short one claude prints is looked up so the caller can see it.
  const short = /\b([0-9a-f]{8})\b/.exec(out)?.[1];
  const found = short ? background((await agents(false)) ?? []).find((a) => a.id === short) : undefined;
  console.log(`woke ${plan.name}: ${plan.sessionId} -> ${found?.sessionId ?? short ?? "(see claude agents)"}${out ? `\n${out}` : ""}`);
  return 0;
}
