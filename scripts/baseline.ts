#!/usr/bin/env bun
// What did the last N merged tasks cost? Tokens and wall hours from Claude Code transcripts.
// bun scripts/baseline.ts --last 38 --out <file.md> [--until <ref>] [--projects <dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Merge = { sha: string; slug: string; startedAt: number; mergedAt: number };
export type Deps = { merges: Merge[]; projectsDir: string; mainFolder: string };

type Tokens = [input: number, output: number, cacheCreate: number, cacheRead: number];
type Session = { role: string; name: string; times: number[]; usage: { ts: number; t: Tokens }[] };

const KINDS = ["in", "out", "cache-create", "cache-read"];
const IDLE_MS = 30 * 60_000;
const HOUR = 3_600_000;
const zero = (): Tokens => [0, 0, 0, 0];
const add = (a: Tokens, b: Tokens): Tokens => a.map((x, i) => x + b[i]) as Tokens;

function readSession(path: string): Session {
  const s: Session = { role: "", name: "", times: [], usage: [] };
  const byId = new Map<string, { ts: number; t: Tokens }>();
  const subDir = join(path.slice(0, -".jsonl".length), "subagents");
  const subs = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(subDir, f)) : [];
  for (const file of [path, ...subs]) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (file === path && o.type === "agent-setting") s.role = o.agentSetting;
      if (file === path && o.type === "agent-name") s.name = o.agentName;
      const ts = Date.parse(o.timestamp);
      if (file === path && !Number.isNaN(ts)) s.times.push(ts);
      const u = o.type === "assistant" ? o.message?.usage : undefined;
      if (!u || !o.message.id || Number.isNaN(ts)) continue;
      const t: Tokens = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0];
      // a message is written once per content block and early copies carry partial output counts
      const seen = byId.get(o.message.id);
      byId.set(o.message.id, seen ? { ts: seen.ts, t: t.map((x, i) => Math.max(x, seen.t[i])) as Tokens } : { ts, t });
    }
  }
  s.usage = [...byId.values()];
  return s;
}

type Owner = { slug: string; side: "dev" | "reviewer" } | { overhead: string } | null;

function classify(s: Session, folder: string, mainFolder: string, slugs: string[]): Owner {
  const side = s.role === "f1rm:reviewer" ? "reviewer" : "dev";
  if (folder === mainFolder) {
    if (s.role === "f1rm:lead") return { overhead: "lead" };
    if (s.role === "f1rm:pm") return { overhead: "pm" };
    const slug = slugs.filter((x) => s.name.endsWith("-" + x)).sort((a, b) => b.length - a.length)[0];
    return slug ? { slug, side } : { overhead: "other" };
  }
  const rest = folder.startsWith(mainFolder + "--claude-worktrees-") ? folder.slice(mainFolder.length + 19) : "";
  if (slugs.includes(rest)) return { slug: rest, side };
  if (rest.startsWith("review-") && slugs.includes(rest.slice(7))) return { slug: rest.slice(7), side: "reviewer" };
  return null;
}

function activeMs(times: number[]) {
  const t = [...times].sort((a, b) => a - b);
  return t.slice(1).reduce((sum, x, i) => (x - t[i] <= IDLE_MS ? sum + x - t[i] : sum), 0);
}

type Row = {
  slug: string; shas: string[]; dev: Tokens; reviewer: Tokens; sessions: number;
  wall: number; active: number; commitToMerge: number;
};

function measure(d: Deps, last: number) {
  if (!d.merges.length) throw new Error("no 'Merge branch worktree-<slug>' commits found");
  const all = [...d.merges].sort((a, b) => a.mergedAt - b.mergedAt);
  const slugs = [...new Set(all.map((m) => m.slug))];
  const picked = slugs.slice(-last);
  const rows = new Map<string, Row & { times: number[] }>();
  for (const slug of picked) {
    const ms = all.filter((m) => m.slug === slug);
    rows.set(slug, {
      slug, shas: ms.map((m) => m.sha), dev: zero(), reviewer: zero(), sessions: 0, times: [],
      wall: 0, active: 0,
      commitToMerge: (ms[ms.length - 1].mergedAt - Math.min(...ms.map((m) => m.startedAt))) / HOUR,
    });
  }
  const from = Math.min(...picked.flatMap((s) => all.filter((m) => m.slug === s).map((m) => m.startedAt)));
  const to = Math.max(...picked.flatMap((s) => all.filter((m) => m.slug === s).map((m) => m.mergedAt)));
  const overhead = new Map<string, { t: Tokens; sessions: number }>();
  for (const folder of readdirSync(d.projectsDir)) {
    if (!folder.startsWith(d.mainFolder)) continue;
    for (const f of readdirSync(join(d.projectsDir, folder)).filter((f) => f.endsWith(".jsonl"))) {
      const s = readSession(join(d.projectsDir, folder, f));
      const owner = classify(s, folder, d.mainFolder, slugs);
      if (!owner) continue;
      if ("overhead" in owner) {
        const inWindow = s.usage.filter((u) => u.ts >= from && u.ts <= to);
        if (!inWindow.length) continue;
        const o = overhead.get(owner.overhead) ?? { t: zero(), sessions: 0 };
        overhead.set(owner.overhead, { t: inWindow.reduce((a, u) => add(a, u.t), o.t), sessions: o.sessions + 1 });
      } else if (rows.has(owner.slug)) {
        const r = rows.get(owner.slug)!;
        r[owner.side] = s.usage.reduce((a, u) => add(a, u.t), r[owner.side]);
        r.times.push(...s.times);
        r.sessions++;
      }
    }
  }
  for (const r of rows.values()) {
    r.wall = r.times.length ? (Math.max(...r.times) - Math.min(...r.times)) / HOUR : 0;
    r.active = activeMs(r.times) / HOUR;
  }
  return { rows: [...rows.values()], overhead, from, to };
}

