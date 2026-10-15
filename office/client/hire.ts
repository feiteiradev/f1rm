// The Hire dialog's pure parts.

export const TASK_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A task name from the brief's first words: lowercase words joined by hyphens, or "" when the brief has none. */
export function taskFrom(brief: string): string {
  return (brief.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 4).join("-").slice(0, 40).replace(/-$/, "");
}
