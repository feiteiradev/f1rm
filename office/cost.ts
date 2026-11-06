// What a spec's work cost, in cost units: tokens weighted by API price relative to input, read from the Claude Code transcripts of the repo's step sessions,
// their interns and the PM (decision "Budgets in cost units"). Anthropic does not publish how the subscription weighs tokens, so price is the proxy.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectFolder } from "./cli/hire.ts";

export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number };
export type Size = "s" | "m" | "l";
/** A spec's cost: its PM's and step sessions' own turns (the PM's interns too), each ticket's interns, the interns that start no ticket branch (a review, its fix pass, a merge), the total in cost units and the coordination share of output tokens. */
export type SpecCost = { coordination: Tokens; tickets: Record<number, Tokens>; other: Tokens; total: number; share: number };

/** Each ticket size's budget in cost units, 1.5 times the median the dry run measured (decision "Budgets in cost units"). shortcut: no small or large ticket has run yet, so theirs are half and triple the medium one and only mark the ticket; once `f1rm cost` shows some, set each to 1.5 times its median and add it to MEASURED. */
export const BUDGET: Record<Size, number> = { s: 100_000, m: 200_000, l: 600_000 };
/** The sizes whose budget was measured: only these stop a step, so a guessed number never stops real work. */
export const MEASURED: Size[] = ["m"];
/** A ticket's budget: its size's (none counts as medium), times any raises it was given. */
export const budgetOf = (size: Size | undefined, factor = 1) => BUDGET[size ?? "m"] * factor;

/** The spec a step session works on, from its name (`tickets-7`, `implement-7`, `close-7-2`); null for any other name. */
export const specOfStep = (name: string) => {
  const m = /^(?:tickets|implement|close)-(\d+)(?:-\d+)?$/.exec(name);
  return m ? Number(m[1]) : null;
};

export const costUnits = (t: Tokens) => t.input + 1.25 * t.cacheWrite + 0.1 * t.cacheRead + 5 * t.output;
const zero = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const add = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output });
const parse = (text: string): any[] =>
  text.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
// The office reads costs every minute and a repo's transcripts can weigh hundreds of MB: a file is read again only when it changed.
// shortcut: the cache only grows within a process; clear it by age if an office runs for weeks over many repos.
const cache = new Map<string, { stamp: string; entries: any[] }>();
const entriesOf = (file: string): any[] => {
  const st = statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.entries;
  const entries = parse(readFileSync(file, "utf8"));
  cache.set(file, { stamp, entries });
  return entries;
};
/** A transcript's first lines, where Claude Code writes the session's name and agent type. shortcut: a session whose first lines hold more than 64 KB before them is not seen; read the whole file when its head names no agent if that ever shows up. */
const headOf = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    return parse(buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8"));
  } finally {
    closeSync(fd);
  }
};

