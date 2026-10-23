// What a hire said when it made a call, for the card that asks the user to approve it: the text of the assistant message that holds the call, from the tail of its own transcript.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { clip } from "./board.ts";

const TAIL_BYTES = 128 * 1024;
export const WHY_MAX = 300;

/** The same value whatever the order of an object's keys. */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * The text blocks of the assistant message that holds this call, cut to WHY_MAX characters. Claude Code writes each content block of a message as a line of its own, all with the message's id, so the call is found by its
 * tool_use line (the same tool and input, newest first, one whose result is not written yet: the hook's payload has no tool_use_id) and the words are those of the lines that share its message id. That is right for every call of a batch,
 * and for a sub-agent's call (its own message, never the parent's). "" when the call's line is not written yet (the hook fires a moment before it is), when its message has no words, or when the file can't be read: a wrong why is worse than none.
 * Text blocks only: no tool call, no thinking.
 * The path must be `<transcriptsDir>/<project folder>/<sessionId>.jsonl`, like the skill gate's read; it guards against slips, not against the user.
 * ponytail: only the last 128 KB is read, so a call whose message is further back shows no why; read further back if that is felt.
 */
export function lastSaid(transcriptsDir: string, sessionId: string, hint: unknown, tool: string, input: unknown): string {
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
    const entries = text.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" ? [entry] : [];
      } catch {
        return []; // a line that is not JSON counts for nothing
      }
    });
    const blocks = (e: any): any[] => (Array.isArray(e.message?.content) ? e.message.content : []);
    const finished = new Set(entries.filter((e) => e.type === "user").flatMap((e) => blocks(e).flatMap((b) => (b?.type === "tool_result" ? [b.tool_use_id] : []))));
    const wanted = canonical(input);
    const held = entries.findLast((e) => e.type === "assistant" && blocks(e).some((b) => b?.type === "tool_use" && b.name === tool && !finished.has(b.id) && canonical(b.input) === wanted));
    if (!held) return "";
    const same = (e: any) => e.type === "assistant" && (held.message?.id ? e.message?.id === held.message.id : e === held);
    const said = entries.filter(same).flatMap((e) => blocks(e).flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : []))).join(" ");
    return said.trim() ? clip(clip(said, Infinity).replace(/\s+/g, " "), WHY_MAX) : "";
  } catch {} // missing, unreadable or odd: no why
  return "";
}
