// Which folders get a door in the lobby. A door means a project: a git repo's main working directory, or a folder that has a
// settings file under ~/.f1rm/projects. Everything else a session runs in shows behind the one Elsewhere door.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `p` with its symlinks resolved as far as it exists (/tmp is /private/tmp on macOS), so a path that is gone still compares right. */
export function realPath(p: string): string {
  for (let q = p, rest = ""; ; ) {
    try {
      return join(realpathSync(q), rest);
    } catch {
      const up = dirname(q);
      if (up === q) return p;
      rest = join(basename(q), rest);
      q = up;
    }
  }
}

/** The folders that never get a door, even when they are a git repo or have a settings file: the office's own, Claude's, and temp folders. */
export const junkRoots = (home = process.env.HOME, tmp = process.env.TMPDIR) =>
  [home && join(home, ".f1rm"), home && join(home, ".claude"), "/tmp", "/private/tmp", tmp].filter((p): p is string => !!p).map(realPath);

/** `roots` are already resolved with realPath. */
export function isJunk(folder: string, roots: string[]): boolean {
  const f = realPath(folder);
  return roots.some((r) => f === r || f.startsWith(r + "/"));
}

/** The doors the user removed, room id -> when (ms). Events older than that no longer build the room. */
export function readForgotten(file?: string): Record<string, number> {
  try {
    const parsed = file ? JSON.parse(readFileSync(file, "utf8")) : {};
    // The file is the user's to edit: anything but an object of numbers is dropped, not trusted.
    return Object.fromEntries(Object.entries(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}).filter(([, at]) => Number.isFinite(at)) as [string, number][]);
  } catch {
    return {};
  }
}

export function writeForgotten(file: string, forgotten: Record<string, number>) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(forgotten) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
