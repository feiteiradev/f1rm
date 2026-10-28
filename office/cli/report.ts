// `f1rm report <KIND> <slug> [--commit <sha>] [--note "<one line>"]`: a hire's report as a file, so `f1rm status --watch` and the office's recovery see it even when the SendMessage never arrives.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { machine } from "../server/machine.ts";
import { writePrivate } from "../server/private.ts";
import { SLUG } from "./hire.ts";
import { hireName } from "./letgo.ts";

/** CHANGES stands for CHANGES REQUESTED, and NEEDS for NEEDS YOU. */
export const KINDS = ["DONE", "APPROVED", "CHANGES", "BLOCKED", "ESCALATE", "NEEDS"] as const;
/** The words a kind is announced with. */
export const SHOWN: Record<string, string> = { CHANGES: "CHANGES REQUESTED", NEEDS: "NEEDS YOU" };
export type Report = { kind: string; slug: string; commit: string | null; note: string | null; at: string; seq: number };
type Result = { out: string; err: string; code: number };

const usage = `usage: f1rm report ${KINDS.join("|")} <slug> [--commit <sha>] [--note "<one line>"]`;
const SHA = /^[0-9a-f]{4,64}$/i;
const NOTE_MAX = 300;

/** `~/.f1rm/evidence/<repo>/<slug>/report.json`, `repo` the repo folder's basename. */
export const reportFile = (home: string, repoName: string, slug: string) => join(home, ".f1rm", "evidence", repoName, slug, "report.json");

/** The slug a hire's reports go under: its task, `review-<task>` for a Reviewer, the name itself for a lead. Null for the PM or any other name. */
export function reportSlug(name: string): string | null {
  const h = hireName(name);
  return !h ? null : h.role === "lead" ? name : h.reviewer ? `review-${h.task}` : h.task;
}

/** The report a file holds, or null when it is cut or of another shape. */
export function parseReport(text: string): Report | null {
  try {
    const r = JSON.parse(text);
    return typeof r?.kind === "string" && typeof r.slug === "string" && Number.isInteger(r.seq) && r.seq >= 1 && Number.isFinite(Date.parse(r.at)) ? { commit: null, note: null, ...r } : null;
  } catch {
    return null;
  }
}

/** The report in `file`, or null when it is missing, cut or of another shape. */
export function readReport(file: string): Report | null {
  try {
    return parseReport(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export type ReportDeps = { home: string; now: () => number };

/** Runs `f1rm report` in `cwd`: validates the words, then writes the file atomically with seq one above the old file's. */
export async function reportIn(argv: string[], cwd: string, deps: Partial<ReportDeps> = {}): Promise<Result> {
  const fail = (err: string): Result => ({ out: "", err, code: 1 });
  const [kind, slug, ...rest] = argv;
  if (!KINDS.includes(kind as any) || !SLUG.test(slug ?? "")) return fail(usage);
  let commit: string | null = null, note: string | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined || (rest[i] !== "--commit" && rest[i] !== "--note")) return fail(usage);
    if (rest[i] === "--commit") commit = value;
    else note = value.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;
  }
  if (commit !== null && !SHA.test(commit)) return fail(usage);
  const common = machine.gitCommonDir(cwd);
  if (!common) return fail("f1rm: not in a git repo");
  const home = deps.home ?? process.env.HOME!;
  const file = reportFile(home, basename(dirname(common)), slug);
  const report: Report = { kind, slug, commit, note, at: new Date((deps.now ?? Date.now)()).toISOString(), seq: (readReport(file)?.seq ?? 0) + 1 };
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(`${file}.tmp`, JSON.stringify(report, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
  return { out: `reported ${kind} ${slug} (report.json seq ${report.seq})\n`, err: "", code: 0 };
}
