// The tag over an office step's head: which step it is, from its session name. Interns are not employees, so they never reach this.
import type { Employee } from "../server/office.ts";

const KINDS: Record<string, string> = { tickets: "TICKETS", implement: "BUILD", close: "CLOSE" };
export const stepTag = (e: Pick<Employee, "role" | "title">) => (e.role !== "lead" ? null : KINDS[/^(tickets|implement|close)-\d/.exec(e.title ?? "")?.[1] ?? ""] ?? "STEP");
