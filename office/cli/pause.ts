// `f1rm pause [reason...] [--all]` and `f1rm resume [--all]`: ask the running office to pause or resume the project of the current folder, or every project with --all.
// Who may run them is the office's gate (PM only, --all never from a session); the office does the work, so there is no pause without it.

export const USAGE = "usage: f1rm pause [reason...] [--all] | f1rm resume [--all]";

type Reply = { ok?: boolean; error?: string; rooms?: string[]; waking?: number };
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
    return names
      ? `paused ${names}: its sessions stop at their next step, any still busy in 30 s are stopped, and the office wakes nothing until \`f1rm resume\``
      : `${all ? "every project is" : "this project is"} already paused`;
  }
  if (!names) return `${all ? "no project is" : "this project is not"} paused`;
  return `resumed ${names}${body.waking ? `: continuing ${body.waking} ${body.waking === 1 ? "hire" : "hires"} one at a time, as the cap of 8 allows (\`f1rm status\` shows them)` : ""}`;
}
