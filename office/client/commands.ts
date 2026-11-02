// The commands card's pure part: how a project's derived list is grouped and shown, and which lines a tick sends.
import type { Cmd, Group } from "../server/projectcmds.ts";
import { post } from "./post.ts";

const TITLES: Record<Group, string> = {
  script: "package.json scripts",
  runner: "Test runner",
  install: "Install",
  workflow: "CI steps",
  git: "git in a worktree",
  gh: "GitHub reads",
  f1rm: "The company's own commands",
};

/** The list in the order the server derived it, one block per group. */
export function groupsOf(list: Cmd[]) {
  const groups: { group: Group; title: string; items: Cmd[] }[] = [];
  for (const c of list) {
    let g = groups.find((x) => x.group === c.group);
    if (!g) groups.push((g = { group: c.group, title: TITLES[c.group], items: [] }));
    g.items.push(c);
  }
  return groups;
}

/** The command a rule allows, without the `Bash(` and `)` around it: `bun run build *`. */
export const commandOf = (id: string) => id.replace(/^Bash\((.*)\)$/s, "$1");

/** What the user has ticked: the server's pre-check unless the user changed the line; an excluded line is never on. */
export const isOn = (c: Cmd, ticks: Record<string, boolean>) => !c.excluded && (ticks[c.id] ?? c.checked);

/** The button's action: POSTs the lines that are on to the project's commands route. Null when the office did it, otherwise why it didn't. */
export const approveCommands = (room: string, list: Cmd[], ticks: Record<string, boolean>) => post(`commands/${encodeURIComponent(room)}`, { ids: idsOn(list, ticks) });

/** The ids to send: the lines that are on. The server ignores any other. */
export const idsOn = (list: Cmd[], ticks: Record<string, boolean>) => list.filter((c) => isOn(c, ticks)).map((c) => c.id);