const h = (x: number) => x.toFixed(2);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";

function render(m: ReturnType<typeof measure>, command: string) {
  const sum = (f: (r: Row) => Tokens) => m.rows.reduce((a, r) => add(a, f(r)), zero());
  const total = (r: Row) => add(r.dev, r.reviewer);
  const hours = (f: (r: Row) => number) => m.rows.reduce((a, r) => a + f(r), 0);
  const n = m.rows.length;
  const head = ["slug", "merges", ...["dev", "reviewer", "total"].flatMap((w) => KINDS.map((k) => `${w} ${k}`)),
    "wall h", "active h", "commit to merge h", "sessions"];
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  const rowCells = (r: Row) => [r.slug, r.shas.join(", "), ...r.dev, ...r.reviewer, ...total(r), h(r.wall), h(r.active), h(r.commitToMerge), r.sessions];
  const sumCells = (label: string, div: number) => [label, "", ...[sum((r) => r.dev), sum((r) => r.reviewer), sum(total)].flatMap((t) => t.map((x) => Math.round(x / div))),
    h(hours((r) => r.wall) / div), h(hours((r) => r.active) / div), h(hours((r) => r.commitToMerge) / div), div === 1 ? hours((r) => r.sessions) : h(hours((r) => r.sessions) / div)];
  const oh = [...m.overhead].sort(([a], [b]) => a.localeCompare(b));
  return [
    "# Baseline: what the last merged tasks cost",
    "",
    `${n} tasks. Overhead window: ${day(m.from)} (first commit of the oldest task) to ${day(m.to)} (last merge).`,
    "",
    "Reproduce (same table as long as the transcripts are kept):",
    "",
    "```",
    command,
    "```",
    "",
    "## Per task",
    "",
    line(head),
    line(head.map(() => "---")),
    ...m.rows.map((r) => line(rowCells(r))),
    line(sumCells("**total**", 1)),
    line(sumCells("**mean per task**", n)),
    "",
    "## Overhead of leads, the PM and other main-folder sessions in the same window",
    "",
    line(["who", "sessions", ...KINDS]),
    line(["---", "---", ...KINDS.map(() => "---")]),
    ...oh.map(([who, o]) => line([who, o.sessions, ...o.t])),
    "",
    "## How it is counted, and what is approximate",
    "",
    "- Tokens are the `usage` fields of assistant lines: input, output, cache creation and cache read. A message appears once per content block, so each message id counts once, with the largest value seen per field.",
    "- Tokens are not money. Models and cache prices differ, and cache read is cheap per token but dominates the count.",
    "- Dev sessions are in the task's worktree folder. Reviewer sessions are found by folder `review-<slug>` or by the session name ending in the slug (they work in the main folder). Interns and subagents write their own files under `<session>/subagents/`, and count with their parent session.",
    "- A reviewer session whose name carries a slug that never merged under that name (for example `link-key-followups-3`, merged as `-4`) is not attributed to any task, so a few rows show a reviewer of zero.",
    "- Leads and the PM work in the main folder for many tasks at once. They are overhead, counted only for lines inside the window, not split per task.",
    "- Dev and reviewer sessions of a task are counted whole, even if a session also did work for a later round of the same task.",
    "- `wall h` is first to last transcript timestamp over all sessions of the task. Gaps are included, so a task left overnight counts the night.",
    `- \`active h\` is the same timestamps with every gap longer than ${IDLE_MS / 60_000} minutes dropped. It is a floor on time spent, not a measure of effort.`,
    "- `commit to merge h` is the task branch's first commit to its last merge commit (a round 2 merge counts once, for the same task). A branch that carries commits of an earlier round, such as `skill-stack-2`, counts from those commits.",
    "- Totals sum parallel tasks, so total hours are not the elapsed calendar time.",
    "- A task whose session transcripts were deleted shows zeros.",
    "",
  ].join("\n");
}

export function run(argv: string[], d: Deps) {
  const arg = (k: string) => argv[argv.indexOf(k) + 1];
  const last = Number(arg("--last"));
  const out = arg("--out");
  if (!Number.isInteger(last) || last < 1 || !out) throw new Error("usage: bun scripts/baseline.ts --last N --out FILE [--until REF] [--projects DIR]");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, render(measure(d, last), `bun scripts/baseline.ts ${argv.join(" ")}`));
}

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function gitMerges(until: string): Merge[] {
  const out: Merge[] = [];
  for (const l of git("log", "--merges", "--first-parent", "--format=%H|%ct|%P|%s", until).split("\n")) {
    const [sha, ct, parents, ...subject] = l.split("|");
    const slug = /^Merge branch 'worktree-([^']+)'/.exec(subject.join("|"))?.[1];
    if (!slug) continue;
    const [p1, p2] = parents.split(" ");
    const first = git("log", "--format=%ct", `${p1}..${p2}`).split("\n").filter(Boolean).map(Number);
    out.push({ sha: sha.slice(0, 7), slug, mergedAt: +ct * 1000, startedAt: (first.length ? Math.min(...first) : +ct) * 1000 });
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = (k: string, dflt: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : dflt);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  run(argv, {
    merges: gitMerges(at("--until", "main")),
    projectsDir: at("--projects", join(homedir(), ".claude", "projects")),
    mainFolder: dirname(common).replace(/[^a-zA-Z0-9]/g, "-"),
  });
}
