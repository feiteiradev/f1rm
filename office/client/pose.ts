// What an employee is shown doing, derived from server state alone.
import type { Employee, OfficeState, Status } from "../server/office.ts";

export type Pose = "typing" | "reading" | "running" | "hand" | "coffee";

const TOOL_POSE: Record<string, Pose> = {
  Edit: "typing",
  MultiEdit: "typing",
  Write: "typing",
  NotebookEdit: "typing",
  Read: "reading",
  Grep: "reading",
  Glob: "reading",
  WebFetch: "reading",
  WebSearch: "reading",
  Bash: "running",
};

export function poseOf(e: Pick<Employee, "status" | "tool">): Pose {
  if (e.status === "waiting") return "hand";
  if (e.status === "idle") return "coffee";
  // ponytail: a tool with no pose of its own (Agent, MCP tools, thinking) types; give it a pose if one earns it.
  return TOOL_POSE[e.tool] ?? "typing";
}

export function statusCounts(state: OfficeState): Record<Status, number> {
  const counts = { working: 0, waiting: 0, idle: 0 };
  for (const e of Object.values(state.employees)) counts[e.status]++;
  return counts;
}
