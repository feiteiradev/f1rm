// The New topic dialog's pure parts.
import type { OfficeState } from "../server/office.ts";
import { TASK_NAME } from "./hire.ts";
import type { send as sendType } from "./post.ts";

/** The names of the project's leads that are live now. */
export const liveLeads = (state: OfficeState, room: string) =>
  Object.values(state.employees).filter((e) => e.room === room && e.role === "lead" && e.status !== "offline").map((e) => e.name);

/** Why this topic can't start: "" while the name is empty (no message yet), null when it can. */
export function topicProblem(name: string, live: string[]): string | null {
  if (!name) return "";
  if (!TASK_NAME.test(name)) return "A topic name is lowercase words joined by hyphens.";
  return live.includes(`lead-${name}`) ? `lead-${name} is already live in this project.` : null;
}

/** Starts `lead-<name>` in the project. Null when the office did it, otherwise why not. */
export async function startTopic(room: string, name: string, send: typeof sendType, live: string[] = []): Promise<string | null> {
  const problem = topicProblem(name, live);
  if (problem !== null) return problem || "Name the topic.";
  return (await send("topic", { room, name })).error;
}

/** What the dialog holds: the name, whether a start is in flight, and the server's last refusal. */
export type TopicForm = { topic: string; busy: boolean; refused: string | null };

/** An edit of the name drops the refusal, which was about the old name. */
export const editTopic = (f: TopicForm, topic: string): TopicForm => ({ ...f, topic, refused: null });

export const startDisabled = (f: TopicForm, live: string[]) => f.busy || topicProblem(f.topic, live) !== null;

/** The Start button: `store.get` must read the latest form (a ref), so a second submit before a re-render still sees busy. */
export async function submitTopic(
  store: { get: () => TopicForm; set: (update: (f: TopicForm) => TopicForm) => void },
  room: string,
  live: string[],
  send: typeof sendType,
  onClose: () => void,
): Promise<void> {
  if (startDisabled(store.get(), live)) return;
  store.set((f) => ({ ...f, busy: true, refused: null }));
  const error = await startTopic(room, store.get().topic, send, live);
  if (error === null) return onClose();
  store.set((f) => ({ ...f, busy: false, refused: error }));
}
