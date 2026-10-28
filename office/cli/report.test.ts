// Seam: `f1rm report`, run in a real temp git repo (and one of its worktrees) with an injected HOME and clock; the file it writes is what `f1rm status --watch` reads.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportFile, reportIn, reportSlug } from "./report.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
};

/** A repo named `shop` with one commit, and a worktree `.claude/worktrees/task-a` in it. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "f1rm-report-"));
  const repo = join(root, "shop");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  const wt = join(repo, ".claude", "worktrees", "task-a");
  git(repo, "worktree", "add", "-q", wt, "-b", "worktree-task-a");
  const home = join(root, "home");
  mkdirSync(home);
  return { repo, wt, home, file: reportFile(home, "shop", "task-a") };
}
const NOW = Date.parse("2026-10-23T12:00:00Z");
const deps = (home: string, now = NOW) => ({ home, now: () => now });
const saved = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("a report from a worktree is written to the evidence folder of the repo, with kind, slug, commit, note, time and seq 1", async () => {
  const { wt, home, file } = setup();
  const r = await reportIn(["DONE", "task-a", "--commit", "abc1234", "--note", "all green"], wt, deps(home));
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toHaveLength(1);
  expect(r.out).toContain("DONE task-a");
  expect(saved(file)).toEqual({ kind: "DONE", slug: "task-a", commit: "abc1234", note: "all green", at: "2026-10-23T12:00:00.000Z", seq: 1 });
});

test("every write raises seq by one, and the file is private and leaves no temp file", async () => {
  const { repo, home, file } = setup();
  await reportIn(["DONE", "task-a", "--commit", "abc1234"], repo, deps(home));
  await reportIn(["BLOCKED", "task-a"], repo, deps(home, NOW + 1000));
  const third = await reportIn(["CHANGES", "task-a", "--note", "needs work"], repo, deps(home, NOW + 2000));
  expect(third.code).toBe(0);
  expect(saved(file)).toMatchObject({ kind: "CHANGES", seq: 3, commit: null, note: "needs work" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(file, ".."))).toEqual(["report.json"]);
});

test("an unknown kind, a bad slug or commit, or a missing slug is refused and writes nothing", async () => {
  const { repo, home, file } = setup();
  for (const argv of [["FINISHED", "task-a"], ["DONE"], ["DONE", "../escape"], ["DONE", "Task A"], ["DONE", "task-a", "--commit", "not-a-sha"], ["DONE", "task-a", "--bogus"], ["DONE", "task-a", "--commit"]]) {
    const r = await reportIn(argv, repo, deps(home));
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage");
  }
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(home, ".f1rm", "evidence", "escape"))).toBe(false);
});

test("NEEDS (the NEEDS YOU report) is a kind of its own: written with its seq, and named in the usage", async () => {
  const { repo, home, file } = setup();
  const r = await reportIn(["NEEDS", "task-a", "--note", "second review still blocks"], repo, deps(home));
  expect(r.code).toBe(0);
  expect(saved(file)).toMatchObject({ kind: "NEEDS", slug: "task-a", seq: 1, note: "second review still blocks" });
  expect((await reportIn(["NOPE", "task-a"], repo, deps(home))).err).toContain("DONE|APPROVED|CHANGES|BLOCKED|ESCALATE|NEEDS");
});

test("outside a git repo it refuses", async () => {
  const { home } = setup();
  const r = await reportIn(["DONE", "task-a"], mkdtempSync(join(tmpdir(), "f1rm-nogit-")), deps(home));
  expect(r).toMatchObject({ code: 1 });
  expect(r.err).toContain("not in a git repo");
});

test("a note is cut to one line", async () => {
  const { repo, home, file } = setup();
  await reportIn(["DONE", "task-a", "--note", "first\nsecond"], repo, deps(home));
  expect(saved(file).note).toBe("first second");
});

test("an unreadable old file starts again at seq 1", async () => {
  const { repo, home, file } = setup();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{not json");
  await reportIn(["DONE", "task-a"], repo, deps(home));
  expect(saved(file).seq).toBe(1);
});

test("a hire's name gives the slug its report goes under: the task, review-<task> for a Reviewer", () => {
  expect(reportSlug("backend-dev-report-files")).toBe("report-files");
  expect(reportSlug("shop.frontend-dev-checkout")).toBe("checkout");
  expect(reportSlug("reviewer-review-checkout")).toBe("review-checkout");
  expect(reportSlug("lead-rules")).toBe("lead-rules");
  expect(reportSlug("pm")).toBeNull();
});
