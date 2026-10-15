// The machine module: the only code that touches the OS. Seam 1 tests swap it for a fake.

export const machine = {
  /** Absolute git common dir for `cwd` (shared by a repo and all its worktrees), or null outside git. */
  gitCommonDir(cwd: string): string | null {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      stderr: "ignore",
    });
    return r.success ? r.stdout.toString().trim() : null;
  },

  /** Ids of the sessions Claude Code lists as live (`claude agents --json`); null if it can't say. */
  async liveSessions(): Promise<Set<string> | null> {
    try {
      const proc = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) return null;
      const list = JSON.parse(out);
      if (!Array.isArray(list)) return null;
      return new Set(list.map((a) => a?.sessionId).filter((id): id is string => typeof id === "string"));
    } catch {
      return null;
    }
  },
};
