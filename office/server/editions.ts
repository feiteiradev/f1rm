// A project's edition: Work, the engineering company, or Founder, which adds the go-to-market roles. It lives outside the
// repo, so an employer's repo never gets an f1rm file. Shared by the CLI and the office server.
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";
import { machine } from "./machine.ts";

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

/** `~/.f1rm/projects`, where the CLI and the office keep each project's edition. */
export const projectsDir = () => join(process.env.HOME!, ".f1rm", "projects");
/** The edition file for the repo at `cwd`: its room id, the git common dir or the folder itself. */
export const editionFile = (cwd: string, m: Pick<typeof machine, "gitCommonDir"> = machine) => projectFile(projectsDir(), m.gitCommonDir(cwd) ?? cwd);

export function writeEdition(file: string, edition: Edition) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ edition }) + "\n");
}

/** Changes the edition of a registration that exists: throws ENOENT when the file is gone, so it can't recreate a registration removed in between. */
export function changeEdition(file: string, edition: Edition) {
  const text = JSON.stringify({ edition }) + "\n";
  // ponytail: rewritten in place, so a reader that comes between the write and the truncate can see the old tail or an empty file; a temp file
  // plus rename would fix that but could recreate a removed registration, so bring a lock in if it is felt.
  writeFileSync(file, text, { flag: "r+" });
  truncateSync(file, Buffer.byteLength(text));
}
