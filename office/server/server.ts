// The f1rm server: hook ingest, office state, WebSocket to the browser.
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { alwaysRules, createBroker, DEFAULT_TIMEOUT_S, DENY_MESSAGE } from "./approvals.ts";
import { boardFile, openQuestion, parseBoard, readBoard, readBoardText, repoDir, roomName, teamBoardFile, type BoardRow } from "./board.ts";
import { changeEdition, isEdition, projectFile, readEdition, type Edition } from "./editions.ts";
import { applyListing, ELSEWHERE, emptyOffice, normalize, reduce, sweep, type Employee, type F1rmEvent, type Room } from "./office.ts";
import { inside, isJunk, junkRoots as defaultJunkRoots, realPath, readForgotten, writeForgotten } from "./doors.ts";
import { askStream, MAX_QUESTION } from "./ask.ts";
import { lastSaid } from "./said.ts";
import { jump } from "./jump.ts";
import { CAP, HireRefused, LOAD_FIRST, parseHireFlags, pmName, SECURITY, planHire, readRoles } from "../cli/hire.ts";
import { hireName, hireTask, letGoHire, repoOf } from "../cli/letgo.ts";
import { mayWake } from "../cli/wake.ts";
import { createRecovery, type RecoveryDeps } from "./recovery.ts";
import { FOUNDER_ONLY, ROLE_IDS, ROLES, roleOfAgentType, teamOf } from "../people.ts";
import type { machine as realMachine } from "./machine.ts";

