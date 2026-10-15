// The machine module: the only code that touches the OS. Seam 1 tests swap it for a fake.

export const machine = {
  /** Absolute git common dir for `cwd` (shared by a repo and all its worktrees), or null outside git. */
  gitCommonDir(cwd: string): string | null {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      stderr: "ignore",
    });
    return r.success ? r.stdout.toString().trim() : null;
  },

  /** Ids of the sessions Claude Code reports as live (`claude agents --json`); empty if it can't say. */
  async liveSessions(): Promise<Set<string>> {
    try {
      const proc = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
      const list = JSON.parse(await new Response(proc.stdout).text());
      // Research-preview output: trust only what is plainly a live session. Finished background runs are not.
      return new Set(
        (Array.isArray(list) ? list : [])
          .filter((a) => typeof a?.sessionId === "string" && !["done", "failed", "stopped"].includes(a.state))
          .map((a) => a.sessionId as string),
      );
    } catch {
      return new Set();
    }
  },
};
