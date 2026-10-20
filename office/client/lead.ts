// Who wears the LEAD tag over their head: team leads only. Interns are not employees, so they never reach this.
import type { Employee } from "../server/office.ts";

export const showsLeadTag = (e: Pick<Employee, "role">) => e.role === "lead";
