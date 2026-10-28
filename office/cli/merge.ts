// `f1rm merge <task> [--check "<cmd>"]`: lands a reviewed branch on main, and nothing else lands there (see the gate in server.ts).
// The steps are the Reviewer's mechanical part, as a command: refuse what is not ready, merge in a scratch worktree, prove the new tests fail on the base,
// run the full check once on the merge behind the suite lock, then fast-forward main to that merge. It never pushes and never touches a remote or another ref.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { machine } from "../server/machine.ts";
import { writePrivate } from "../server/private.ts";
import { SLUG } from "./hire.ts";
import { readReport, reportFile } from "./report.ts";

type Result = { out: string; err: string; code: number };
export type MergeDeps = { home: string; now: () => number; say: (line: string) => void; env: Record<string, string> };

const usage = 'usage: f1rm merge <task> [--check "<command>"]';
const LOCK_SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-lock.ts");
const TAIL_LINES = 15;
// A changed file is a test when it is named or placed like one. ponytail: bun's `*.test.ts` and the usual folders; a repo with another convention passes `--check` only for the suite, not for this.
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*$|_test\.\w+$/;
/** Documentation needs no red check: a Markdown file, or anything under growth/ or docs/. */
const DOC_FILE = /\.md$/i;
const isDoc = (file: string) => DOC_FILE.test(file) || file.startsWith("growth/") || file.startsWith("docs/");

/** A refusal: its message is the whole output, and nothing has changed on main. */
class Refused extends Error {}

type Run = { ok: boolean; out: string; err: string };
const run = (cwd: string, args: string[]): Run => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.success, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const git = (cwd: string, ...args: string[]) => {
  const r = run(cwd, args);
  if (!r.ok) throw new Refused(`git ${args[0]} failed in ${cwd}: ${r.err.split("\n").pop() || "no message"}`);
  return r.out;
};
const real = (path: string) => {
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

/** Runs `f1rm merge` in `cwd`: one line per step through `deps.say`, all of them also in `out`; a non-zero `code` leaves main as it was. */
export async function mergeIn(argv: string[], cwd: string, deps: Partial<MergeDeps> = {}): Promise<Result> {
  const lines: string[] = [];
  const say = (line: string) => (lines.push(line), deps.say?.(line));
  const [task, ...flags] = argv;
  let check = "bun run check", custom = false;
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] !== "--check" || !flags[i + 1]?.trim()) return { out: "", err: usage + "\n", code: 1 };
    [check, custom] = [flags[i + 1], true];
  }
  if (!SLUG.test(task ?? "")) return { out: "", err: usage + "\n", code: 1 };
  try {
    await land(task, check, custom, cwd, { home: deps.home ?? process.env.HOME!, now: deps.now ?? Date.now, env: deps.env ?? {} }, say);
    return { out: lines.join("\n") + "\n", err: "", code: 0 };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { out: lines.length ? lines.join("\n") + "\n" : "", err: `f1rm merge: ${e.message}\n`, code: 1 };
  }
}

