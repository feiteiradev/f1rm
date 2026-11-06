// `f1rm pause [reason...] [--all]` and `f1rm resume [--all]`: ask the running office to pause or resume the project of the current folder, or every project with --all.
// Who may run them is the office's gate (PM only, --all never from a session); the office does the work, so there is no pause without it.

import { join } from "node:path";
import { checkpointDirOf, checkpointsDirOf, latestManifest, readManifest } from "../server/checkpoint.ts";
import { pausedDirOf, pausedFile, readPaused } from "../server/pause.ts";

export const USAGE = "usage: f1rm pause [reason...] [--all] | f1rm resume [--all]";

type Proc = { pid: number; command: string; cwd: string | null };
/** What the office did to one project: the sessions it stopped, the processes it killed, what still ran after that, and the checkpoint it took. */
export type StopResult = { room: string; stopped: string[]; killed: (Proc & { signal: string })[]; remaining: Proc[]; checkpoint: string | null; verified: boolean; saved: { task: string; ref: string; sha: string; dirty: boolean }[]; unsaved?: string[] };
type Reply = { ok?: boolean; error?: string; rooms?: string[]; waking?: number; results?: StopResult[]; lost?: { name: string; why: string }[] };
export type PauseDeps = {
  /** The project of the folder the command runs in (its room id), or null outside git. */
  room: () => string | null;
  /** Posts `body` to the office's `pause` or `resume` route; throws when no office answers. */
  post: (verb: string, body: object) => Promise<{ status: number; body: Reply }>;
};

/** Runs the command and returns the line it prints. Throws what the office or the usage refuses with. */
export async function pauseCall(verb: "pause" | "resume", words: string[], d: PauseDeps): Promise<string> {
  const all = words.includes("--all");
  const rest = words.filter((w) => w !== "--all");
  if (words.some((w) => w.startsWith("-") && w !== "--all") || (verb === "resume" && rest.length)) throw new Error(USAGE);
  const room = all ? null : d.room();
  if (!all && !room) throw new Error("not in a git repo");
  const { status, body } = await d.post(verb, all ? { all } : { room, ...(rest.length && { why: rest.join(" ") }) });
  if (status !== 200 || !body.ok) throw new Error(body.error ?? `the office answered ${status}`);
  const names = (body.rooms ?? []).join(", ");
  if (verb === "pause") {
    if (body.results?.length) return stopReport(body.results, names, all);
    return names
      ? `paused ${names}: its sessions stop at their next step, any still busy in 30 s are stopped, and the office wakes nothing until \`f1rm resume\``
      : `${all ? "every project is" : "this project is"} already paused`;
  }
  if (!names) return `${all ? "no project is" : "this project is not"} paused`;
  const lost = (body.lost ?? []).map((l) => `\nNOT woken: ${l.name} (${l.why})`).join("");
  return `resumed ${names}${body.waking ? `: continuing ${body.waking} ${body.waking === 1 ? "hire" : "hires"} one at a time (\`f1rm status\` shows them)` : ""}${lost}`;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const procLine = (p: Proc) => `pid ${p.pid} \`${p.command}\`${p.cwd ? ` (cwd ${p.cwd})` : ""}`;

/**
 * The words of a pause that stopped things: "All N stopped" only for a project the office checked afterwards (nothing of it still ran). One that did not verify throws, naming what runs, so the command exits non-zero.
 * A project that was paused already and has nothing running says so.
 */
function stopReport(results: StopResult[], paused: string, all: boolean): string {
  const bad = results.filter((r) => !r.verified);
  if (bad.length) {
    throw new Error(bad.map((r) => `${r.room} is NOT stopped: still running after the kill: ${r.remaining.map(procLine).join("; ")}.${r.checkpoint ? ` The checkpoint ${r.checkpoint} was taken.` : ""} Do not close anything: run \`f1rm pause\` again, or end those yourself.`).join("\n"));
  }
  if (!paused && results.every((r) => !r.stopped.length && !r.killed.length)) {
    return `${all ? "every project is" : "this project is"} already paused; nothing of ${all ? "them" : "it"} runs${results.length === 1 && results[0]!.checkpoint ? ` (checkpoint ${results[0]!.checkpoint})` : ""}`;
  }
  return results.map((r) => [
    `paused ${r.room}: All ${r.stopped.length + r.killed.length} stopped (${plural(r.stopped.length, "session")}, ${plural(r.killed.length, "background process", "background processes")}); checked afterwards, nothing of the project still runs.`,
    ...r.killed.map((p) => `  killed ${procLine(p)}${p.signal === "SIGKILL" ? " with SIGKILL" : ""}`),
    ...(r.unsaved?.length ? [`NOT saved: ${r.unsaved.join(", ")} (no commit to save on top of); the files are untouched, but no ref holds them.`] : []),
    ...(r.checkpoint ? [`checkpoint ${r.checkpoint}: ${plural(r.saved.length, "worktree")} saved${r.saved.length ? ` (${r.saved.map((s) => `${s.ref}${s.dirty ? " with uncommitted work" : ""}`).join(", ")})` : ""}. Safe to close; \`f1rm resume\` wakes everyone with a note of where they stopped.`] : []),
  ].join("\n")).join("\n");
}

/**
 * What the PM's start adds to its first prompt when the project is paused: it was stopped and checkpointed by the office, so a fresh PM reads the board, the milestones file and the manifest and says where everything stopped,
 * and wakes nothing until the user says resume. Empty when the project is not paused.
 */
export function pausedNote(root: string, home: string): string {
  const paused = readPaused(pausedFile(pausedDirOf(home), root));
  if (!paused) return "";
  const dir = checkpointDirOf(checkpointsDirOf(home), root);
  const manifest = (paused.checkpoint ? readManifest(dir, paused.checkpoint) : null) ?? latestManifest(dir);
  const since = `${paused.by}${paused.why ? `: ${paused.why}` : ""}, at ${new Date(paused.at).toISOString()}`;
  return ` This project is PAUSED (${since}) and everything in it is stopped${manifest ? `: checkpoint ${manifest.id}, manifest ${join(dir, `${manifest.id}.json`)}` : ""}. The office starts no step in it. Tell me so in one line; when I say "resume", run \`f1rm resume\`${manifest ? ": it wakes every session of the manifest, each with a note of where it stopped" : ""}.`;
}
