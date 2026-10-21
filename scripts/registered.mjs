// A door in the lobby needs a registration, which `f1rm pm` writes and the office never does. The in-process proofs fake the machine,
// so this makes a temporary projects folder holding one registration for each room id (a repo's git common dir) and the matching `isRepo`.
// Each registration chooses Work: a project with no edition chosen opens the page's edition dialog over its desks, which these proofs don't drive.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFile, writeEdition } from "../office/server/editions.ts";

/** `{ projectsDir, isRepo }` for `startServer`: spread the first into its options and the second into its machine. */
export function registered(roomIds) {
  const projectsDir = mkdtempSync(join(tmpdir(), "f1rm-projects-"));
  for (const id of roomIds) writeEdition(projectFile(projectsDir, id), "work");
  return { projectsDir, isRepo: (folder) => roomIds.includes(folder + "/.git") };
}
