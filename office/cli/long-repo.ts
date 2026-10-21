// A test helper (not a test): repos whose path has a given length, for the tests of the path limit.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Repos built under a short fixed root (whatever TMPDIR is); a character of the path is a character of the project folder name. `cleanup()` removes every one. */
export function longRepos() {
  const made: string[] = [];
  return {
    /** A folder whose path is exactly `length` characters; a git repo unless `git` is false. */
    repo(length: number, { git = true } = {}): string {
      const parent = realpathSync(mkdtempSync("/tmp/f1rm-long-"));
      made.push(parent);
      const path = join(parent, "r".repeat(length - parent.length - 1));
      mkdirSync(path);
      if (git) Bun.spawnSync(["git", "init", "-q", path]);
      return path;
    },
    /** A subfolder of `path` whose own path is exactly `length` characters. */
    inside(path: string, length: number): string {
      const sub = join(path, "s".repeat(length - path.length - 1));
      mkdirSync(sub, { recursive: true });
      return sub;
    },
    cleanup() {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
