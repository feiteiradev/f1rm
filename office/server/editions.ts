// A project's edition: Work, the engineering company, or Founder, which adds the go-to-market roles. It lives outside the
// repo, so an employer's repo never gets an f1rm file. Shared by the CLI and the office server.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";

export const EDITIONS = ["work", "founder"] as const;
export type Edition = (typeof EDITIONS)[number];
export const isEdition = (v: unknown): v is Edition => EDITIONS.includes(v as Edition);

/** `~/.f1rm/projects/<repo>.json`, the repo encoded as the boards are. */
export const projectFile = (projectsDir: string, roomId: string) => join(projectsDir, repoKey(roomId) + ".json");

/** The chosen edition, or null when none is: no file, or a value f1rm doesn't know. Null counts as Work. */
export function readEdition(file: string): Edition | null {
  try {
    const edition = JSON.parse(readFileSync(file, "utf8"))?.edition;
    return isEdition(edition) ? edition : null;
  } catch {
    return null;
  }
}

export function writeEdition(file: string, edition: Edition) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ edition }) + "\n");
}
