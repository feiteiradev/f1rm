// `f1rm wake <name|id> [message]`: resumes a stopped, blocked or done hire (or lead) of this project in place, with its history, name and Report to.
// A session whose process ended is resumed as a NEW session (new id, the old history copied, the old transcript untouched); name and folder are kept only because they are passed here.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agents, claudeEnv, gitCommonDirAsync } from "../server/machine.ts";
import { pausedDirOf, pausedFile, readPaused } from "../server/pause.ts";
import { checkSlots, EX_TEMPFAIL, HireRefused, pmName, projectFolder, realWait, REVIEWER_DISALLOWED, rootTooLong, SECURITY, untilSlot, withEffort, withPonytail, type LiveHires, type Wait } from "./hire.ts";
import { withUsageTap } from "../usage.ts";
import { hireName, repoOf, type HireName } from "./letgo.ts";
import { headAsync, hires, startsTurn, tailAsync, textOf } from "./status.ts";

export const USAGE = "usage: f1rm wake <name|id> [message] [--override] (the user's own terminal only)[claude flags...]";
export const DEFAULT_NOTE = "resumed; continue your task";

/** A simple task's hire: a specialist with no team, whose lead is the PM. */
export const isSimple = (h: HireName): boolean => h.role !== "lead" && !h.team && !h.reviewer;

/** Who may wake a hire follows who may hire it: the PM wakes leads and its simple tasks' hires, a lead wakes the members of its own team, a specialist wakes nobody. */
export const mayWake = (waker: { role: string | null; team: string | null }, target: HireName): boolean =>
  waker.role === "pm" ? target.role === "lead" || isSimple(target) : waker.role === "lead" ? target.role !== "lead" && !!waker.team && target.team === waker.team : false;

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
  /** Git's common dir for a folder; the real one asks git without blocking the event loop. */
  gitCommonDir: (cwd: string) => string | null | Promise<string | null>;
  home: string;
  now: number;
  exists: (path: string) => boolean;
  /** The model a session last answered with, or null when its transcript says none. */
  modelOf: (cwd: string, sessionId: string) => string | null | Promise<string | null>;
  /** The text of the session's first prompt, the one `f1rm hire` wrote, or null when its transcript can't be read. */
  promptOf: (cwd: string, sessionId: string) => string | null | Promise<string | null>;
};

