// The PM's board: where its file lives and how to read it. The office only reads boards, never writes them.
import { basename, dirname, join } from "node:path";

export type BoardRow = { id: string; owner: string; status: string; branch: string; task: string };

// The file is untrusted input: it is read in bounded size and every cell is clipped, so a hostile board can't flood the browser.
export const MAX_BOARD_BYTES = 64 * 1024;
// ponytail: rows past the cap are dropped silently, so the counts undercount a board that long; raise it or report the overflow if one gets there.
const MAX_ROWS = 100;
const MAX_CELL = { id: 16, owner: 60, status: 16, branch: 60, task: 200 };

/** The room's repo directory: a git room is its common dir, whose parent is the main working directory (as in the room's name). */
export const repoDir = (roomId: string) => (basename(roomId) === ".git" ? dirname(roomId) : roomId);

/** `~/.f1rm/boards/<repo>.md`, as the f1rm-guidelines skill states: every character that is not an ASCII letter or digit becomes `-`. */
export const boardFile = (boardsDir: string, roomId: string) => join(boardsDir, repoDir(roomId).replace(/[^A-Za-z0-9]/gu, "-") + ".md");

/** A team's board, `~/.f1rm/boards/<repo>.team.<team>.md`: the encoded repo has no `.`, so the name can't be mistaken. `team` is a slug. */
export const teamBoardFile = (boardsDir: string, roomId: string, team: string) => boardFile(boardsDir, roomId).replace(/\.md$/, `.team.${team}.md`);

// Control characters and bidi overrides could scramble or spoof what the board seems to say.
const clip = (s: string, n: number) => {
  s = s.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** The task rows of a board file: its table minus the header and the separator. Anything else in the file is ignored. */
export function parseBoard(text: string): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const line of text.split("\n")) {
    if (rows.length >= MAX_ROWS) break;
    const l = line.trim();
    if (!l.startsWith("|")) continue;
    // A `|` in the task breaks the format; the cells it spills into rejoin the task.
    const [id = "", owner = "", status = "", branch = "", ...task] = l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!task.length || /^[:\- ]*$/.test(id) || (id === "id" && status === "status")) continue;
    rows.push({
      id: clip(id, MAX_CELL.id),
      owner: clip(owner, MAX_CELL.owner),
      status: clip(status, MAX_CELL.status).toLowerCase(),
      branch: clip(branch, MAX_CELL.branch),
      task: clip(task.join(" | "), MAX_CELL.task),
    });
  }
  return rows;
}

/** The board at `path`, or no rows when there is no board or it can't be read. */
export async function readBoard(path: string): Promise<BoardRow[]> {
  try {
    return parseBoard(await Bun.file(path).slice(0, MAX_BOARD_BYTES).text());
  } catch {
    return [];
  }
}
