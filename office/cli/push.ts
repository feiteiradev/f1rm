// `f1rm push [--check "<cmd>"]`: the PM's push of the base branch to origin at the end of a milestone, and nothing else pushes (see the gate in server.ts).
// It refuses what is not ready, runs the full suite once behind the suite lock the way `f1rm merge` does, then pushes the base branch fast-forward only with one explicit refspec:
// never force, never another branch, never tags, whatever the repo's push config says.
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { git, hasCheckScript, mainDir, Refused, run, runSuite } from "./merge.ts";

type Result = { out: string; err: string; code: number };
export type PushDeps = { home: string; now: () => number; say: (line: string) => void; env: Record<string, string> };

const usage = 'usage: f1rm push [--check "<command>"]';
const NO_OLD = "0".repeat(40);

/** Git against the remote, which must never wait for a password or a host-key question: no terminal prompt, and ssh in batch mode unless the user set their own command. */
const net = (main: string, env: Record<string, string>, args: string[]) => {
  const e = { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  const r = Bun.spawnSync(["git", "-C", main, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: e });
  return { ok: r.success, out: r.stdout.toString().trim(), err: r.stderr.toString().trim().split("\n").pop() || "no message" };
};

/** Runs `f1rm push` in `cwd`: one line per step through `deps.say`, all of them also in `out`; a non-zero `code` pushed nothing. */
export async function pushIn(argv: string[], cwd: string, deps: Partial<PushDeps> = {}): Promise<Result> {
  let check = "bun run check", custom = false;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== "--check" || !argv[i + 1]?.trim()) return { out: "", err: usage + "\n", code: 1 };
    [check, custom] = [argv[i + 1], true];
  }
  const lines: string[] = [];
  const say = (line: string) => (lines.push(line), deps.say?.(line));
  try {
    const warning = await send(check, custom, cwd, { home: deps.home ?? process.env.HOME!, now: deps.now ?? Date.now, env: deps.env ?? {} }, say);
    return { out: lines.join("\n") + "\n", err: warning ? `warning: ${warning}\n` : "", code: 0 };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { out: lines.length ? lines.join("\n") + "\n" : "", err: `f1rm push: ${e.message}\n`, code: 1 };
  }
}

async function send(check: string, custom: boolean, cwd: string, deps: Pick<PushDeps, "home" | "now" | "env">, say: (line: string) => void) {
  const main = mainDir(cwd);
  if (!run(main, ["symbolic-ref", "-q", "HEAD"]).ok) throw new Refused("the main working directory has a detached HEAD: there is no base branch to push");
  const base = git(main, "symbolic-ref", "--short", "HEAD");
  if (!run(main, ["remote", "get-url", "origin"]).ok) throw new Refused("no remote named origin: nothing to push to");
  // The base branch is what origin's HEAD names; a repo that never recorded it has main or master. ponytail: a repo whose base is another name and has no origin/HEAD sets it with `git remote set-head origin -a`.
  const named = run(main, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).out.replace(/^origin\//, "");
  const bases = named ? [named] : ["main", "master"];
  if (!bases.includes(base)) throw new Refused(`${base} is not the base branch (${bases.join(" or ")}): only the base branch is pushed`);
  if (git(main, "status", "--porcelain", "--", ".", ":(exclude).claude/worktrees")) throw new Refused("the main working directory has uncommitted changes: the suite would not be run on what is pushed");
  if (!custom && !hasCheckScript(main)) throw new Refused('the repo has no `check` script in package.json: pass --check "<command>"');

  const ref = `refs/heads/${base}`;
  const ls = net(main, deps.env, ["ls-remote", "origin", ref]);
  if (!ls.ok) throw new Refused(`could not read origin: ${ls.err}`);
  const old = ls.out.split(/\s/)[0];
  const tip = git(main, "rev-parse", "HEAD");
  if (old) {
    const got = net(main, deps.env, ["fetch", "-q", "--no-tags", "origin", ref]);
    if (!got.ok) throw new Refused(`could not fetch ${base} from origin: ${got.err}`);
    const behind = Number(git(main, "rev-list", "--count", `HEAD..${old}`));
    if (behind) throw new Refused(`origin has ${behind} commit${behind === 1 ? "" : "s"} that ${base} lacks: not a fast-forward, nothing pushed. This command never merges, rebases or forces; bring them onto ${base} first`);
  }
  if (old === tip) return say("already up to date");

  const evidence = join(deps.home, ".f1rm", "evidence", basename(main));
  mkdirSync(evidence, { recursive: true });
  const log = join(evidence, "push-check.log");
  const failed = await runSuite(main, check, log, deps.env);
  if (failed) throw new Refused(`check failed (exit ${failed.code}), nothing pushed; the log is ${log}, its last lines:\n${failed.tail}`);
  if (git(main, "rev-parse", "HEAD") !== tip) throw new Refused(`${base} moved while the suite ran: nothing pushed, run f1rm push again`);

  // One explicit refspec overrides remote.origin.push and push.default, so a `+` refspec from config cannot force; no tags follow.
  const sent = net(main, deps.env, ["push", "--no-follow-tags", "origin", `${ref}:${ref}`]);
  if (!sent.ok) throw new Refused(`push failed: ${sent.err}`);
  // The push is done: a log that cannot be written is a warning, never a failed run (a retry would find nothing to push).
  let warning: string | undefined;
  try {
    const kept = join(deps.home, ".f1rm", "kept", basename(main));
    mkdirSync(kept, { recursive: true });
    appendFileSync(join(kept, "pushes.log"), `${new Date(deps.now()).toISOString()} | ${basename(main)} | ${base} | ${old || NO_OLD}..${tip}\n`);
  } catch (e) {
    warning = `could not write pushes.log: ${(e as Error).message}`;
  }
  say(`pushed ${base} ${(old || NO_OLD).slice(0, 7)}..${tip.slice(0, 7)} to origin`);
  return warning;
}