/** The text of the first line that starts a turn (see startsTurn) in the start of a transcript: the forked `/code-review` of a Reviewer writes a `<local-command-caveat>` line (`isMeta`) before the hire's prompt. */
export function firstPrompt(start: string): string | null {
  for (const l of start.split("\n")) {
    if (!l.includes('"type":"user"')) continue;
    try {
      const line = JSON.parse(l);
      if (line.type === "user" && startsTurn(line)) return textOf(line.message?.content) || null;
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

/** The session a hire reports to: the one its first prompt named, else its lead (a member) or the PM (a lead). */
export function reportToOf(hire: HireName, first: string | null, repo: string): string {
  return (first && /Report to: (\S+)/.exec(first)?.[1]) || (hire.role !== "lead" && hire.team ? `lead-${hire.team}` : pmName(repo, { gitCommonDir: () => join(repo, ".git") }));
}

export type WakePlan = { argv: string[]; cwd: string; name: string; sessionId: string };

const background = (list: any[]) => list.filter((a) => a?.kind === "background" && typeof a.name === "string");

/** The rule of a wake message, said in the refusal and in the usage error. */
export const SLASH_RULE = "A wake message cannot start with a slash: the resumed session would run it as a slash command.";

/**
 * Checks a wake and returns the `claude --bg --resume` argv that does it, with the folder it runs in (the hire's own, so the resumed session works in its worktree).
 * Throws an Error for a hire that can't be woken (let go, another project's, live, unknown, not a hire), and a HireRefused when a cap, the team's lead or the task's one specialist stops it,
 * through the same checks as a hire. Who may wake is the gate's to judge (see mayWake), not this command's: it cannot tell who runs it.
 */
export async function planWake(req: WakeRequest, d: WakeDeps): Promise<WakePlan> {
  // The note is the resumed session's prompt, and a prompt that starts with a slash runs as that slash command, as typed by the user: `/f1rm:stop-all` would pause every project past the office's gate.
  if (req.message?.trim().startsWith("/")) throw new Error(`${SLASH_RULE} Start with words.`);
  const common = await d.gitCommonDir(req.cwd);
  if (!common) throw new Error("not in a git repo");
  const repo = dirname(common);
  // The office stops a paused project's sessions at every step; a session woken now would be stopped again at once.
  const paused = readPaused(pausedFile(pausedDirOf(d.home), repo));
  if (paused) throw new Error(`${basename(repo)} is paused (${paused.by}${paused.why ? `: ${paused.why}` : ""}): nothing in it is woken until \`f1rm resume\` runs in the project`);
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
  const mine = background(all).filter((a) => a.name === name && repoOf(String(a.cwd)) === repo);
  if (!mine.length) throw new Error(`${name} belongs to another project: wake it from there`);
  const hire = hireName(name);
  if (!hire) throw new Error(`${name} is not a hire: only a lead or a specialist is woken`);
  if (mine.some((a) => a.pid)) throw new Error(`${name} is live: message it instead`);
  const target = mine.reduce((best, a) => ((a.startedAt ?? 0) > (best.startedAt ?? 0) ? a : best));
  // A specialist works in `<repo>/.claude/worktrees/<task>` (a lead and a Reviewer, in the repo itself), but `claude agents --all` lists a STOPPED worktree session with the main repo as its folder.
  // The resume, the model and the first prompt come from the worktree: that is where the old transcript is, and where the hire must keep working.
  const own = hire.role === "lead" || hire.reviewer ? null : join(repo, ".claude", "worktrees", hire.task);
  // A specialist whose worktree is gone is not resumed in the folder the listing gives: that is the main checkout, where it could edit files and commit.
  const cwd = own ?? String(target.cwd);
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
  const first = await d.promptOf(cwd, sessionId);
  const reportTo = reportToOf(hire, first, repo);
  // The office arms its APPROVED hold from the new session's first prompt, which is this note: a high-level Reviewer's carries the sentence again. A Reviewer whose prompt could not be read carries it too
  // (one extra security-review is cheaper than a missing hold). The sentence that names skills to load is not repeated: the history has them.
  const hold = first === null ? hire.role === "reviewer" : first.includes(SECURITY);
  const note = `${req.message?.trim() || DEFAULT_NOTE}\nReport to: ${reportTo}${hold ? SECURITY : ""}`;
  const extra = req.extra ?? [];
  const model = extra.some((a) => a === "--model" || a.startsWith("--model=")) ? null : await d.modelOf(cwd, sessionId);
  const argv = ["claude", "--bg", "--resume", sessionId, "--agent", `f1rm:${hire.role}`, "--name", name, note, ...withUsageTap(withEffort(hire.role, withPonytail(hire.role, extra))), ...(model ? ["--model", model] : [])];
  if (hire.role === "reviewer") argv.push(...REVIEWER_DISALLOWED);
  return { argv, cwd, name, sessionId };
}

/** The words of `f1rm wake`: `--override` anywhere before the first claude flag, then the target and the message, and from the first flag on what goes to claude as given. */
export function parseWakeArgs(words: string[]): { target: string | undefined; message: string | undefined; override: boolean; extra: string[] } {
  const at = words.findIndex((a) => a.startsWith("-") && a !== "--override");
  const own = at < 0 ? words : words.slice(0, at);
  const positional = own.filter((a) => a !== "--override");
  if (positional.length > 2) throw new Error(`${USAGE}: quote the message, as one word. ${SLASH_RULE}`);
  const [target, message] = positional;
  return { target, message, override: own.includes("--override"), extra: at < 0 ? [] : words.slice(at) };
}

/** A session's transcript: `<home>/.claude/projects/<its folder>/<session id>.jsonl`. */
export const transcriptFile = (home: string, cwd: string, sessionId: string) => join(home, ".claude", "projects", projectFolder(cwd), `${sessionId}.jsonl`);

/** The real Claude Code, git, disk and clock, for a wake run now. */
export function realWakeDeps(home: string): WakeDeps {
  return {
    agents, gitCommonDir: gitCommonDirAsync, home, now: Date.now(), exists: existsSync,
    modelOf: async (cwd, sessionId) => lastModel(await tailAsync(transcriptFile(home, cwd, sessionId))),
    promptOf: async (cwd, sessionId) => firstPrompt(await headAsync(transcriptFile(home, cwd, sessionId))),
  };
}

/** `planWake`, but a cap that refuses it waits for a free slot (see untilSlot): null when none came. The sessions are read again at every look. */
export const planWakeWaiting = (req: WakeRequest, mkDeps: () => WakeDeps, w: Wait): Promise<WakePlan | null> => untilSlot(() => planWake(req, mkDeps()), w);

/** Runs `f1rm wake` and returns the exit code. */
export async function wake(words: string[], wait: Wait = realWait()): Promise<number> {
  if (words[0] === "--help" || words[0] === "-h") return console.log(USAGE), 0;
  const { target, message, override, extra: rest } = parseWakeArgs(words);
  if (!target) throw new Error(USAGE);
  const plan = await planWakeWaiting({ target, message, cwd: process.cwd(), override, extra: rest }, () => realWakeDeps(process.env.HOME!), wait);
  if (!plan) return EX_TEMPFAIL;
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
