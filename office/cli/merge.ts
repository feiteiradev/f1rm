// `f1rm merge <task> [--check "<cmd>"] [--no-red "<reason>"]`: lands a reviewed branch on main, and nothing else lands there (see the gate in server.ts).
// The steps are the Reviewer's mechanical part, as a command: refuse what is not ready, merge in a scratch worktree, prove the new tests fail on the base,
// run the full check once on the merge behind the suite lock, then fast-forward main to that merge. It never pushes and never touches a remote or another ref.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { machine } from "../server/machine.ts";
import { writePrivate } from "../server/private.ts";
import { SLUG } from "./hire.ts";
import { readReport, reportFile } from "./report.ts";

type Result = { out: string; err: string; code: number };
export type MergeDeps = { home: string; now: () => number; say: (line: string) => void; env: Record<string, string> };

const usage = 'usage: f1rm merge <task> [--check "<command>"] [--no-red "<reason>"]';
// A merged settings file would widen every later session's permissions (decision 4).
// Case-insensitive (macOS folds case), and a bare `hooks`/`commands` entry (a symlink) counts as well as the files under them.
const SETTINGS_FILE = /^(\.claude\/(settings(\.local)?\.json$|(hooks|commands|agents|skills)(\/|$))|\.mcp\.json$)/i;
// A suite command that pushes or merges: the gate refuses such a `--check`, and a remembered command is read here, where the gate never sees it.
const LANDS = /\bgit\b[^;&|\n]*\bpush\b|\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\b(merges?|refs?)\b|\bf1rm\s+(push|merge)\b/i;
const CHECK_FAILED_WAY_OUT = "the dev fixes it and sends a new DONE; if the dev cannot, the lead hires a fresh implementer on a branch from the current main";
const NO_RED_WAY_OUT = 'a branch that cannot fail on the base (test-only, renamed or deleted tests, a refactor with no new behaviour) lands with `--no-red "<reason>"`: the PM\'s or lead\'s call, logged in calls.md';
const LOCK_SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-lock.ts");
const TAIL_LINES = 15;
// A changed file is a test when it is named or placed like one. ponytail: bun's `*.test.ts` and the usual folders; a repo with another convention passes `--check` only for the suite, not for this.
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*$|_test\.\w+$/;
/** Documentation needs no red check: a Markdown file, or anything under growth/ or docs/. */
const DOC_FILE = /\.md$/i;
const isDoc = (file: string) => DOC_FILE.test(file) || file.startsWith("growth/") || file.startsWith("docs/");

/** A refusal: its message is the whole output, and nothing has changed on main. */
export class Refused extends Error {}