async function land(task: string, check: string, custom: boolean, cwd: string, deps: Pick<MergeDeps, "home" | "now" | "env">, say: (line: string) => void) {
  const branch = `worktree-${task}`;
  const common = machine.gitCommonDir(cwd);
  if (!common) throw new Refused("not in a git repo");
  const main = dirname(real(common));
  const toplevel = run(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (real(toplevel) !== main) throw new Refused(`run it in the main working directory (${main}), not in a worktree or beside the repo`);
  if (!run(main, ["symbolic-ref", "-q", "HEAD"]).ok) throw new Refused("the main working directory has a detached HEAD: there is no base branch to land on");
  const baseBranch = git(main, "symbolic-ref", "--short", "HEAD");
  if (git(main, "status", "--porcelain", "--", ".", ":(exclude).claude/worktrees")) throw new Refused("the main working directory has uncommitted changes: it is the user's to commit or discard, never stashed or discarded here");

  const reportPath = reportFile(deps.home, basename(main), task);
  const report = readReport(reportPath);
  if (report?.kind !== "DONE" || !report.commit) throw new Refused(`no DONE report with a commit for ${task} in ${reportPath}: the dev sends \`f1rm report DONE ${task} --commit <sha>\` first`);
  if (!run(main, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]).ok) throw new Refused(`no branch ${branch}`);
  const tip = git(main, "rev-parse", `refs/heads/${branch}`);
  if (!tip.startsWith(report.commit.toLowerCase())) throw new Refused(`tip moved: send the work back to the dev (${branch} is at ${tip.slice(0, 9)}, its DONE says ${report.commit.slice(0, 9)})`);
  say(`tip ${tip.slice(0, 9)} is the DONE commit`);
  if (run(main, ["merge-base", "--is-ancestor", tip, "HEAD"]).ok) throw new Refused(`${branch} is already on ${baseBranch}`);
  if (!custom && !hasCheckScript(main)) throw new Refused('the repo has no `check` script in package.json: pass --check "<command>"');

  const base0 = git(main, "rev-parse", "HEAD");
  // The default check is the merged package.json's own script, which no one reads the diff of any more: a branch that changes it, or the lock script, lands by hand.
  const suiteOf = (rev: string) => {
    try {
      const { check, suite } = JSON.parse(run(main, ["show", `${rev}:package.json`]).out).scripts ?? {};
      return JSON.stringify([check, suite]);
    } catch {
      return "";
    }
  };
  const changed = git(main, "diff", "--name-only", `${base0}...${tip}`).split("\n").filter(Boolean);
  if (!custom && (changed.includes("scripts/check-lock.ts") || suiteOf(base0) !== suiteOf(tip))) throw new Refused("the branch changes how the suite runs (scripts.check, scripts.suite or scripts/check-lock.ts): land it by hand with the user, or pass --check");
  const tests = git(main, "diff", "--name-only", "--diff-filter=ACMR", `${base0}...${tip}`).split("\n").filter((f) => f && TEST_FILE.test(f));
  let red: string[] = [];
  if (changed.every(isDoc)) say("red: skipped, every changed file is documentation");
  else if (!tests.length) throw new Refused("the branch changes code and no test file: the dev adds the tests that fail without the change");
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
      say(`merged ${sha}`);
      return;
    }
    if (git(main, "rev-parse", "HEAD") === base) throw new Refused(`could not fast-forward ${baseBranch}: ${ff.err.split("\n").pop()}`);
    if (attempt === 2) throw new Refused(`${baseBranch} moved again while the merge was checked: nothing landed, run \`f1rm merge ${task}\` again`);
    say(`${baseBranch} moved to ${git(main, "rev-parse", "--short", "HEAD")} while the merge was checked: merging again`);
  }
}

const hasCheckScript = (main: string) => {
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
      else if (!/^\(fail\)/m.test(out + err)) unproven.push(file);
    }
    if (passed.length) throw new Refused(`these new tests pass on the base, so they prove nothing: ${passed.join(", ")}`);
    if (unproven.length) throw new Refused(`these new test files fail on the base without a failing test (an import error, or no test in them), so they prove nothing: ${unproven.join(", ")}`);
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
        throw new Refused("conflict: the dev rebases onto main and sends a new DONE");
      }
      throw new Refused(`git merge failed: ${m.err.split("\n").pop()}`);
    }
    const sha = git(wt.path, "rev-parse", "HEAD");
    say(`merged ${branch} onto ${base.slice(0, 9)} in a scratch worktree: ${sha.slice(0, 9)}`);
    // The suite lock is held around the whole command; the repo's own `check` script is the lock script again, finds F1RM_CHECK_LOCKED in its env and does not wait for itself.
    // F1RM_CHECK_LOCKED is cleared here: a merge run from inside a locked check (a test of it) must still take the lock.
    const fd = openSync(log, "w");
    let code: number;
    try {
      const p = Bun.spawn(["bun", LOCK_SCRIPT, "sh", "-c", check], { cwd: wt.path, env: { ...process.env, ...env, F1RM_CHECK_LOCKED: "" }, stdin: "ignore", stdout: fd, stderr: fd });
      code = await p.exited;
    } finally {
      closeSync(fd);
    }
    if (code !== 0) {
      const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
      throw new Refused(`check failed (exit ${code}), nothing landed; the log is ${log}, its last lines:\n${tail}`);
    }
    say(`check: ${check} passed on the merge (log ${log})`);
    return sha;
  } finally {
    // git refuses to remove a worktree the check left untracked files in; that never fails a merge, but it is said.
    const left = wt.remove();
    if (left) say(`warning: the scratch worktree ${wt.path} stays: ${left}`);
  }
}
