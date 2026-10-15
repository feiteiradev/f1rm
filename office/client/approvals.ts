// The approvals tray's pure part: what a raised hand asks for, as text.

/** The full arguments of a tool request as plain text: a Bash command as is, anything else as indented JSON. Never shortened, because approving acts on exactly this. */
export function argsText(tool: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  if (tool === "Bash" && typeof command === "string") return command;
  return JSON.stringify(input, null, 2) ?? "";
}