const MAX_MESSAGE = 4000;
// The company limits a hook can hold. Only the PM and the leads hire, and no company employee runs more than INTERNS interns
// at once. Freelancers are the user's own sessions and are never held. With the office down the hooks fail open, and the rules
// in the plugin are what is left.
// A raw `claude --bg` or `claude -p` is held too (see claudeStart); `bash -c "claude -p …"`, an alias or a script that runs it is not seen.
// `f1rm hire` counts only in command position (see splitCommands), so a command that merely mentions it passes.
// The PM and the leads coordinate: they write boards, milestones, kept files, memory, evidence and scratch files, and leave code and landing to others.
// While a hire still has skills to load, only these run: reading, loading the skill, and telling someone it can't.
const READING = new Set(["Skill", "Read", "Grep", "Glob", "ToolSearch", "SendMessage"]);
const COORDINATORS = new Set(["pm", "lead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const LANDING = new Set(["commit", "merge", "push", "rebase", "reset", "cherry-pick", "pull", "am", "revert"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
// What can stand in front of a command: shell keywords and wrappers that run the next word.
const BEFORE_COMMAND = new Set(["bun", "if", "then", "do", "else", "elif", "while", "until", "!", "{", "time", "env", "command", "exec", "nohup", "xargs", "sudo", "timeout", "nice", "stdbuf"]);
// The options of those wrappers that take the next word as their value.
const WRAPPER_VALUE_OPTIONS: Record<string, string[]> = { timeout: ["-k", "-s", "--kill-after", "--signal"], nice: ["-n", "--adjustment"], stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"], env: ["-u", "--unset"], sudo: ["-u"] };
/** The words of each simple command in a shell line, split on `; & | ( )`, backticks and newlines outside quotes, past `VAR=x` prefixes, shell keywords, wrappers such as `env` and `bun`, and their flags. */
// ponytail: not a shell parser; a command inside double quotes (`"$(git push)"`) or an alias is not seen. A heredoc body is split into commands too,
// so a body line `git push` is refused (it fails closed; write the file with the Write tool); a wrapper flag not in WRAPPER_VALUE_OPTIONS (`sudo -g x git push`) takes its value for the command.
const splitCommands = (command: string) => {
  const out: string[][] = [[]];
  for (const [, op, word] of command.matchAll(/([;&|()`\n])|((?:[^\s"';&|()`]|"(?:\\.|[^"\\])*"|'[^']*')+)/g)) op ? out.push([]) : out.at(-1)!.push(word);
  return out.map((words) => {
    let i = 0, wrapper = "";
    for (; i < words.length; i++) {
      const w = words[i];
      if (BEFORE_COMMAND.has(w)) wrapper = w;
      else if (i > 0 && w.startsWith("-")) i += WRAPPER_VALUE_OPTIONS[wrapper]?.includes(w) ? 1 : 0;
      else if (wrapper === "timeout") wrapper = ""; // its first word past the options is the duration
      else if (!/^\w+=/.test(w)) break;
    }
    return { prefix: words.slice(0, i), words: words.slice(i) };
  });
};
// A `f1rm`/`f1rm.ts` word followed by `hire` at any position, so `bun run f1rm.ts hire` and `npx f1rm hire` count; a quoted message is one word, so it doesn't.
// ponytail: `bash -c "f1rm hire …"` is one quoted word and is not seen.
const unquoted = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");
/** The words after `hire` (or another `f1rm` command, `wake`) of a simple command that runs `f1rm hire`, unquoted, or null. */
const hireArgs = (words: string[], verb = "hire") => {
  const i = words.findIndex((w, i) => ["f1rm", "f1rm.ts"].includes(basename(unquoted(w))) && unquoted(words[i + 1] ?? "") === verb);
  return i < 0 ? null : words.slice(i + 2).map(unquoted);
};
/** The role and `--team` of the words after `f1rm hire`, read with the CLI's own flag parser so the two can't drift; `--help` hires nobody. */
const hireOf = (args: string[] | null) => {
  if (!args) return null;
  const { team, args: [role] } = parseHireFlags(args);
  return role === "--help" || role === "-h" ? null : { role, team };
};
/** Where the words after the options start: a flag that takes a value takes the next word with it. */
const skipOptions = (args: string[], i: number, withValue: Set<string>) => {
  while (args[i]?.startsWith("-")) i += withValue.has(args[i]) ? 2 : 1;
  return i;
};
/** The git subcommand a simple command runs, past global options such as `-C <dir>`, with the words after it and the options before it. */
const gitCall = ([program, ...words]: string[]) => {
  if (basename(unquoted(program ?? "")) !== "git") return null;
  const args = words.map(unquoted);
  const i = skipOptions(args, 0, GIT_OPTIONS_WITH_VALUE);
  return { sub: args[i] ?? "", rest: args.slice(i + 1), options: args.slice(0, i) };
};
const GH_OPTIONS_WITH_VALUE = new Set(["-R", "--repo"]);
const GH_API_WITH_VALUE = new Set(["-H", "--header", "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input", "-p", "--preview", "-q", "--jq", "-t", "--template", "--cache", "--hostname"]);
// A `gh api` method (`-X PUT`, `-X=PUT`, `-XPUT`, `-iXPUT`, `--method PUT`, `--method=PUT`) other than GET, or a field or input file with no method (gh then POSTs), writes.
const API_METHOD = /^(?:--method(?:=(.*))?|-X=?(.*))$/;
const API_FIELD = /^-[fF]|^--(field|raw-field|input)/;
// The endpoints that put code on a branch or a remote: merge a pull request or a branch, update a pull request's branch, write refs, commits, trees, blobs or contents.
const LANDING_ENDPOINT = /(^|\/)(pulls\/\d+\/(merge|update-branch)|merges|git\/(refs|commits|trees|blobs)|contents|branches\/[^/?#]+\/merge[^/?#]*)(?=[/?#]|$)/;
const LANDING_MUTATION = /mergePullRequest|mergeBranch|updatePullRequestBranch|createCommitOnBranch|createRef|updateRef|enablePullRequestAutoMerge/i;
// ponytail: only code-landing endpoints are held; other `gh api` writes (issues, comments, labels) pass. A graphql query kept in a file or a shell variable is not seen.
// Add an endpoint here when GitHub gains another way to land code.
const writesApi = (given: string[]) => {
  // `-i` is gh api's only short boolean flag: drop it from a cluster, so `-iq`, `-if` and `-iXPUT` read as `-q`, `-f` and `-XPUT`.
  const args = given.map((a) => a.replace(/^-i+(?=[A-Za-z])/, "-"));
  // The endpoint is the first word past the options (and their values), so `-p graphql` or `--jq graphql` does not make a REST call a graphql query. It may be a path or a URL.
  if (/(^|\/)graphql$/.test(args[skipOptions(args, 0, GH_API_WITH_VALUE)] ?? "")) return args.some((a) => LANDING_MUTATION.test(a));
  const methods = args.flatMap((a, j) => {
    const m = API_METHOD.exec(a);
    return m ? [(m[1] ?? m[2]) || (args[j + 1] ?? "")] : [];
  });
  const writes = methods.length ? methods.some((m) => !/^get$/i.test(m)) : args.some((a) => API_FIELD.test(a));
  return writes && args.some((a) => LANDING_ENDPOINT.test(a));
};
/** `gh pr merge`, past options such as `-R <repo>` before or after `pr`, or a `gh api` call that writes to a code-landing endpoint (see writesApi). */
const ghLands = ([program, ...words]: string[]) => {
  if (basename(unquoted(program ?? "")) !== "gh") return false;
  const args = words.map(unquoted);
  const i = skipOptions(args, 0, GH_OPTIONS_WITH_VALUE);
  if (args[i] === "api") return writesApi(args.slice(i + 1));
  return args[i] === "pr" && args[skipOptions(args, i + 1, GH_OPTIONS_WITH_VALUE)] === "merge";
};
// What a Reviewer may not run: it merges with --no-ff or --ff-only and removes its worktrees, and rewrites nothing.
const REVIEWER_NEVER = new Set(["reset", "rebase", "cherry-pick", "revert", "am", "pull", "clean", "update-ref"]);
// A short-flag cluster with `f` is a force only for these; `git log -Sfoo` and `git diff -Uf` are not. A bare `-f` and `--force*` are refused everywhere.
const FORCE_SHORT = new Set(["checkout", "switch", "branch", "worktree", "tag", "merge", "clean", "push", "fetch", "reset", "add", "update-ref"]);
const RED_WORKTREE = /^\.claude\/worktrees\/red-[^/]+\/?$/;
// ponytail: a dev task whose slug starts `red-` has its worktree removable by a Reviewer too; tighten it if that ever matters.
// `git checkout <path>` and `git checkout <ref> -- <path>` are not refused: a path and a ref look alike, and the Reviewer needs `checkout main`, `checkout -b x` and `checkout <branch> -- <files>`.
/** Whether a git call is one a Reviewer may not run. The one force it needs is removing its red-<task> scratch worktree. */
const reviewerRefused = (call: ReturnType<typeof gitCall>) => {
  if (!call) return false;
  const { sub, rest, options } = call;
  const any = (re: RegExp) => rest.some((a) => re.test(a));
  if (REVIEWER_NEVER.has(sub)) return true;
  if ((sub === "branch" && any(/^-[A-Za-z]*[DM]/)) || (sub === "checkout" && any(/^-[A-Za-z]*B/)) || (sub === "switch" && any(/^-[A-Za-z]*C/))) return true;
  // `checkout -- <path>` (nothing but options before the `--`) restores a path from the index; `checkout <branch> -- <files>` is how the red-<task> worktree gets its check files.
  const restoresPath = sub === "checkout" && rest.includes("--") && rest.slice(0, rest.indexOf("--")).every((a) => a.startsWith("-"));
  // `--amend` as a word, not as the value of `-m`, `-F`, `-C`, `-c`, `-t` or `--message`.
  const amends = sub === "commit" && rest.some((a, j) => /^--am/.test(a) && !/^(-[^mFCct]*[mFCct]|--(message|file|reuse-message|reedit-message|template))$/.test(rest[j - 1] ?? ""));
  // `restore` may only unstage; `checkout --ours|--theirs` overwrites a path.
  const discards = (sub === "restore" && !["--staged", "-S"].includes(rest.filter((a) => a.startsWith("-") && a !== "--").join())) || (sub === "checkout" && any(/^--(ours|theirs)$/));
  if (sub === "stash" || amends || restoresPath || discards || (sub === "checkout" && rest.includes("."))) return true;
  if (!any(/^--force/) && !rest.includes("-f") && !(FORCE_SHORT.has(sub) && any(/^-[A-Za-z]*f/))) return false;
  const flags = rest.filter((a) => a.startsWith("-")), paths = rest.filter((a) => !a.startsWith("-"));
  const here = !options.some((o) => /^(-C|--git-dir|--work-tree)/.test(o));
  return !(sub === "worktree" && here && paths[0] === "remove" && flags.every((a) => a === "--force" || a === "-f") && paths.length === 2 && RED_WORKTREE.test(paths[1]));
};
const SPECIALISTS = new Set(["designer", "frontend", "backend", "reviewer", "researcher", "marketer", "seo", "social", "sales", "strategist"]);
export const INTERNS = 2;
// A team member's message that opens with one of these words, after anything that is no letter or digit (markdown, an emoji, a table bar) and a list number (`1.`, `2)`), is a formal report: it goes to its lead only.
const FORMAL_REPORT = /^[^A-Za-z0-9]*(?:\d+[.)][^A-Za-z0-9]*)?(?:DONE|APPROVED|BLOCKED|ESCALATE|CHANGES[\s_-]+REQUESTED)(?![A-Za-z0-9])/;
// The user's real home folder, as the system has it, never the HOME the office runs with: a second office is started with a temp one.
// Folded for comparing: past links, with `/System/Volumes/Data` put aside and letter case ignored (APFS ignores it).
const fold = (path: string) => path.replace(/^\/System\/Volumes\/Data(?=\/|$)/, "").toLowerCase();
const homeKey = (path: string) => fold(realPath(resolve(path)));
const REAL_HOME = homeKey(((): string => { try { return userInfo().homedir; } catch { return homedir(); } })()); // no passwd entry for the uid: HOME decides
/** Whether one real folder is the other or inside it, and the outer is no broad one: not `/` (which `inside` never says holds anything but itself), the home folder or a folder that holds it. */
const sameFolder = (x: string, y: string) => {
  const holds = (outer: string, path: string) => inside(outer, path) && outer !== "/" && !inside(fold(outer), REAL_HOME);
  return holds(x, y) || holds(y, x);
};
const leadOf = (team: string | null, fallback = "your lead (the Report to of your brief)") => (team ? `lead-${team}` : fallback);
/** Who talks to whom: for each kind of company employee, the sessions of its project it may message (its own team, when it has one, is `team`) and the way out when a target is refused. */
const TALK = {
  pm: { allows: (_team: string | null, e: Employee) => e.role === "lead", wayOut: (_team: string | null, e: Employee) => `The PM messages the leads of this project and no one else. A specialist or a Reviewer is reached through its lead: tell ${leadOf(teamOf(e), "their lead")}.` },
  lead: {
    allows: (team: string | null, e: Employee) => e.role === "pm" || e.role === "lead" || (!!team && teamOf(e) === team),
    wayOut: (team: string | null, e: Employee) => `A lead messages the PM, other leads and the members of its own team (${team ?? "<team>"}.…). Another team's members are reached through their lead: tell ${leadOf(teamOf(e), "their lead")}.`,
  },
  member: {
    allows: (team: string | null, e: Employee) => !!team && teamOf(e) === team,
    wayOut: (team: string | null) => `A team member messages its own lead and the members of its own team. The PM and other teams are reached through your lead: ask ${leadOf(team)}.`,
  },
};
// A raw session start: `claude` with --bg or -p/--print. `--resume` is how the PM or a lead wakes a session it hired.
// A second-office proof gives the command a HOME of its own: a `HOME=<value>` prefix (or `env HOME=<value>`) of that very command, the value a literal absolute path or
// `$(mktemp -d)`, and neither the user's real home (see REAL_HOME) nor the HOME this office runs with (a second office is measured by its own sessions).
// Text only: a HOME exported by an earlier call is not seen, and an option of an `env` word after the HOME= word that clears it (`-`, `-i`, `--ignore-environment`, `-u HOME`) undoes the prefix.
const MKTEMP = "$(mktemp -d)", MKTEMP_WORD = "\u0001mktemp";
const ownHome = (prefix: string[]) => {
  // Only the options of an `env` word after the HOME= word can clear it, of every such word; another wrapper's `-i` (`stdbuf -i 0`) does not.
  // env's own options end at its first other word (`env F1RM_PORT=4999 stdbuf -i 0 …`); `-u` and `--unset` take the next word as their value.
  const at = prefix.findLastIndex((w) => w.startsWith("HOME="));
  let cleared = false;
  for (let env = at + 1; env < prefix.length; env++) {
    if (unquoted(prefix[env]) !== "env") continue;
    for (let j = env + 1; j < prefix.length && unquoted(prefix[j]).startsWith("-"); j++) {
      const option = unquoted(prefix[j]);
      if (["-", "-i", "--ignore-environment", "-uHOME", "--unset=HOME"].includes(option)) cleared = true;
      if ((option === "-u" || option === "--unset") && unquoted(prefix[++j] ?? "") === "HOME") cleared = true;
    }
  }
  const value = unquoted(prefix[at]?.slice(5) ?? "");
  return !cleared && (value === MKTEMP_WORD || (/^\/[^\s$`~\\*?{}]*$/.test(value) && ![REAL_HOME, homeKey(process.env.HOME || "/"), "/"].includes(homeKey(value))));
};
// What can run `claude` for another command: `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `bun x` (`bun` itself is a wrapper splitCommands drops), `npm exec`.
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "npm", "dlx", "exec", "x"]);
const claudeStart = ({ prefix, words }: { prefix: string[]; words: string[] }) => {
  let i = 0;
  if (PACKAGE_RUNNERS.has(words[0])) for (i = 1; PACKAGE_RUNNERS.has(words[i]) || words[i]?.startsWith("-"); i++);
  // One leading backslash skips an alias (`\claude`); a version is anything (`@^2`, `@~2.1`); the name's case is ignored (APFS).
  if (!/^claude(?:-code)?(?:@\S+)?$/i.test(basename(unquoted(words[i] ?? "").replace(/^\\/, "")))) return null;
  // What follows `--` is another command's (`claude mcp add x -- npx srv -sp 1`), but `npm exec` consumes the first `--` itself and hands claude what follows it.
  const rest = words.slice(i + 1).map(unquoted);
  if (words[0] === "npm" && !words.slice(1, i).includes("--") && rest.includes("--")) rest.splice(rest.indexOf("--"), 1); // not when npm used it before the package
  const args = rest.slice(0, rest.includes("--") ? rest.indexOf("--") : undefined);
  const bg = args.some((a) => a === "--bg" || a === "--background"), print = args.some((a) => a === "--print" || /^-[A-Za-z]*p[A-Za-z]*$/.test(a));
  // A wake resumes the session it names; `--fork-session` starts a new one.
  const wake = args.some((a) => a === "-r" || a === "--resume" || a.startsWith("--resume=")) && !args.includes("--fork-session");
  return bg || print ? { bg, print, wake, home: ownHome(prefix) } : null;
};
// A Founder role drafts and never puts anything out: a connector tool with one of these words in its name is held.
const PUTS_OUT = new Set(["send", "publish", "post", "schedule"]);
/** The words of a tool's name, split on separators and camelCase, so `postgres` and `compost` are not `post`. */
const wordsOf = (tool: string) => tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
// An Agent call let through counts as an intern until its SubagentStart, or for this long if that never comes.
const PENDING_MS = 60_000;
const MAX_BRIEF = 8000;
/** How long the SendMessage gate waits for `claude agents --json --all`. The hook gives up after 5 s and then lets the call through, so a slower listing must read as "can't say" and end in the unknown-name refusal. */
export const GATE_LISTING_MS = 3000;
const PM_DECIDES =
  "The user opened the f1rm office's Hire dialog and left the choice of who to hire to you. Decide which roles this need takes, and hire them per the f1rm guidelines (load f1rm:f1rm-guidelines): interview first if the need is unclear, one task per hire, with `f1rm hire`. Tell the user whom you hired.\n\nThe need:\n";
const INTERN =
  "The user asked, from the f1rm office, that you hand a subtask to an intern: spawn a sub-agent for it, give it everything it needs to work alone, and use its result in your own work. Keep going on your own task meanwhile.\n\nThe subtask:\n";

type Options = {
  port: number;
  secret: string;
  token: string;
  machine: typeof realMachine;
  /** The built browser client. */
  clientDir: string;
  /** SQLite file for the append-only event log; the office is rebuilt from it on start. */
  dbPath?: string;
  /** Where the PM's board files live; without it no room has a board. */
  boardsDir?: string;
  /** Where each project's edition file lives (`~/.f1rm/projects`). */
  projectsDir?: string;
  /** Where Claude Code keeps session transcripts (`~/.claude/projects`): the skill gate reads a refused Skill call from there. */
  transcriptsDir?: string;
  /** The folders that never get a door: the office's own, Claude's and temp folders. Tests inject them. */
  junkRoots?: string[];
  /** How often the board files are checked for edits. */
  boardPollMs?: number;
  /** How long a PermissionRequest hook is held for the browser before the terminal prompt decides. */
  approvalTimeoutMs?: number;
  /** Time source in ms; tests control it. */
  clock?: () => number;
  /** Quiet this long (no event, no transcript write) and an employee goes offline. */
  offlineAfterMs?: number;
  /** Quiet this long and an employee leaves the office. */
  removeAfterMs?: number;
  /** A background hire done this long, with its branch merged, is let go with its worktree and branch. */
  letGoAfterMs?: number;
  /** True while the process with this id runs; tests swap it. Default: a signal-0 call. */
  isAlive?: (pid: number) => boolean;
  /** How long the SendMessage gate waits for the listing of ended hires. */
  gateListingMs?: number;
  /** The recovery tick (see recovery.ts): how often it runs, and the Claude Code, disk and clock it reads. Without it the office recovers nothing. */
  recovery?: { everyMs: number; deps: Omit<RecoveryDeps, "board" | "tell"> };
};

// Dead only on ESRCH (no such process). EPERM means it belongs to someone else, so it is alive; so does any error that does not say it is gone.
// ponytail: a pid the system has handed to another program since reads as alive, so that ghost waits for the quiet path; compare process start times if that is felt.
export const processRuns = (pid: number) => {
  // 0 and -1 would signal a whole process group.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
// How often `claude agents --json` is asked for the pids of employees whose pid is not known yet.
const PID_REFRESH_MS = 30_000;

// Liveness takes a stat and never a parse: the transcript format isn't a public contract, and its mtime is all it needs. (The skill gate's read, skillsTried, parses only Skill tool_use names and fails closed.)
const transcriptMtime = (path?: string) => {
  try {
    return path ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
};

const TRANSCRIPT_READ_MAX = 8 * 1024 * 1024;

/**
 * The skills a session has tried with the Skill tool, whether it ran them or the tool refused (a skill marked disable-model-invocation, or an unknown one).
 * A refusal fires no hook event at all (Claude Code 2.1.308 fails the call at validation, before any hook), so the session's own transcript is the only trace.
 * The path must be `<transcriptsDir>/<project folder>/<sessionId>.jsonl`: the session id and the directory are the office's own, and only the project folder comes from the hook's `transcript_path`.
 * It guards against slips; it is not a security boundary, since the same user can write any line into a transcript.
 * Only the skill names of the session's own (non-sidechain) assistant Skill calls are kept, from the first 8 MB. Anything odd means none: the gate then holds as before.
 */
function skillsTried(transcriptsDir: string, sessionId: string, hint: unknown): Set<string> {
  const tried = new Set<string>();
  try {
    if (typeof hint !== "string" || hint.split(sep).includes("..")) return tried;
    const path = resolve(hint);
    if (basename(path) !== `${sessionId}.jsonl`) return tried; // before any disk access
    const realDir = realpathSync(resolve(transcriptsDir));
    const real = realpathSync(path); // a link that leads elsewhere is not the session's file
    if (real !== join(realDir, basename(dirname(path)), basename(path))) return tried;
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); // a pipe at the path must not hang the office
    let text: string;
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return tried;
      const buffer = Buffer.alloc(Math.min(info.size, TRANSCRIPT_READ_MAX));
      text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"Skill"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
        for (const block of entry.message.content) if (block?.type === "tool_use" && block.name === "Skill" && typeof block.input?.skill === "string") tried.add(block.input.skill);
      } catch {} // a line that is not JSON counts for nothing
    }
  } catch {} // missing, unreadable or odd: no skill counts
  return tried;
}
/** Constant-time credential check. */
function same(given: string | null | undefined, expected: string) {
  const a = Buffer.from(given ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer({
  port, secret, token, machine, clientDir,
  dbPath = ":memory:",
  boardsDir,
  projectsDir,
  transcriptsDir = join(homedir(), ".claude", "projects"),
  junkRoots = defaultJunkRoots(),
  boardPollMs = 500,
  approvalTimeoutMs = DEFAULT_TIMEOUT_S * 1000,
  clock = Date.now,
  offlineAfterMs = 5 * 60_000,
  removeAfterMs = 15 * 60_000,
  letGoAfterMs = 15 * 60_000,
  isAlive = processRuns,
  gateListingMs = GATE_LISTING_MS,
  recovery,
}: Options) {
  clientDir = resolve(clientDir);
  const junk = junkRoots.map(realPath); // resolved once; the injected roots may be raw paths

  const db = new Database(dbPath, { create: true });
  // Another process reading the log (a backup, `sqlite3`) holds a lock; an insert waits for it instead of failing and losing the event.
  db.run("PRAGMA busy_timeout = 2000");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL)");
  const append = db.prepare("INSERT INTO events (at, event) VALUES (?, ?)");

  // ponytail: replays the whole log on every start; add snapshots or pruning when startup gets slow.
  let state = emptyOffice();
  // Agent calls let through and not started yet, by session: parallel calls all reach PreToolUse before any SubagentStart.
  const pendingInterns = new Map<string, number[]>();
  // The skills a hire's first prompt names, and the ones its Skill calls have loaded, by session. The prompt itself is never kept.
  // ponytail: in memory, so an office restart empties it and the gate fails open; persist it if hires outlive restarts in practice.
  // The sub-agent ids each session has started, kept after they stop: the reducer drops a finished intern, and its parent may still resume it.
  // ponytail: a session's ids go when its SessionEnd comes through the hook; one swept away by the office (a crash) keeps its few ids until a restart.
  const subagents = new Map<string, Set<string>>();
  /** The sessions that have had a prompt, live or replayed: only the first one can arm the skill gate. */
  const prompted = new Set<string>();
  /** Kept for each event the office takes in, live or replayed from the log. */
  const trackSession = (e: F1rmEvent) => {
    if (e.kind === "UserPromptSubmit") prompted.add(e.sessionId);
    if (e.kind === "SubagentStart" && e.intern) subagents.set(e.sessionId, (subagents.get(e.sessionId) ?? new Set()).add(e.intern.id));
    if (e.kind === "SessionEnd") subagents.delete(e.sessionId);
  };
  const skillGates = new Map<string, { required: string[]; security: boolean; loaded: Set<string> }>();
  /** `machine.sessions()` within the gate's time; null when it can't say, a timeout included. */
  const gateSessions = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), gateListingMs)));
    try {
      return await Promise.race([Promise.resolve(machine.sessions?.()).catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * The hire of the sender's project that `name` (its name, session id or short id) points at when no session of that name has a live process: `claude agents --json --all` lists
   * it done, stopped, failed or blocked on a limit, with no pid. An employee-shaped record in the sender's room, so the same checks apply to it; null for anything else (no project, no such hire,
   * another project's, or a name that has a live session). A listing that can't be read finds none.
   */
  async function endedHire(me: Employee, name: string): Promise<Employee | null> {
    if (!me || me.room === ELSEWHERE.id) return null;
    const project = folderOf(me.room);
    const mine = ((await gateSessions()) ?? []).filter((s) => s.kind === "background" && hireName(s.name) && repoOf(s.cwd) === project);
    const found = mine.find((s) => s.name === name || s.sessionId === name || s.id === name);
    const hire = found && hireName(found.name);
    if (!found || !hire || mine.some((s) => s.name === found.name && s.pid)) return null;
    return { sessionId: found.sessionId ?? found.id, name: found.name, role: roleOfAgentType(`f1rm:${hire.role}`) ?? null, title: found.name, status: "offline", activity: "", tool: "", cwd: found.cwd, room: me.room, lastEventAt: 0 } as Employee;
  }
  /** Why the company's rules stop this tool call, or null to let it run. */
  async function refusal(sessionId: string, payload: Record<string, any>): Promise<string | null> {
    const role = state.employees[sessionId]?.role;
    if (!role) return null;
    const tool = String(payload.tool_name ?? "");
    const input = payload.tool_input ?? {};
    // Each refusal is logged (stdout is ~/.f1rm/office.log) with who, which tool and which rule, never the command or the contents.
    const refuse = (rule: string, why: string) => (console.log(`refused ${role} ${state.employees[sessionId]?.title ?? sessionId} ${tool} ${rule}`), why);
    // Only the hire itself is held: a sub-agent, such as the one its first slash command forks, works at once.
    const gate = payload.agent_id ? undefined : skillGates.get(sessionId);
    if (gate) {
      // A refused Skill call leaves no hook event, so a call about to be held looks in the transcript for a try of the skills the first prompt named.
      // The security hold counts only a skill that ran (its PostToolUse), never a try: security-review is never taken from the transcript.
      let missing = READING.has(tool) ? [] : gate.required.filter((r) => !gate.loaded.has(r));
      if (missing.length) {
        for (const skill of skillsTried(transcriptsDir, sessionId, payload.transcript_path)) if (skill !== "security-review" && gate.required.includes(skill)) gate.loaded.add(skill);
        missing = missing.filter((r) => !gate.loaded.has(r));
      }
      if (missing.length) return refuse("skills", `Load these first with the Skill tool: ${missing.join(", ")}. A skill the Skill tool refuses counts as tried after one call: if it says disable-model-invocation, go on without it; if it says Unknown skill, go on and send \`BLOCKED <task>\` with its name to the session in your Report to.`);
      if (gate.security && !gate.loaded.has("security-review") && tool === "SendMessage" && String(input.message ?? "").trimStart().startsWith("APPROVED")) {
        return refuse("security", "Run security-review with the Skill tool on the merge before you send APPROVED.");
      }
    }
    // Projects are isolated: a message goes to "main", to the sender's own sub-agent (finished ones too: SendMessage resumes them), or to a session of the sender's own room.
    // A target is a title, a session id or a `uds:<socket path>` (an employee's `socket`); an offline session answers to none of them.
    // ponytail: a ` [ref]` after a name is ignored, because the office cannot compute the ref Claude Code builds; a mirror of the same session is in the same project, so the bare name decides.
    // A name that no session answers to, or that sessions in two rooms answer to, is unknown and refused. The sender's room is the one the office holds for it.
    // Elsewhere is no room: two sessions there may message each other only when one's cwd is inside the other's folder, and that folder is not / or the home folder.
    // "main" is the user's own top-level session, open to everyone, unless a session is titled main: then the checks below apply to it. From a sub-agent "main" is its parent conversation, whatever a session is titled.
    // Within the project, who talks to whom: an intern only to its parent or "main", the PM only to leads, a lead to the PM, leads and its team, a member to its lead and its team,
    // and a member's formal report only to its lead. A sender with no role is never held, and the user is no session.
    if (tool === "SendMessage" && input.to !== undefined) {
      const to = String(input.to);
      const name = to.trim().replace(/\s+\[[^\]]*\]$/, "");
      const socket = /^uds:(.+)$/.exec(name)?.[1];
      let answering = Object.values(state.employees).filter((e) => e.status !== "offline" && (socket ? e.socket?.replace(/^uds:/, "") === socket : e.title === name || e.sessionId === name));
      const intern = !!payload.agent_id;
      // A hire of the sender's project whose process has ended answers to no employee, and a message to it would be queued and never arrive: it goes through the checks below as the hire it is, then is refused with the way back.
      const gone = !intern && !socket && !answering.length && to !== "main" && !subagents.get(sessionId)?.has(to) ? await endedHire(state.employees[sessionId], name) : null;
      if (gone) answering = [gone];
      const rooms = new Set(answering.map((e) => e.room));
      if ((to !== "main" || (!intern && answering.length > 0)) && (intern || !subagents.get(sessionId)?.has(to))) {
        const me = state.employees[sessionId];
        if (rooms.size !== 1) return refuse("project-unknown", "Projects are isolated, and that name is unknown to the office, or more than one project answers to it. Use the `uds:` address of the session in your own project; a problem with f1rm itself goes to the user as `f1rm feedback: <problem> -> <suggestion>`, addressed to no session.");
        if (!rooms.has(me.room)) return refuse("project", "Projects are isolated: message only sessions of your own project. A problem with f1rm itself goes to the user as `f1rm feedback: <problem> -> <suggestion>`, addressed to no session.");
        if (me.room === ELSEWHERE.id && !answering.every((e) => sameFolder(realCwd(me.cwd), realCwd(e.cwd)))) {
          return refuse("elsewhere", "Elsewhere is no room: a session outside every project may message only a session working under the same folder. Use `f1rm feedback: <problem> -> <suggestion>` for the user, addressed to no session.");
        }
        if (intern) {
          if (answering.some((e) => e.sessionId !== sessionId && (me.title === undefined || e.title !== me.title))) return refuse("intern-message", "An intern messages only its parent session or \"main\": put what you found in your result.");
        } else {
          const team = teamOf(me), talk = TALK[role === "pm" || role === "lead" ? role : "member"];
          const bad = answering.find((e) => !talk.allows(team, e));
          if (bad) return refuse("messaging", `Who talks to whom: ${talk.wayOut(team, bad)}`);
          if (!COORDINATORS.has(role) && FORMAL_REPORT.test(String(input.message ?? "")) && answering.some((e) => e.role !== "lead")) {
            return refuse("formal-report", `Who talks to whom: a formal report (DONE, APPROVED, CHANGES REQUESTED, BLOCKED, ESCALATE) goes to your lead only, ${leadOf(team)}, never to a peer. Tell a peer in plain words.`);
          }
          if (gone) {
            const target = hireName(gone.title!)!;
            const wayOut = mayWake({ role, team }, target) ? "Wake it, then message it." : target.role === "lead" ? "The PM wakes a lead: resend after the wake." : `Only the lead of its team wakes a member: ask ${leadOf(team)}, and resend after the wake.`;
            return refuse("no-live-session", `${gone.title}: no live session; f1rm wake ${gone.title} resumes it in place, with its context. ${wayOut} A message to a session that has ended is queued and never arrives.`);
          }
        }
      }
    }
    // A permission request is answered by the user's browser only: a command that names an answer route (approve, deny, always) of this office, by its port, its link key or the saved link, is refused.
    // ponytail: it guards against a slip, not a determined session that builds the address piece by piece; the link key lives in a file the user's account can read.
    if (tool === "Bash") {
      const line = String(input.command ?? "");
      if (/(?:approve|deny|always)\/[^\s'"]/.test(line) && (line.includes(token) || line.includes("office-url") || new RegExp(`(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${server.port}\\b`).test(line))) {
        return refuse("answer", "Only the user answers a permission request, in the office: tell the session in your Report to what you are waiting for, and wait.");
      }
    }
    // The Bash line is split once; `$(mktemp -d)` is one word, so a HOME made of it stays in its command's prefix.
    const split = tool === "Bash" ? splitCommands(String(input.command ?? "").replaceAll(MKTEMP, MKTEMP_WORD)) : [];
    const commands = split.map((c) => c.words);
    const hires = commands.flatMap((c) => hireOf(hireArgs(c)) ?? []);
    if (SPECIALISTS.has(role) && commands.some((c) => hireArgs(c))) {
      return refuse("hire", "Only the PM and team leads hire. Send what you need to the session named in your brief's Report to.");
    }
    // `f1rm wake` follows the hire rules: whoever may hire a name may wake it. The target is a name, or a session id the listing resolves to one; an unknown one is the command's own refusal.
    if (SPECIALISTS.has(role) && commands.some((c) => hireArgs(c, "wake"))) {
      return refuse("wake", "Only the PM and team leads wake a hire. Send what you need to the session named in your brief's Report to.");
    }
    const wakeCalls = COORDINATORS.has(role) ? commands.map((c) => hireArgs(c, "wake")).filter((a): a is string[] => !!a) : [];
    if (wakeCalls.length) {
      const sessions = (await gateSessions()) ?? [];
      const me = state.employees[sessionId];
      for (const args of wakeCalls) {
        const target = args.find((a) => !a.startsWith("-"));
        const name = target && (hireName(target) ? target : sessions.find((s) => s.kind === "background" && (s.sessionId === target || s.id === target))?.name);
        const hire = name ? hireName(name) : null;
        if (hire && !mayWake({ role, team: teamOf(me) }, hire)) {
          return refuse("wake", role === "pm" ? "The PM wakes leads; a lead wakes the members of its own team. Ask that lead to wake it." : `A lead wakes only the members of its own team (${teamOf(me) ?? "<team>"}.…); the PM wakes leads. Ask ${hire.team ? leadOf(hire.team, "their lead") : "the PM"}.`);
        }
      }
    }
    if (role === "pm" && hires.some((h) => h.role !== "lead")) return refuse("hire", "PMs hire leads; send this to a lead. A lead hires the specialists of its team.");
    if (role === "lead") {
      const team = teamOf(state.employees[sessionId]);
      if (hires.some((h) => h.role === "lead")) return refuse("hire", "A lead hires specialists for its own team, never another lead. Ask the PM for a new team.");
      if (hires.some((h) => !team || h.team !== team)) return refuse("hire", `A lead hires only into its own team: add --team ${team ?? "<your team>"}.`);
    }
    if (COORDINATORS.has(role) && WRITE_TOOLS.has(tool)) {
      const file = resolve(String(payload.cwd ?? "/"), String(input.file_path ?? input.notebook_path ?? ""));
      const home = process.env.HOME ?? "";
      const dirs = [boardsDir, home && join(home, ".f1rm", "milestones"), home && join(home, ".f1rm", "kept"), home && join(home, ".claude", "agent-memory"), home && join(home, ".f1rm", "evidence")];
      const scratch = ["/private/tmp/claude-", "/tmp/claude-"];
      if (!dirs.some((d) => d && file.startsWith(resolve(d) + sep)) && !scratch.some((p) => file.startsWith(p))) {
        return refuse("write", "The PM and leads write only boards, milestones, kept files, memory, evidence and scratch files. Put this work on the board and hire for it.");
      }
    }
    if (COORDINATORS.has(role) && commands.some((w) => LANDING.has(gitCall(w)?.sub ?? "") || ghLands(w))) {
      return refuse("landing", "Landing, merging and pushing belong to the Reviewer and the user. Hire for it, or ask the user to run it with `!`.");
    }
    if (commands.some((w) => gitCall(w)?.sub === "push" || ghLands(w))) return refuse("push", "Only the user pushes, and merges pull requests. Tell the session in your Report to that the work is ready.");
    if (role === "reviewer" && commands.some((w) => reviewerRefused(gitCall(w)))) {
      return refuse("history", "A Reviewer merges with --no-ff or --ff-only and rewrites nothing: no reset, rebase, cherry-pick, revert, am, pull, clean, stash, commit --amend, checkout -- <path>, branch -D or force. Only `git worktree remove --force .claude/worktrees/red-<task>` may force.");
    }
    if (FOUNDER_ONLY.has(role) && tool.startsWith("mcp__") && wordsOf(tool).some((w) => PUTS_OUT.has(w))) {
      return refuse("founder", "Drafts only: a Founder role never posts, publishes, sends or schedules. Save it as a draft and hand it to the session in your brief's Report to; the founder puts it out.");
    }
    // Recurring work: the /loop and /schedule skills and the tools they start it with.
    if ((tool === "Skill" && /^(?:[\w-]+:)?(?:loop|schedule)$/.test(String(input.skill ?? "").trim().replace(/^\//, ""))) || ["ScheduleWakeup", "CronCreate", "RemoteTrigger"].includes(tool)) {
      return refuse("loop", "/loop and /schedule are refused for every employee: recurring work keeps a session going on the shared usage limit. Do the step once and report, or watch with a background shell command (Bash with run_in_background).");
    }
    const starts = split.flatMap((c) => claudeStart(c) ?? []);
    if (starts.some((s) => !s.home && !(COORDINATORS.has(role) && s.bg && s.wake && !s.print))) {
      return refuse("session-start", "Sessions start only with `f1rm hire`; a stray `claude --bg` or `claude -p` burns the shared usage limit and escapes the board. Only the PM and the leads wake a session, with `claude --bg --resume <id>`. A second-office proof gives that command its own HOME as a prefix: a literal absolute path or exactly `$(mktemp -d)`, as in `HOME=<tmp> claude …`.");
    }
    if (tool === "Agent" || tool === "Task") {
      if (String(input.subagent_type ?? "").startsWith("f1rm:")) return refuse("intern-role", "A role is hired with `f1rm hire`, never started as an intern.");
      const now = clock();
      const pending = (pendingInterns.get(sessionId) ?? []).filter((t) => now - t < PENDING_MS);
      const running = Object.values(state.interns).filter((i) => i.parent === sessionId).length;
      if (running + pending.length >= INTERNS) return refuse("interns", `You already have ${INTERNS} interns working, the most an employee runs at once. Wait for one to finish, or do this step yourself.`);
      pendingInterns.set(sessionId, [...pending, now]);
    }
    return null;
  }
  // The folder comes from the room the office holds, never from the request. A repo's room id is its git common dir.
  // ponytail: a submodule's common dir lives under .git/modules, so its room resolves to the wrong folder; use an employee's cwd there if it is felt.
  const folderOf = repoDir;
  // A session belongs to the registered folder (~/.f1rm/projects/<enc>.json, written only by `f1rm pm`, never by this office) that
  // contains its cwd, the nearest one first, so a subfolder or a worktree, even one removed since, rolls up to its project's door and
  // never gets its own. Git is not asked about the cwd. A cwd in a junk folder, or under no registered folder, is Elsewhere.
  // The registration is looked up on every call, so a folder registered while the office runs gets its door on its next event.
  // ponytail: cwdPaths holds every distinct cwd ever seen, as the per-cwd cache before it did; prune it if a very long-lived office feels it.
  // cwd -> the folders to look at, nearest first (null for a junk cwd), and the resolved cwd with its real path
  const cwdPaths = new Map<string, { paths: string[] | null; chain: string[] }>();
  const junkFolders = new Map<string, boolean>();
  const doorIds = new Map<string, string>(); // registered folder -> its room id
  const ancestors = (p: string) => {
    const all = [p];
    for (let q = dirname(p); q !== all.at(-1); q = dirname(q)) all.push(q);
    return all;
  };
  // The real path of a cwd, as roomOf resolved it.
  const realCwd = (cwd: string) => cwdPaths.get(cwd)?.chain[1] ?? realPath(resolve(cwd));
  const roomOf = (cwd: string): Room => {
    if (!projectsDir) return ELSEWHERE;
    let info = cwdPaths.get(cwd);
    if (!info) {
      const abs = resolve(cwd), real = realPath(abs); // a trailing slash is dropped, and a symlinked cwd is also looked up by its real path
      // The cwd's chain and its real path's chain are interleaved by distance from the cwd, so neither beats a nearer folder of the other.
      const chains = [ancestors(abs), ancestors(real)];
      const near = Array.from({ length: Math.max(...chains.map((c) => c.length)) }, (_, i) => chains.map((c) => c[i])).flat().filter((p): p is string => !!p);
      // Junk by its own path or by its real one, against the roots as given and past their links: a link out of ~/.f1rm, or one into /tmp, is no project's.
      const junked = [abs, real].some((c) => [...junk, ...junkRoots].some((r) => inside(r, c)));
      cwdPaths.set(cwd, (info = { paths: junked ? null : [...new Set(near)], chain: [abs, real] }));
    }
    // ponytail: the file name is lossy (/code/my/shop and /code/my-shop name the same file), so an unregistered folder can get a door
    // through a lookalike's registration, with its own path as the id; decode the registered path from the file if it is felt.
    for (const p of info.paths ?? []) {
      if (basename(p) === ".git" || !existsSync(projectFile(projectsDir, p))) continue; // a cwd inside a repo's own .git belongs to the repo around it
      // A registered folder inside a junk folder gives no door, however the cwd got there (a link into it).
      let junked = junkFolders.get(p);
      if (junked === undefined) junkFolders.set(p, (junked = isJunk(p, junk)));
      if (junked) continue;
      // A repo is registered under its git common dir and a plain folder under itself; both name the same file.
      // ponytail: the id is decided once per registered folder, so a `git init` after the registration, or a folder that was missing or unreadable at
      // first sight, takes effect after a restart (or after a Remove); without that a door would flip from P to P/.git while the old one lingers.
      let id = doorIds.get(p);
      if (!id) doorIds.set(p, (id = machine.isRepo(p) ? join(p, ".git") : p));
      return { id, name: id === p ? basename(p) || p : roomName(id) };
    }
    return ELSEWHERE;
  };
  // A door whose registration was removed outside the office, with nobody left in it, goes too.
  const dropStaleDoors = () => {
    const stale = Object.keys(state.rooms).filter((id) => id !== ELSEWHERE.id && projectsDir && !existsSync(projectFile(projectsDir, id)) && !Object.values(state.employees).some((e) => e.room === id));
    if (!stale.length) return false;
    for (const id of stale) doorIds.delete(folderOf(id)); // a later registration decides its id again
    state = { ...state, rooms: Object.fromEntries(Object.entries(state.rooms).filter(([id]) => !stale.includes(id))) };
    return true;
  };

  // The doors the user removed, by when: the events before that no longer build the room.
  const forgottenFile = projectsDir && join(dirname(projectsDir), "forgotten-doors.json");
  const forgotten = readForgotten(forgottenFile);
  // The log keeps the rooms it was written with; they are decided again here, so a rule change reaches the old events.
  const replayed = new Map<string, Room>(); // one lookup per distinct cwd while replaying; live events look again, so a later registration is seen
  for (const row of db.query("SELECT event FROM events ORDER BY id").all() as { event: string }[]) {
    try {
      const e: F1rmEvent = JSON.parse(row.event);
      let room = replayed.get(e.cwd);
      if (!room) replayed.set(e.cwd, (room = roomOf(e.cwd)));
      e.room = room;
      // An event from before its door was removed stays out. It no longer resolves to that door: with no registration left it is
      // Elsewhere, or the door of a registered folder around the removed one. So it is told by its cwd being inside the removed
      // folder, unless a registered folder inside the removed one holds it.
      const removed = Object.entries(forgotten).some(([id, at]) => {
        const folder = folderOf(id);
        return e.at < at && (e.room.id === id || ((cwdPaths.get(e.cwd)?.chain ?? [resolve(e.cwd)]).some((c) => inside(folder, c)) && !(e.room.id !== ELSEWHERE.id && folderOf(e.room.id) !== folder && inside(folder, folderOf(e.room.id)))));
      });
      if (!removed) (state = reduce(state, e), trackSession(e));
    } catch {} // a row this build can't read must not stop the office from starting
  }
  dropStaleDoors();

  const employeeOf = (id: string) => (Object.hasOwn(state.employees, id) ? state.employees[id] : undefined);
  const pmOf = (room: string) => Object.values(state.employees).find((e) => e.room === room && e.role === "pm");
  const tellEmployee = (employee: Employee, message: string) => {
    // No socket header yet: messaging is off for the session, or it has not reported since f1rm started.
    if (!employee.socket) return Promise.resolve(Response.json({ ok: false, error: "This session has no inbox to tell." }, { status: 409 }));
    return machine.tell(employee.socket, employee.sessionId, message).then(
      () => Response.json({ ok: true }),
      (err: Error) => Response.json({ ok: false, error: `Tell failed: ${err.message}` }, { status: 409 }),
    );
  };

  // What the office records when a session is gone, so a replay shows the same departure.
  const departure = (e: Employee): F1rmEvent => ({ sessionId: e.sessionId, kind: "SessionEnd", cwd: e.cwd, room: state.rooms[e.room], terminal: e.terminal, at: clock() });

  // The process id of each session `claude agents --json` has listed, so a dead process can be told from a quiet session without spawning `claude` every few seconds.
  const pids = new Map<string, number>();
  let listedAt = -Infinity;
  // Counts each session's events, so a listing begun before one of them does not decide that session: its pid may be the one a resumed session just left, its status older than the hook.
  // ponytail: never pruned (a number per session id); drop it in endSession if that ever matters.
  const eventCounts = new Map<string, number>();
  // The run under way, shared: the sweep and the process check are given the same listing, never two `claude agents` at once.
  let listing: ReturnType<typeof listOnce> | undefined;
  /** Asks `claude agents --json` for the live sessions, keeps their pids and lets their status decide working vs idle; null if it can't say. */
  const listSessions = () => (listing ??= listOnce().finally(() => (listing = undefined)));
  async function listOnce() {
    const before = new Map(eventCounts);
    const listed = await machine.liveSessions();
    const fresh = new Map([...(listed ?? [])].filter(([id]) => eventCounts.get(id) === before.get(id)));
    if (fresh.size === (listed?.size ?? 0)) listedAt = clock();
    for (const [id, { pid }] of fresh) if (typeof pid === "number") pids.set(id, pid);
    const next = listed ? applyListing(state, fresh, new Set(approvals.list().map((a) => a.sessionId))) : state;
    if (next !== state) {
      state = next;
      push();
    }
    return listed;
  }
  /** The employee leaves as if its SessionEnd had come: logged, so a replay shows it, and its interns go too. The caller pushes. */
  function endSession(e: Employee) {
    if (!employeeOf(e.sessionId)) return;
    const gone = departure(e);
    append.run(gone.at, JSON.stringify(gone));
    state = reduce(state, gone);
    pids.delete(e.sessionId);
    approvals.release(e.sessionId);
  }
  const processEnded = (e: Employee) => pids.has(e.sessionId) && !isAlive(pids.get(e.sessionId)!);

  let boards: Record<string, BoardRow[]> = {};
  let teamBoards: Record<string, Record<string, BoardRow[]>> = {};
  let editions: Record<string, Edition> = {};
  const approvals = createBroker(approvalTimeoutMs, () => push());
  // Without a settings folder there is nowhere to keep an edition, so the page isn't told about editions at all and never asks.
  // The teams (room and team, one string) whose board holds an open question for the user.
  let asking = new Set<string>();
  // A lead waits on the user while its own permission request is held, or its team's board holds an open question. The reducer never sees this; the snapshot adds it.
  const needsYou = (e: Employee) => e.role === "lead" && (approvals.list().some((a) => a.sessionId === e.sessionId) || asking.has(`${e.room}\n${teamOf(e)}`));
  const employeesNow = () => Object.fromEntries(Object.entries(state.employees).map(([id, e]) => [id, needsYou(e) ? { ...e, needsYou: true } : e]));
  const snapshot = () => JSON.stringify({ ...state, employees: employeesNow(), boards, teamBoards, ...(projectsDir && { editions }), approvals: approvals.list() });
  const push = () => server.publish("office", snapshot());

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // The fork can be silent for a while (starting up, reading files) before its first words.
    idleTimeout: 120,
    async fetch(req, server) {
      await ready;
      // Host defeats DNS rebinding; Origin defeats other sites (hooks send none).
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const origin = req.headers.get("origin");
      if (!hosts.includes(req.headers.get("host") ?? "") || (origin !== null && !hosts.some((h) => origin === `http://${h}`))) {
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ingest" && req.method === "POST") {
        if (!same(req.headers.get("x-f1rm-secret"), secret)) return new Response("unauthorized", { status: 401 });
        const payload = await req.json().catch(() => null);
        const event = normalize(payload, req.headers, roomOf, clock());
        if (event) {
          append.run(event.at, JSON.stringify(event));
          state = reduce(state, event);
          // Other ways a room empties (the sweep, a process that died) are caught by the board poll within boardPollMs.
          if (event.kind === "SessionEnd") dropStaleDoors();
          // A new process (a resumed session keeps its id) has no known pid: ask `claude agents` for it at the next check.
          if (event.kind === "SessionStart") {
            pids.delete(event.sessionId);
            listedAt = -Infinity;
          }
          eventCounts.set(event.sessionId, (eventCounts.get(event.sessionId) ?? 0) + 1);
          // ponytail: any later event drops the session's hand, so a parallel tool call can drop it early and the prompt falls back to the terminal; correlate by tool_use_id if that is felt.
          // The exceptions are the notification about the very prompt being held, and a sub-agent's events (a reviewer's /code-review fork, a dev's interns): they say nothing about the session's own prompt.
          if (!event.kind.startsWith("Notification/") && !event.inSubagent && !event.kind.startsWith("Subagent")) approvals.release(event.sessionId);
          push();
          // A company employee's first prompt may name skills to load; a successful Skill call from the session itself loads one, and a try read from its transcript counts for the named ones.
          // Only the first: a later prompt or message may quote the sentence, and arming again would swap in names the session cannot load.
          // A session that keeps its id (`claude attach`, or a flagless `claude --bg --resume` that continues it) has had its first prompt already. One woken by `f1rm wake` (or forked on resume) is a new session id whose first prompt is the resume note, which re-lists no skills; it arms only when the note repeats the security sentence, as a woken high-level Reviewer's does, on purpose.
          if (event.kind === "UserPromptSubmit" && !prompted.has(event.sessionId) && state.employees[event.sessionId]?.role) {
            const prompt = String(payload.prompt ?? "");
            const at = prompt.indexOf(LOAD_FIRST);
            const required = at < 0 ? [] : prompt.slice(at + LOAD_FIRST.length).split(/\.(?:\s|$)/)[0].split(",").map((s) => s.trim()).filter(Boolean);
            const security = prompt.includes(SECURITY);
            if (required.length || security) skillGates.set(event.sessionId, { required, security, loaded: new Set() });
          }
          if (event.kind === "PostToolUse" && payload.tool_name === "Skill" && !payload.agent_id) skillGates.get(event.sessionId)?.loaded.add(String(payload.tool_input?.skill ?? ""));
          if (event.kind === "PreToolUse") {
            const why = await refusal(event.sessionId, payload);
            if (why) return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
          }
          trackSession(event);
          if (event.kind === "SubagentStart" || (event.kind === "PostToolUseFailure" && ["Agent", "Task"].includes(String(payload.tool_name)))) {
            pendingInterns.get(event.sessionId)?.shift();
          }
          if (event.kind === "PermissionRequest") {
            server.timeout(req, 0); // the hold outlasts the idle timeout
            const tool = String(payload.tool_name ?? "");
            const decision = await approvals.hold(event.sessionId, tool, payload.tool_input, event.at, req.signal, () => lastSaid(transcriptsDir, event.sessionId, payload.transcript_path), alwaysRules(tool, payload.tool_input, payload.permission_suggestions));
            if (decision) return Response.json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
          }
        }
        return new Response(null, { status: 200 });
      }
      // Everything for the browser lives under /<ui token>/, so every request carries the token.
      const [, given, ...rest] = url.pathname.split("/");
      if (!same(given, token)) return new Response("<!doctype html><title>f1rm</title><p>Open the office with <code>f1rm</code>.", { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      if (rest.length === 0) return new Response(null, { status: 307, headers: { location: `/${given}/` } });
      const path = rest.join("/");
      if (rest.length === 2 && ["jump", "approve", "deny", "always", "ask", "tell", "letgo", "intern", "remove"].includes(rest[0]) && req.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      }
      if (rest[0] === "jump" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        if (!pids.has(employee.sessionId) && clock() - listedAt >= PID_REFRESH_MS) await listSessions();
        if (processEnded(employee)) {
          endSession(employee);
          push();
          return Response.json({ ok: false, ended: true, error: "This session has ended" }, { status: 410 });
        }
        const result = await jump(machine, employee);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if (rest[0] === "always" && rest.length === 2) {
        if (approvals.always(rest[1])) return Response.json({ ok: true });
        return approvals.list().some((a) => a.id === rest[1])
          ? Response.json({ ok: false, error: "There is no rule to add for that request; approve it once, or answer at the terminal." }, { status: 409 })
          : Response.json({ ok: false, error: "That request is no longer waiting; the terminal has it." }, { status: 404 });
      }
      if ((rest[0] === "approve" || rest[0] === "deny") && rest.length === 2) {
        const decided = approvals.answer(rest[1], rest[0] === "approve" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE });
        return decided
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "That request is no longer waiting; the terminal has it." }, { status: 404 });
      }
      if (rest[0] === "ask" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ error: "No such employee." }, { status: 404 });
        const question = ((await req.json().catch(() => null)) as { question?: unknown } | null)?.question;
        if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
          return Response.json({ error: `Ask a question of 1 to ${MAX_QUESTION} characters.` }, { status: 400 });
        }
        return new Response(askStream(machine, employee, question.trim()), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }
      if (rest[0] === "tell" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const message = ((await req.json().catch(() => null)) as { message?: unknown } | null)?.message;
        if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) {
          return Response.json({ ok: false, error: `Tell a message of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
        }
        return tellEmployee(employee, message.trim());
      }
      if (rest[0] === "intern" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ ok: false, error: "No such employee." }, { status: 404 });
        const subtask = ((await req.json().catch(() => null)) as { subtask?: unknown } | null)?.subtask;
        if (typeof subtask !== "string" || !subtask.trim() || subtask.length > MAX_MESSAGE) {
          return Response.json({ ok: false, error: `Name a subtask of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
        }
        return tellEmployee(employee, INTERN + subtask.trim());
      }
      if (rest[0] === "remove" && rest.length === 2) {
        // Forgets an empty door and its registration; boards, evidence and the repo are never touched. The door comes back only when `f1rm pm` registers the folder again.
        let room = "";
        try {
          room = decodeURIComponent(rest[1]);
        } catch {} // a malformed escape names no door
        if (room === ELSEWHERE.id) return Response.json({ error: "The Elsewhere door can't be removed." }, { status: 409 });
        if (!Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such door." }, { status: 404 });
        if (Object.values(state.employees).some((e) => e.room === room)) return Response.json({ error: "That door isn't empty." }, { status: 409 });
        forgotten[room] = clock();
        if (forgottenFile) writeForgotten(forgottenFile, forgotten);
        if (projectsDir) rmSync(projectFile(projectsDir, room), { force: true });
        doorIds.delete(folderOf(room)); // a `git init` before the next `f1rm pm` gets the new id
        const { [room]: _, ...kept } = state.rooms;
        state = { ...state, rooms: kept };
        const { [room]: _e, ...left } = editions;
        editions = left;
        delete boards[room];
        delete teamBoards[room];
        push();
        return Response.json({ ok: true });
      }
      if (rest[0] === "background" && rest.length === 2) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        const employee = employeeOf(rest[1]);
        return Response.json({ background: !!employee && (await machine.backgroundId(employee.sessionId)) !== null });
      }
      if (rest[0] === "letgo" && rest.length === 2) {
        const employee = employeeOf(rest[1]);
        if (!employee) return Response.json({ error: "No such employee." }, { status: 404 });
        if (((await req.json().catch(() => null)) as { confirm?: unknown } | null)?.confirm !== true) {
          return Response.json({ error: "Letting someone go needs an explicit confirm." }, { status: 400 });
        }
        const id = await machine.backgroundId(employee.sessionId);
        if (!id) return Response.json({ error: "Only a background hire can be let go." }, { status: 409 });
        try {
          await machine.letGo(id);
        } catch (err) {
          return Response.json({ error: `Let go failed: ${(err as Error).message}` }, { status: 502 });
        }
        // The session may never send its own SessionEnd, so the office records the departure itself.
        endSession(employee);
        push();
        return Response.json({ ok: true });
      }
      if (rest[0] === "roles" && rest.length === 1) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        const room = url.searchParams.get("room");
        const staff = Object.values(state.employees);
        // Company order, like the desks, but the specialists first: they are the usual hire, so the first one is preselected. Then the lead, then a role file the office doesn't know.
        const order = (id: string) => {
          const known = roleOfAgentType(`f1rm:${id}`);
          return known === "lead" ? ROLE_IDS.length : known ? ROLE_IDS.indexOf(known) : ROLE_IDS.length + 1;
        };
        // The cap counts every working background hire on the machine, as `claude agents` lists them, not this project's. Null when it can't be counted.
        const hires = await machine.workingHires();
        return Response.json({
          roles: readRoles()
            // A Work project hires no founder role; a project with no edition chosen counts as Work.
            .filter((r) => editions[room ?? ""] === "founder" || !FOUNDER_ONLY.has(roleOfAgentType(`f1rm:${r.id}`)!))
            .sort((a, b) => order(a.id) - order(b.id))
            .map((r) => {
              const known = roleOfAgentType(`f1rm:${r.id}`);
              const working = staff.filter((e) => known && e.role === known && e.room === room && (e.status === "working" || e.status === "waiting")).length;
              return { ...r, title: known ? ROLES[known].title : r.id, working };
            }),
          hires: { working: hires, cap: CAP },
        });
      }
      if (rest[0] === "show" && rest.length === 1) {
        // A bare `f1rm` asks the open office pages to show a project, so it opens a new tab only when none is open.
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const { room } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if (typeof room !== "string" || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        const pages = server.subscriberCount("office");
        if (pages) server.publish("office", JSON.stringify({ show: room }));
        return Response.json({ pages });
      }
      if (rest[0] === "edition" && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const { room, edition } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        if (!isEdition(edition)) return Response.json({ error: "The edition is work or founder." }, { status: 400 });
        if (!projectsDir) return Response.json({ error: "This office keeps no project settings." }, { status: 500 });
        // The dialog only changes a registration `f1rm pm` made; it never creates one.
        try {
          changeEdition(projectFile(projectsDir, room), edition); // fails when the file is missing, so it can't create one
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          return Response.json({ error: "This project isn't registered. Run `f1rm pm` in it first." }, { status: 404 });
        }
        editions = { ...editions, [room]: edition };
        push();
        return Response.json({ ok: true });
      }
      if (rest[0] === "hire" && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const { room, role, task, team, brief, model, override } = body ?? {};
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        if (typeof role !== "string" || typeof task !== "string" || typeof brief !== "string" || !brief.trim() || brief.length > MAX_BRIEF || (model != null && typeof model !== "string") || (team != null && typeof team !== "string") || (override != null && typeof override !== "boolean")) {
          return Response.json({ error: `Hire needs a role, a task name, a model and a team that are strings, an override that is true or false, and a brief of 1 to ${MAX_BRIEF} characters.` }, { status: 400 });
        }
        const folder = folderOf(room);
        // Asked at most once, and only when something needs it: the PM's name and the path limit both read it, after the cheap checks.
        let common: string | null | undefined;
        const lookup = () => (common === undefined ? (common = machine.gitCommonDir(folder)) : common);
        let argv: string[];
        try {
          argv = await planHire({ role, task, team: team ?? null, cwd: folder, edition: editions[room] ?? null, brief: brief.trim(), reportTo: pmOf(room) ? () => pmName(folder, { gitCommonDir: lookup }) : null, model, override: override === true }, { backgroundSessions: () => machine.backgroundSessions(), gitCommonDir: lookup });
        } catch (err) {
          if (err instanceof HireRefused) return Response.json({ error: err.message, working: err.working }, { status: 409 });
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
        // ponytail: two hires posted at the same instant can both pass the count before either shows in `claude agents`; serialize them if that is felt.
        return machine.spawnBackground(argv, folder).then(
          () => Response.json({ ok: true }),
          (err: Error) => Response.json({ error: `Hire failed: ${err.message}` }, { status: 502 }),
        );
      }
      if ((rest[0] === "decide" || rest[0] === "start-pm") && rest.length === 1) {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const { room, need } = body ?? {};
        if (typeof room !== "string" || room === ELSEWHERE.id || !Object.hasOwn(state.rooms, room)) return Response.json({ error: "No such project." }, { status: 404 });
        const pm = pmOf(room);
        if (rest[0] === "start-pm") {
          if (pm) return Response.json({ error: "This project already has a PM." }, { status: 409 });
          return machine.startPmInIterm(folderOf(room)).then(
            () => Response.json({ ok: true }),
            (err: Error) => Response.json({ error: `Start PM failed: ${err.message}` }, { status: 502 }),
          );
        }
        if (typeof need !== "string" || !need.trim() || need.length > MAX_BRIEF) {
          return Response.json({ error: `Describe the need in 1 to ${MAX_BRIEF} characters.` }, { status: 400 });
        }
        if (!pm) return Response.json({ error: "This project has no PM." }, { status: 409 });
        return tellEmployee(pm, PM_DECIDES + need.trim());
      }
      if (path === "ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      const file = resolve(clientDir, path || "index.html");
      if (!file.startsWith(clientDir + sep) || !(await Bun.file(file).exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file));
    },
    websocket: {
      open(ws) {
        ws.subscribe("office");
        ws.send(snapshot());
      },
      message() {},
    },
  });

  const timeouts = { offlineAfter: offlineAfterMs, removeAfter: removeAfterMs };
  const lastActive = (e: Employee) => Math.max(e.lastEventAt, transcriptMtime(e.transcript));
  let sweeping = false;
  async function sweepOnce() {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = clock();
      // ponytail: asks `claude agents --json` on every tick while anyone is quiet; cache it if that gets heavy.
      const quiet = Object.values(state.employees).some((e) => now - lastActive(e) >= offlineAfterMs);
      const listed = quiet ? await listSessions() : new Map();
      if (!listed) return;
      const next = sweep(state, clock(), timeouts, lastActive, new Set(listed.keys()));
      if (next !== state) {
        // Replay must see the same departures, or a dead session keeps its name and the next arrival is renamed.
        const swept = Object.values(state.employees).filter((e) => !next.employees[e.sessionId]);
        for (const e of swept) {
          const gone = departure(e);
          append.run(gone.at, JSON.stringify(gone));
        }
        // A release pushes by itself: after the state changes, so the one snapshot shows neither the employee nor its hand; push here only if nothing was held.
        const held = approvals.list().length;
        state = next;
        swept.forEach((e) => approvals.release(e.sessionId));
        if (approvals.list().length === held) push();
      }
    } finally {
      sweeping = false;
    }
  }
  // Every few seconds: sessions whose process has ended leave, whether or not their SessionEnd came (a closed terminal, `claude stop`, a crash).
  // A session claude agents never listed has no pid and keeps the quiet path of sweep().
  let checking = false;
  async function checkProcesses() {
    if (checking) return;
    checking = true;
    try {
      // One `claude agents --json` per tick (about 0.25 s of CPU, measured under load), as the listing's status decides working vs idle; `checking` stops ticks from piling up behind a slow one.
      if (Object.keys(state.employees).length) await listSessions();
      const ended = Object.values(state.employees).filter(processEnded);
      ended.forEach(endSession);
      if (ended.length) push();
    } finally {
      checking = false;
    }
  }
  // ponytail: polls and rereads each room's board every tick; swap in fs.watch if many rooms make that heavy.
  let reading = false;
  async function readBoards() {
    if (reading) return;
    reading = true;
    try {
      if (dropStaleDoors()) push();
      const nextEditions: Record<string, Edition> = {};
      const projects = Object.keys(state.rooms).filter((id) => id !== ELSEWHERE.id); // Elsewhere has no edition and no board
      for (const id of projectsDir ? projects : []) {
        const edition = readEdition(projectFile(projectsDir!, id));
        if (edition) nextEditions[id] = edition;
      }
      if (JSON.stringify(nextEditions) !== JSON.stringify(editions)) {
        editions = nextEditions;
        push();
      }
      if (!boardsDir) return;
      const next: Record<string, BoardRow[]> = {};
      const nextTeams: Record<string, Record<string, BoardRow[]>> = {};
      const nextAsking = new Set<string>();
      for (const id of projects) {
        const rows = await readBoard(boardFile(boardsDir, id));
        if (rows.length) next[id] = rows;
        // Only the boards of teams someone in the room works in.
        const teams = new Set(Object.values(state.employees).filter((e) => e.room === id).map(teamOf).filter((t) => t !== null));
        for (const team of teams) {
          const text = await readBoardText(teamBoardFile(boardsDir, id, team)); // read once: the rows and the open question come from the same text
          const teamRows = parseBoard(text);
          if (teamRows.length) (nextTeams[id] ??= {})[team] = teamRows;
          if (openQuestion(text)) nextAsking.add(`${id}\n${team}`);
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(boards) || JSON.stringify(nextTeams) !== JSON.stringify(teamBoards) || [...nextAsking].sort().join() !== [...asking].sort().join()) {
        boards = next;
        teamBoards = nextTeams;
        asking = nextAsking;
        push();
      }
    } finally {
      reading = false;
    }
  }
  // The safety net for hires nobody let go: a done f1rm hire whose branch is merged goes, with its worktree and branch.
  // ponytail: idleness is counted from when this office first saw the session done, so a restart waits another stretch; it also asks `claude agents --json --all` every tick.
  const doneSince = new Map<string, number>();
  let letting = false;
  async function letGoDone() {
    if (letting) return;
    letting = true;
    try {
      const now = clock();
      const all = (await machine.sessions()) ?? [];
      const seen = new Set<string>();
      for (const s of all) {
        const hire = s.kind === "background" && s.state === "done" ? hireTask(s.name) : null;
        if (!hire) continue;
        seen.add(s.id);
        const since = doneSince.get(s.id) ?? now;
        doneSince.set(s.id, since);
        const repo = repoOf(s.cwd);
        if (now - since < letGoAfterMs || !machine.mergedBranch(repo, `worktree-${hire.task}`)) continue;
        doneSince.set(s.id, now); // a session that can't be let go (uncommitted work) is tried again a stretch later, not every tick
        await letGoHire(machine, s, repo).catch(() => {});
      }
      for (const id of doneSince.keys()) if (!seen.has(id)) doneSince.delete(id);
    } catch {} // `claude agents` failing, or a machine without it: try again next tick
    finally {
      letting = false;
    }
  }
  // Recovery (recovery.ts): the registered projects' hires that stopped are woken or reported, and idle ones that ended a turn without a report are nudged. Their inbox is the one the panel's Tell uses.
  const registered = () => (projectsDir ? Object.keys(state.rooms).filter((id) => id !== ELSEWHERE.id && existsSync(projectFile(projectsDir, id))).map(folderOf) : []);
  const recovering = recovery && createRecovery({
    ...recovery.deps,
    board: async (repo, team) => (boardsDir ? readBoard(team ? teamBoardFile(boardsDir, repo, team) : boardFile(boardsDir, repo)) : []),
    // Every live seat of the name in this project is tried until one takes it (a stale copy keeps a dead socket); a nudge names the hire's own session, since an interactive session may wear its title.
    tell: async (repo, name, message, sessionId) => {
      const seats = Object.values(state.employees).filter((e) => e.title === name && e.status !== "offline" && e.room !== ELSEWHERE.id && folderOf(e.room) === repo && e.socket && (!sessionId || e.sessionId === sessionId));
      for (const seat of seats) if (await machine.tell(seat.socket!, seat.sessionId, message).then(() => true, () => false)) return true;
      return false;
    },
  });
  let recoveringNow = false;
  async function recoverOnce() {
    if (!recovering || recoveringNow) return;
    recoveringNow = true;
    try {
      await recovering.tick(registered());
    } finally {
      recoveringNow = false;
    }
  }
  const ready = Promise.all([sweepOnce(), readBoards()]);
  void letGoDone(); // not awaited: a hanging `claude agents` must not hold the office's start
  const timer = setInterval(sweepOnce, Math.min(15_000, offlineAfterMs / 4));
  const processTimer = setInterval(checkProcesses, Math.min(5_000, offlineAfterMs / 4));
  const letGoTimer = setInterval(letGoDone, Math.min(60_000, letGoAfterMs / 4));
  const boardTimer = setInterval(readBoards, boardPollMs);
  const recoveryTimer = recovery && setInterval(recoverOnce, recovery.everyMs);
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    clearInterval(timer);
    clearInterval(processTimer);
    clearInterval(letGoTimer);
    clearInterval(boardTimer);
    clearInterval(recoveryTimer);
    approvals.releaseAll();
    await stop(closeActiveConnections);
    db.close();
  };
  return server;
}
