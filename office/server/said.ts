// What a hire last said, for the card that asks the user to approve its command: the text of its latest assistant line, from the tail of its own transcript.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { clip } from "./board.ts";

const TAIL_BYTES = 128 * 1024;
export const WHY_MAX = 300;

/**
 * The assistant text just before the call, cut to WHY_MAX characters: the latest one since the user's last prompt or tool result. "" when there is none or the file can't be read (a wrong why is worse than none).
 * Text blocks only: no tool call, no thinking, no sub-agent's words.
 * The path must be `<transcriptsDir>/<project folder>/<sessionId>.jsonl`, like the skill gate's read; it guards against slips, not against the user.
 * ponytail: only the last 128 KB is read, so a turn that ran many long tool results since its last words shows no why; read further back if that is felt.
 */
export function lastSaid(transcriptsDir: string, sessionId: string, hint: unknown): string {
  try {
    if (typeof hint !== "string" || hint.split(sep).includes("..")) return "";
    const path = resolve(hint);
    if (basename(path) !== `${sessionId}.jsonl`) return "";
    const realDir = realpathSync(resolve(transcriptsDir));
    const real = realpathSync(path);
    if (real !== join(realDir, basename(dirname(path)), basename(path))) return "";
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); // a pipe at the path must not hang the office
    let text: string;
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return "";
      const start = Math.max(0, info.size - TAIL_BYTES);
      const buffer = Buffer.alloc(info.size - start);
      text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, start));
      if (start > 0) text = text.slice(text.indexOf("\n") + 1); // the first line is cut in two
    } finally {
      closeSync(fd);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry?.type === "user" && !entry.isSidechain) return ""; // the user's prompt or a tool result: the words before it belong to an earlier step
        if (entry?.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
        const said = entry.message.content.flatMap((b: any) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join(" ");
        if (said.trim()) return clip(clip(said, Infinity).replace(/\s+/g, " "), WHY_MAX);
      } catch {} // a line that is not JSON counts for nothing
    }
  } catch {} // missing, unreadable or odd: no why
  return "";
}
