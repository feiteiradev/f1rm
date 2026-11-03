// Topic progress: what a team's board and its desk.md say, as numbers for the project room, and the read-only route for the proofs the desk names.
import { realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { clip, openQuestion, parseBoard } from "./board.ts";

export type DeskLine = { task: string; at: string; proof: string; note: string };
export type Topic = {
  team: string;
  done: number;
  total: number;
  last: { task: string; at: string | null } | null;
  stuck: string[];
  desk: DeskLine[];
};

const MAX_DESK_LINES = 50;
const CELL = { at: 40, task: 80, proof: 300, note: 200 };

/** `~/.f1rm/evidence/<repo>/lead-<team>/desk.md`: one `| <ISO date> | <task> | <proof> | <what landed> |` line per landed task. Anything else in the file is ignored. */
export function parseDesk(text: string): DeskLine[] {
  const lines: DeskLine[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("|")) continue;
    const [at = "", task = "", proof = "", ...note] = l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!at || !task || !note.length || /^[:\- ]*$/.test(at)) continue;
    lines.push({ at: clip(at, CELL.at), task: clip(task, CELL.task), proof: clip(proof, CELL.proof), note: clip(note.join(" | "), CELL.note) });
    if (lines.length >= MAX_DESK_LINES) break;
  }
  return lines;
}

/** One topic from its team board text and its desk.md text (either may be empty). */
export function topicProgress(boardText: string, deskText: string): Omit<Topic, "team"> {
  const rows = parseBoard(boardText);
  const desk = parseDesk(deskText);
  const question = openQuestion(boardText);
  const newest = desk.reduce<DeskLine | null>((n, d) => (!n || Date.parse(d.at) >= Date.parse(n.at) || Number.isNaN(Date.parse(n.at)) ? d : n), null);
  const landed = rows.findLast((r) => r.status === "done");
  const slug = landed && (landed.branch.replace(/^worktree-/, "").replace(/^-$/, "") || landed.id);
  return {
    done: rows.filter((r) => r.status === "done").length,
    total: rows.length,
    last: newest ? { task: newest.task, at: newest.at } : slug ? { task: slug, at: null } : null,
    // The snapshot has no stopped or limit state for a lead, so stuck is blocked rows plus the open question for now; usage-disk's gauges cover limits.
    stuck: [...rows.filter((r) => r.status === "blocked").map((r) => `${r.id} blocked: ${r.task}`), ...(question ? [`waits for you: ${question}`] : [])],
    desk,
  };
}

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};
export const proofType = (file: string) => TYPES[extname(file).toLowerCase()];

/**
 * The real path of the media file `rel` names inside `root`, or null. `rel` is relative and decoded: a `..`, `.` or empty segment (so an absolute path too) is refused,
 * and so is anything whose real path, after links, is not a regular media file inside the real root.
 */
export function evidenceFile(root: string, rel: string): string | null {
  const parts = rel.split("/");
  if (!rel || parts.some((p) => !p || p === "." || p === ".." || p.includes("\0") || p.includes("\\"))) return null;
  const file = join(root, ...parts);
  try {
    const real = realpathSync(file);
    // Judged on the real path, which is also what is served: a link's own name decides nothing.
    return real.startsWith(realpathSync(root) + sep) && proofType(real) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