/** A transcript's tokens. A message is written once per content block and early copies carry partial counts, so each message counts once with the largest of each field. */
function tokensOf(entries: any[]): Tokens {
  const byId = new Map<string, Tokens>();
  for (const o of entries) {
    const u = o?.type === "assistant" ? o.message?.usage : undefined;
    if (!u || !o.message.id) continue;
    const t = { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
    const seen = byId.get(o.message.id);
    byId.set(o.message.id, seen ? { input: Math.max(t.input, seen.input), cacheWrite: Math.max(t.cacheWrite, seen.cacheWrite), cacheRead: Math.max(t.cacheRead, seen.cacheRead), output: Math.max(t.output, seen.output) } : t);
  }
  return [...byId.values()].reduce(add, zero());
}

const toolUses = (entries: any[]) =>
  entries.flatMap((o) => (o?.type === "assistant" && Array.isArray(o.message?.content) ? o.message.content.filter((c: any) => c?.type === "tool_use").map((c: any) => ({ id: String(c.id), text: JSON.stringify(c.input ?? {}) })) : []));
/** The ticket an intern built: the `ticket-<n>` branch it starts (`checkout -b`, `switch -c`, `worktree add -b`). Naming a ticket in a diff or a merge is no start. */
const ticketOf = (entries: any[]) => {
  for (const c of toolUses(entries)) {
    const m = /(?:checkout|switch|worktree add)\b[^"]*?\s-[bcB]\s+ticket-(\d+)\b/.exec(c.text);
    if (m) return Number(m[1]);
  }
  return null;
};
const subagentsOf = (dir: string, file: string) => {
  const subs = join(dir, file.slice(0, -".jsonl".length), "subagents");
  return existsSync(subs) ? readdirSync(subs).filter((f) => f.endsWith(".jsonl")).map((f) => entriesOf(join(subs, f))) : [];
};
/** The specs a PM published: the issue each `gh issue create` printed. */
function published(entries: any[]): number[] {
  const creates = new Set(toolUses(entries).filter((c) => c.text.includes("gh issue create")).map((c) => c.id));
  const specs: number[] = [];
  for (const o of entries) {
    if (o?.type !== "user" || !Array.isArray(o.message?.content)) continue;
    for (const c of o.message.content) {
      const m = c?.type === "tool_result" && creates.has(String(c.tool_use_id)) ? /\/issues\/(\d+)/.exec(typeof c.content === "string" ? c.content : JSON.stringify(c.content)) : null;
      if (m) specs.push(Number(m[1]));
    }
  }
  return specs;
}

/** Each spec's cost in the repo, by spec number, from the transcripts under `projectsDir` (`~/.claude/projects`). */
export function specCosts(projectsDir: string, repo: string): Record<number, SpecCost> {
  const dir = join(projectsDir, projectFolder(repo));
  const specs: Record<number, SpecCost> = {};
  const of = (n: number) => (specs[n] ??= { coordination: zero(), tickets: {}, other: zero(), total: 0, share: 0 });
  for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : []) {
    const head = headOf(join(dir, file));
    const role = head.find((o) => o?.type === "agent-setting")?.agentSetting;
    const name = String(head.find((o) => o?.type === "agent-name")?.agentName ?? "");
    if (role !== "f1rm:step" && role !== "f1rm:pm") continue;
    const entries = entriesOf(join(dir, file));
    const step = role === "f1rm:step" ? specOfStep(name) : null;
    if (step !== null) {
      const s = of(step);
      s.coordination = add(s.coordination, tokensOf(entries));
      for (const e of subagentsOf(dir, file)) {
        const ticket = ticketOf(e);
        if (ticket === null) s.other = add(s.other, tokensOf(e));
        else s.tickets[ticket] = add(s.tickets[ticket] ?? zero(), tokensOf(e));
      }
    } else if (role === "f1rm:pm") {
      // shortcut: a PM session that published several specs counts whole toward the first; split it by turn if PM sessions span specs.
      const first = published(entries)[0];
      if (first !== undefined) of(first).coordination = [entries, ...subagentsOf(dir, file)].reduce((t, e) => add(t, tokensOf(e)), of(first).coordination);
    }
  }
  for (const s of Object.values(specs)) {
    const total = s.coordination.output + s.other.output + Object.values(s.tickets).reduce((n, t) => n + t.output, 0);
    s.share = total ? s.coordination.output / total : 0;
    s.total = costUnits(s.coordination) + costUnits(s.other) + Object.values(s.tickets).reduce((n, t) => n + costUnits(t), 0);
  }
  return specs;
}

/** One line per spec of the repo, in cost units (see office/cost.ts), with the tickets over their size's budget. */
export function specTable(repo: string, projectsDir: string, sizes: Record<number, Size>, command: string) {
  const units = (t: Tokens) => Math.round(costUnits(t)).toLocaleString("en-US");
  const rows = Object.entries(specCosts(projectsDir, repo)).map(([n, s]) => {
    const list = Object.entries(s.tickets).map(([t, c]) => `#${t} ${units(c)}`).join(", ") || "none";
    return `| #${n} | ${units(s.coordination)} | ${list} | ${units(s.other)} | ${Math.round(s.total).toLocaleString("en-US")} | ${Math.round(s.share * 100)}% | ${Object.keys(s.tickets).filter((t) => costUnits(s.tickets[Number(t)]) > budgetOf(sizes[Number(t)])).map((t) => `#${t}`).join(", ") || "none"} |`;
  });
  return [
    `# Cost per spec: ${repo}`,
    "",
    "Cost units weigh input 1, cache write 1.25, cache read 0.1 and output 5. Coordination is the PM's and the step sessions' own turns; the share is of output tokens.",
    "",
    "```",
    command,
    "```",
    "",
    "| spec | coordination | tickets | other interns | total | coordination share | over budget |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The tickets' size labels (`size:s`, `size:m`, `size:l`) from GitHub; none when gh can't read them. */
export function sizesOf(repo: string): Record<number, Size> {
  const p = Bun.spawnSync(["gh", "issue", "list", "--state", "all", "--limit", "1000", "--json", "number,labels"], { cwd: repo });
  try {
    const sizes: Record<number, Size> = {};
    for (const i of JSON.parse(p.stdout.toString()) as { number: number; labels: { name: string }[] }[]) {
      const size = i.labels.map((l) => /^size:([sml])$/.exec(l.name)?.[1]).find(Boolean);
      if (size) sizes[i.number] = size as Size;
    }
    return sizes;
  } catch {
    return {};
  }
}
