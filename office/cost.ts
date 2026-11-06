// What a spec's work cost, in cost units: tokens weighted by API price relative to input, read from the Claude Code transcripts of the repo's step sessions,
// their interns and the PM (decision "Budgets in cost units"). Anthropic does not publish how the subscription weighs tokens, so price is the proxy.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolder } from "./cli/hire.ts";

export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number };
export type Size = "s" | "m" | "l";
/** A spec's cost: its PM's and step sessions' own turns (the PM's interns too), each ticket's interns, the interns that start no ticket branch (a review, its fix pass, a merge), the total in cost units, the coordination share of output tokens and the tickets over their size's warning. */
export type SpecCost = { coordination: Tokens; tickets: Record<number, Tokens>; other: Tokens; total: number; share: number; warnings: number[] };

/** The cost units past which a ticket of each size is flagged; nothing stops for it. shortcut: guessed before any measurement, #94 sets them from the dry run. */
export const WARN: Record<Size, number> = { s: 300_000, m: 1_000_000, l: 3_000_000 };

export const costUnits = (t: Tokens) => t.input + 1.25 * t.cacheWrite + 0.1 * t.cacheRead + 5 * t.output;
const zero = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const add = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output });
const entriesOf = (file: string): any[] =>
  readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

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

/** Each spec's cost in the repo, by spec number, from the transcripts under `projectsDir` (`~/.claude/projects`). A ticket without a size label is medium. */
export function specCosts(projectsDir: string, repo: string, sizes: Record<number, Size> = {}): Record<number, SpecCost> {
  const dir = join(projectsDir, projectFolder(repo));
  const specs: Record<number, SpecCost> = {};
  const of = (n: number) => (specs[n] ??= { coordination: zero(), tickets: {}, other: zero(), total: 0, share: 0, warnings: [] });
  for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : []) {
    const entries = entriesOf(join(dir, file));
    const role = entries.find((o) => o?.type === "agent-setting")?.agentSetting;
    const name = String(entries.find((o) => o?.type === "agent-name")?.agentName ?? "");
    const step = role === "f1rm:step" ? /^(?:tickets|implement|close)-(\d+)(?:-\d+)?$/.exec(name) : null;
    if (step) {
      const s = of(Number(step[1]));
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
    s.warnings = Object.entries(s.tickets).filter(([n, t]) => costUnits(t) > WARN[sizes[Number(n)] ?? "m"]).map(([n]) => Number(n));
  }
  return specs;
}
