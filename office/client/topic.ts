// The New topic dialog's pure parts.
import type { OfficeState } from "../server/office.ts";
import { TASK_NAME } from "./hire.ts";
import type { send as sendType } from "./post.ts";

/** The names of the project's leads that are live now. */
export const liveLeads = (state: OfficeState, room: string) =>
  Object.values(state.employees).filter((e) => e.room === room && e.role === "lead").map((e) => e.name);

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