type Run = { ok: boolean; out: string; err: string };
export const run = (cwd: string, args: string[]): Run => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.success, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
export const git = (cwd: string, ...args: string[]) => {
  const r = run(cwd, args);
  if (!r.ok) throw new Refused(`git ${args[0]} failed in ${cwd}: ${r.err.split("\n").pop() || "no message"}`);
  return r.out;
};
export const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A scratch worktree at `commit`, with the repo's node_modules linked in; `remove()` unlinks that and removes the worktree (forced only when asked, for the red throwaway). */
function scratch(main: string, name: string, commit: string, force: boolean) {
  const path = join(main, ".claude", "worktrees", name);
  if (existsSync(path)) throw new Refused(`${path} exists: another merge of this task is running, or one died. It holds no work: remove it with \`git worktree remove --force\` and run again.`);
  git(main, "worktree", "add", "-q", "--detach", path, commit);
  if (existsSync(join(main, "node_modules"))) symlinkSync(join(main, "node_modules"), join(path, "node_modules"));
  return {
    path,
    remove: () => {
      rmSync(join(path, "node_modules"), { force: true }); // the link only: rmSync does not follow it
      const r = run(main, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
      return r.ok ? "" : r.err.split("\n").pop() || "git worktree remove failed";
    },
  };
}

/** The repo's main working directory, when `cwd` is it: a refusal in a worktree or beside the repo. */
export function mainDir(cwd: string) {
  const common = machine.gitCommonDir(cwd);
  if (!common) throw new Refused("not in a git repo");
  const main = dirname(real(common));
  const toplevel = run(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (real(toplevel) !== main) throw new Refused(`run it in the main working directory (${main}), not in a worktree or beside the repo`);
  return main;
}

/** Runs `f1rm merge` in `cwd`: one line per step through `deps.say`, all of them also in `out`; a non-zero `code` leaves main as it was. */
export async function mergeIn(argv: string[], cwd: string, deps: Partial<MergeDeps> = {}): Promise<Result> {
  const lines: string[] = [];
  const say = (line: string) => (lines.push(line), deps.say?.(line));
  const [task, ...flags] = argv;
  let check: string | undefined, noRed: string | undefined;
  for (let i = 0; i < flags.length; i += 2) {
    if (!["--check", "--no-red"].includes(flags[i]) || !flags[i + 1]?.trim()) return { out: "", err: usage + "\n", code: 1 };
    if (/[\r\n]/.test(flags[i + 1])) return { out: "", err: `f1rm merge: the ${flags[i]} value is one line\n`, code: 1 };
    if (flags[i] === "--check") check = flags[i + 1];
    else noRed = flags[i + 1];
  }
  if (!SLUG.test(task ?? "")) return { out: "", err: usage + "\n", code: 1 };
  try {
    await land(task, check, noRed, cwd, { home: deps.home ?? process.env.HOME!, now: deps.now ?? Date.now, env: deps.env ?? {} }, say);
    return { out: lines.join("\n") + "\n", err: "", code: 0 };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const way = e.message.startsWith("check failed") ? `\n${CHECK_FAILED_WAY_OUT}` : "";
    return { out: lines.length ? lines.join("\n") + "\n" : "", err: `f1rm merge: ${e.message}${way}\n`, code: 1 };
  }
}

async function land(task: string, flagCheck: string | undefined, noRed: string | undefined, cwd: string, deps: Pick<MergeDeps, "home" | "now" | "env">, say: (line: string) => void) {
  // A spec's integration branch (`spec-<n>`, built by the office's implement step) lands as it is: its tickets were reviewed on it, and no DONE report names its tip.
  const spec = /^spec-\d+$/.test(task);
  const branch = spec ? task : `worktree-${task}`;
  const main = mainDir(cwd);
  if (!run(main, ["symbolic-ref", "-q", "HEAD"]).ok) throw new Refused("the main working directory has a detached HEAD: there is no base branch to land on");
  const baseBranch = git(main, "symbolic-ref", "--short", "HEAD");

  const reportPath = reportFile(deps.home, basename(main), task);
  const report = spec ? null : readReport(reportPath);
  if (!spec && (report?.kind !== "DONE" || !report.commit)) throw new Refused(`no DONE report with a commit for ${task} in ${reportPath}: f1rm merge lands a spec's integration branch, \`f1rm merge spec-<n>\`; a task branch needs a DONE report, which nothing writes since the steps replaced the hires`);
  if (!run(main, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]).ok) throw new Refused(`no branch ${branch}`);
  const tip = git(main, "rev-parse", `refs/heads/${branch}`);
  if (report && !tip.startsWith(report.commit!.toLowerCase())) throw new Refused(`tip moved: send the work back to the dev (${branch} is at ${tip.slice(0, 9)}, its DONE says ${report.commit!.slice(0, 9)})`);
  say(report ? `tip ${tip.slice(0, 9)} is the DONE commit` : `tip ${tip.slice(0, 9)} of the integration branch ${branch}`);
  if (run(main, ["merge-base", "--is-ancestor", tip, "HEAD"]).ok) throw new Refused(`${branch} is already on ${baseBranch}`);
  const check = suiteCommand(main, deps.home, flagCheck);
  const custom = flagCheck !== undefined;

  const base0 = git(main, "rev-parse", "HEAD");
  // The default check is the merged package.json's own script, which no one reads the diff of any more: a branch that changes it, or the lock script, lands only with an explicit --check. Against the merge-base, so a branch forked
  // before main changed them is not refused for it. ponytail: `typecheck`, `build`, tsconfig and bunfig can still weaken the suite; compare every script `suite` calls if that is felt.
  const suiteOf = (rev: string) => {
    try {
      const { check, suite } = JSON.parse(run(main, ["show", `${rev}:package.json`]).out).scripts ?? {};
      return JSON.stringify([check, suite]);
    } catch {
      return "";
    }
  };
  const changed = names(main, "diff", "--name-only", "--no-renames", `${base0}...${tip}`);
  const settings = changed.filter((f) => SETTINGS_FILE.test(f));
  if (settings.length) throw new Refused(`a merged settings file widens every later session's permissions; only the user changes Claude Code permissions (the office's project-commands card); touched: ${settings.join(", ")}`);
  // A dirty file the merge does not change is left alone: the fast-forward keeps it, and git itself refuses a fast-forward that would overwrite one. 
  const dirty = [...names(main, "diff", "--name-only", "--no-renames", "HEAD", "--", ".", ":(exclude).claude/worktrees"), ...names(main, "ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).claude/worktrees")];
  // A file where the merge adds a folder, or a folder's file where it adds a file, overlaps as well.
  const overlap = dirty.filter((f) => changed.some((c) => c === f || c.startsWith(f + "/") || f.startsWith(c + "/")));
  if (overlap.length) throw new Refused(`the main working directory has uncommitted changes in files this merge changes: ${overlap.join(", ")}. The merge is retried after they are committed or removed (they are never stashed or discarded here)`);
  const calls: [string, string][] = [];
  const suiteChanged = changed.includes("scripts/check-lock.ts") || suiteOf(git(main, "merge-base", base0, tip)) !== suiteOf(tip);
  if (!custom && suiteChanged) throw new Refused('the branch changes how the suite runs (scripts.check, scripts.suite or scripts/check-lock.ts) and nobody else reads that diff: read the branch\'s diff of scripts.check, scripts.suite and scripts/check-lock.ts yourself; if it is sound, land with `--check "bun run check"` (or the project\'s command), a call the close step names in its closing comment');
  if (custom && suiteChanged) calls.push(["merge --check on a suite change", check]);
  const tests = names(main, "diff", "--name-only", "--no-renames", "--diff-filter=ACMR", `${base0}...${tip}`).filter((f) => TEST_FILE.test(f));
  let red: string[] = [];
  if (changed.every(isDoc)) say("red: skipped, every changed file is documentation");
  else if (noRed) {
    say(`red: skipped, --no-red: ${noRed}`);
    calls.push(["merge --no-red", noRed]);
  } else if (!tests.length) throw new Refused(`the branch changes code and no test file: the dev adds the tests that fail without the change; ${NO_RED_WAY_OUT}`);
  else red = await redOnBase(main, task, tip, base0, tests, say);

  const evidence = dirname(reportPath);
  mkdirSync(evidence, { recursive: true });
  // The base can move while the check runs: the merge is redone from the new tip once, then it stops.
  for (let attempt = 1; ; attempt++) {
    const base = git(main, "rev-parse", "HEAD");
    const sha = await mergeAndCheck(main, task, branch, tip, base, check, join(evidence, "merge-check.log"), deps.env, say);
    const now = run(main, ["symbolic-ref", "-q", "--short", "HEAD"]).out;
    if (now !== baseBranch) throw new Refused(`the main working directory is on ${now || "no branch"} now, not ${baseBranch}: nothing landed, switch it back and run \`f1rm merge ${task}\` again`);
    const ff = run(main, ["merge", "--ff-only", sha]);
    if (ff.ok) {
      say(`${baseBranch} fast-forwarded to ${sha.slice(0, 9)}`);
      writePrivate(join(evidence, "merge.json.tmp"), JSON.stringify({ merge: sha, base, tip, red, check: 0, at: new Date(deps.now()).toISOString() }, null, 2) + "\n");
      renameSync(join(evidence, "merge.json.tmp"), join(evidence, "merge.json"));
      keep(deps, main, task, flagCheck, calls, say);
      say(`merged ${sha}`);
      return;
    }
    if (git(main, "rev-parse", "HEAD") === base) throw new Refused(`could not fast-forward ${baseBranch}: ${ff.err.split("\n").pop()}`);
    if (attempt === 2) throw new Refused(`${baseBranch} moved again while the merge was checked: nothing landed, run \`f1rm merge ${task}\` again`);
    say(`${baseBranch} moved to ${git(main, "rev-parse", "--short", "HEAD")} while the merge was checked: merging again`);
  }
}

/** The paths a command lists with `-z`: whole, never quoted, and not trimmed (a path may start with a space). */
function names(cwd: string, cmd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, cmd, "-z", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Refused(`git ${cmd} failed in ${cwd}: ${r.stderr.toString().trim().split("\n").pop() || "no message"}`);
  return r.stdout.toString().split("\0").filter(Boolean);
}

/** The suite command a landing runs: `--check` wins, else the repo's own `check` script, else the command an earlier `--check` that landed left for this repo. */
export function suiteCommand(main: string, home: string, flag?: string) {
  if (flag) return flag;
  if (hasCheckScript(main)) return "bun run check";
  try {
    const remembered = readFileSync(join(kept(home, main), "check-command"), "utf8").trim();
    if (remembered && LANDS.test(remembered)) throw new Refused("the remembered check command may not push or merge; pass --check again");
    if (remembered) return remembered;
  } catch (e) {
    if (e instanceof Refused) throw e;
  }
  throw new Refused('the repo has no `check` script in package.json: pass --check "<the project\'s full suite command>" once; it is remembered for later merges');
}

const kept = (home: string, main: string) => join(home, ".f1rm", "kept", basename(main));
/** After a landing: the `--check` that landed is remembered, and each call the merge made on the lander's word is said, for the close step's closing comment. The branch has landed by now: a write that fails is a warning, never a failed run. ponytail: check-command holds the last one, not a history. */
function keep(deps: { home: string; now: () => number }, main: string, task: string, flagCheck: string | undefined, calls: [string, string][], say: (line: string) => void) {
  const dir = kept(deps.home, main);
  const write = (file: string, text: string, append = false) => {
    try {
      mkdirSync(dir, { recursive: true });
      (append ? appendFileSync : writeFileSync)(join(dir, file), text);
    } catch (e) {
      say(`warning: could not write ${join(dir, file)}: ${(e as Error).message}`);
    }
  };
  if (flagCheck) write("check-command", flagCheck.trim() + "\n");
  for (const [call, detail] of calls) say(`call: ${call}: ${detail.trim()}`);
}

export const hasCheckScript = (main: string) => {
  try {
    return typeof JSON.parse(readFileSync(join(main, "package.json"), "utf8"))?.scripts?.check === "string";
  } catch {
    return false;
  }
};

/** Runs each new test file alone in a throwaway worktree at the base: all must fail there, and the files that pass are named. Returns the files. */
async function redOnBase(main: string, task: string, tip: string, base: string, tests: string[], say: (line: string) => void) {
  const wt = scratch(main, `red-${task}`, base, true);
  try {
    git(wt.path, "checkout", tip, "--", ...tests);
    const passed: string[] = [], unproven: string[] = [];
    for (const file of tests) {
      const p = Bun.spawn(["bun", "test", `./${file}`], { cwd: wt.path, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code === 0) passed.push(file);
      else if (!/^\s*[1-9]\d* fail\b/m.test(out + err)) unproven.push(file); // bun's summary: a failing test and a file that cannot load both say `1 fail`; a fixture says no test matched
    }
    if (passed.length) throw new Refused(`these new tests pass on the base, so they prove nothing: ${passed.join(", ")}; ${NO_RED_WAY_OUT}`);
    if (unproven.length) throw new Refused(`these new test files do not fail on the base (no test in them, or not a test file), so they prove nothing: ${unproven.join(", ")}; ${NO_RED_WAY_OUT}`);
    say(`red: ${tests.join(", ")} fail on the base`);
    return tests;
  } finally {
    wt.remove();
  }
}

/** The branch merged `--no-ff` onto `base` in a scratch worktree, and the full check run once there behind the suite lock. Returns the merge commit; the worktree is gone either way. */
async function mergeAndCheck(main: string, task: string, branch: string, tip: string, base: string, check: string, log: string, env: Record<string, string>, say: (line: string) => void) {
  const wt = scratch(main, `merge-${task}`, base, false);
  try {
    const m = run(wt.path, ["merge", "--no-ff", "-m", `Merge branch '${branch}'`, tip]);
    if (!m.ok) {
      if (run(wt.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
        run(wt.path, ["merge", "--abort"]);
        throw new Refused("conflict: the dev rebases onto main and sends a new DONE; if the implementer cannot resolve it, the lead hires a fresh implementer on a branch from the current main, with this tip's diff as its Inputs");
      }
      throw new Refused(`git merge failed: ${m.err.split("\n").pop()}`);
    }
    const sha = git(wt.path, "rev-parse", "HEAD");
    say(`merged ${branch} onto ${base.slice(0, 9)} in a scratch worktree: ${sha.slice(0, 9)}`);
    const failed = await runSuite(wt.path, check, log, env);
    if (failed) throw new Refused(`check failed (exit ${failed.code}), nothing landed; the log is ${log}, its last lines:\n${failed.tail}`);
    say(`check: ${check} passed on the merge (log ${log})`);
    return sha;
  } finally {
    // git refuses to remove a worktree the check left untracked files in; that never fails a merge, but it is said.
    const left = wt.remove();
    if (left) say(`warning: the scratch worktree ${wt.path} stays: ${left}`);
  }
}

/** Runs `check` in `cwd` behind the suite lock, its output in `log`: null when it passes, else its exit code and the last lines of the log. */
export async function runSuite(cwd: string, check: string, log: string, env: Record<string, string>) {
  // The suite lock is held around the whole command; the repo's own `check` script is the lock script again, finds F1RM_CHECK_LOCKED in its env and does not wait for itself.
  // F1RM_CHECK_LOCKED is cleared here: a run from inside a locked check (a test of it) must still take the lock.
  const fd = openSync(log, "w");
  let code: number;
  try {
    const p = Bun.spawn(["bun", LOCK_SCRIPT, "sh", "-c", check], { cwd, env: { ...process.env, ...env, F1RM_CHECK_LOCKED: "" }, stdin: "ignore", stdout: fd, stderr: fd });
    code = await p.exited;
  } finally {
    closeSync(fd);
  }
  if (code === 0) return null;
  return { code, tail: readFileSync(log, "utf8").trimEnd().split("\n").slice(-TAIL_LINES).join("\n") };
}
