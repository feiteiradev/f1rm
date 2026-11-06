// The office's scheduler: it reads each registered repo's issues and starts the session for a spec's next step (decision "The office starts every step").
// Only the user's own GitHub account steers it: an issue, or a label, by another account starts nothing (decision "Only the user steers the company").
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withEffort, withPonytail } from "../cli/hire.ts";
import { pacing, readUsage, usageFile, withUsageTap } from "../usage.ts";
import { repoKey } from "./board.ts";
import { machine } from "./machine.ts";
import { writePrivate } from "./private.ts";
import { SLEEP_GAP_MS, sleepGrace } from "./sleep.ts";

/** An open issue labelled `ready-for-agent`, as the scheduler needs it. */
export type Issue = { number: number; author: string; parent: boolean; subIssues: number; pr: boolean };
export type Step = "tickets";
/** The steps started per repo, by session name, so none starts twice. */
export type Started = Record<string, { at: number }>;

export type SchedulerDeps = {
  now: () => number;
  /** The login of the user's own GitHub account; null if gh can't say. */
  owner: () => Promise<string | null>;
  /** The repo's open issues labelled `ready-for-agent`; null if gh can't read them. */
  ready: (repo: string) => Promise<Issue[] | null>;
  /** Who added the issue's current `ready-for-agent` label; null if nobody did or gh can't say. */
  labeledBy: (repo: string, issue: number) => Promise<string | null>;
  /** Starts the step's background session in the repo; throws what refused it. */
  start: (repo: string, step: Step, spec: number) => Promise<void>;
  /** True while a usage hold stops every new start. */
  held: () => boolean;
  paused: (repo: string) => boolean;
  store: { load: (repo: string) => Started; save: (repo: string, started: Started) => void };
  /** True while the machine is just back from a sleep; defaults to the office's sleep rule. */
  resting?: (now: number) => boolean;
  everyMs?: number;
};

/** A spec is a ready issue that is no ticket (no parent) and has no tickets yet. */
const isSpec = (i: Issue) => !i.pr && !i.parent && i.subIssues === 0;

export function createScheduler(d: SchedulerDeps) {
  const resting = d.resting ?? sleepGrace(Math.max(SLEEP_GAP_MS, 2 * (d.everyMs ?? 0)));
  let ticking = false;
  return {
    async tick(repos: string[]) {
      const asleep = resting(d.now());
      if (ticking || asleep || !repos.length || d.held()) return;
      ticking = true;
      try {
        const me = await d.owner();
        if (!me) return;
        for (const repo of repos) {
          if (d.paused(repo)) continue;
          const issues = await d.ready(repo);
          if (!issues) continue;
          const started = d.store.load(repo);
          for (const i of issues.filter(isSpec)) {
            const name = `tickets-${i.number}`;
            // shortcut: a tickets step that ended without tickets is never started again; #90 adds one retry, then a decision ticket.
            if (started[name] || i.author !== me || (await d.labeledBy(repo, i.number)) !== me) continue;
            try {
              await d.start(repo, "tickets", i.number);
            } catch (err) {
              console.log(`scheduler ${basename(repo)}: ${name} not started: ${(err as Error).message}`);
              continue;
            }
            started[name] = { at: d.now() };
            d.store.save(repo, started);
            console.log(`scheduler ${basename(repo)}: started ${name}`);
          }
        }
      } finally {
        ticking = false;
      }
    },
  };
}

const PROMPTS: Record<Step, (spec: number) => string> = {
  tickets: (spec) =>
    `/mattpocock-skills:to-tickets #${spec}\n\n` +
    `You run the tickets step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `Publish your breakdown without asking: the breakdown is the company's call. ` +
    `Then comment the breakdown on #${spec} (each ticket's number, title and blockers), and end.`,
};

/** The `claude` argv that starts a step: a named background session in the repo itself, coordinating at medium effort. */
export const stepArgv = (step: Step, spec: number) => [
  "claude", "--bg", "--agent", "f1rm:step", "--name", `${step}-${spec}`, PROMPTS[step](spec),
  ...withUsageTap(withEffort("step", withPonytail("step", []))),
];

/** Runs `gh` in the repo, so `{owner}/{repo}` is its own remote; the trimmed output, or null on any failure. */
async function gh(repo: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000 });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

const schedulerFile = (home: string, repo: string) => join(home, ".f1rm", "scheduler", `${repoKey(repo)}.json`);

/** The real gh, Claude Code, usage file and disk; the server adds the pause. */
export function realSchedulerDeps(home: string): Omit<SchedulerDeps, "paused"> {
  let owner: string | null = null;
  return {
    now: Date.now,
    owner: async () => (owner ??= (await gh(home, ["api", "user", "--jq", ".login"])) || null),
    ready: async (repo) => {
      const out = await gh(repo, ["api", "repos/{owner}/{repo}/issues?labels=ready-for-agent&state=open&per_page=100"]);
      if (out === null) return null;
      try {
        return (JSON.parse(out) as any[]).map((i) => ({
          number: i.number,
          author: String(i.user?.login ?? ""),
          parent: !!i.parent_issue_url,
          subIssues: Number(i.sub_issues_summary?.total ?? 0),
          pr: !!i.pull_request,
        }));
      } catch {
        return null;
      }
    },
    labeledBy: async (repo, n) => {
      const jq = '[.[] | select(.event == "labeled" and .label.name == "ready-for-agent")] | last | .actor.login // empty';
      const out = await gh(repo, ["api", "--paginate", `repos/{owner}/{repo}/issues/${n}/timeline?per_page=100`, "--jq", jq]);
      return out?.split("\n").filter(Boolean).at(-1) ?? null;
    },
    start: async (repo, step, spec) => void (await machine.spawnBackground(stepArgv(step, spec), repo)),
    held: () => pacing(readUsage(usageFile(home), Date.now() / 1000), Date.now() / 1000).hold !== null,
    store: {
      load(repo) {
        try {
          const raw = JSON.parse(readFileSync(schedulerFile(home, repo), "utf8"));
          return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        } catch {
          return {};
        }
      },
      save(repo, started) {
        const file = schedulerFile(home, repo);
        mkdirSync(dirname(file), { recursive: true });
        writePrivate(`${file}.tmp`, JSON.stringify(started, null, 2) + "\n");
        renameSync(`${file}.tmp`, file);
      },
    },
  };
}
