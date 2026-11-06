// The office's scheduler: it reads each registered repo's issues and starts the session for a spec's next step (decision "The office starts every step").
// Only the user's own GitHub account steers it: an issue, or a label, by another account starts nothing (decision "Only the user steers the company").
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withEffort, withPonytail } from "../cli/hire.ts";
import { repoOf } from "../cli/letgo.ts";
import { pacing, readUsage, usageFile, withUsageTap } from "../usage.ts";
import { repoKey } from "./board.ts";
import { machine } from "./machine.ts";
import { writePrivate } from "./private.ts";
import { SLEEP_GAP_MS, sleepGrace } from "./sleep.ts";

/** An open issue labelled `ready-for-agent`, as the scheduler needs it: `parent` is the spec of a ticket, `blockedBy` its open blockers. */
export type Issue = { number: number; author: string; parent: number | null; subIssues: number; blockedBy: number; pr: boolean };
export type Step = "tickets" | "implement";
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
  /** The names of the repo's background sessions still running; null if Claude Code can't say. */
  live: (repo: string) => Promise<string[] | null>;
  store: { load: (repo: string) => Started; save: (repo: string, started: Started) => void };
  /** True while the machine is just back from a sleep; defaults to the office's sleep rule. */
  resting?: (now: number) => boolean;
  everyMs?: number;
};

/** A spec is a ready issue that is no ticket (no parent); it has tickets once the tickets step published them. */
const isSpec = (i: Issue) => !i.pr && i.parent === null;

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
          const live = issues && (await d.live(repo));
          if (!issues || !live) continue;
          const started = d.store.load(repo);
          const owned = async (i: Issue) => i.author === me && (await d.labeledBy(repo, i.number)) === me;
          // shortcut: a step that ended without moving its spec on is never started again; #90 adds one retry, then a decision ticket.
          const startOnce = async (step: Step, spec: number) => {
            const name = `${step}-${spec}`;
            try {
              await d.start(repo, step, spec);
            } catch (err) {
              return console.log(`scheduler ${basename(repo)}: ${name} not started: ${(err as Error).message}`);
            }
            started[name] = { at: d.now() };
            d.store.save(repo, started);
            console.log(`scheduler ${basename(repo)}: started ${name}`);
          };
          for (const spec of issues.filter(isSpec)) {
            const n = spec.number;
            if (!spec.subIssues) {
              if (!started[`tickets-${n}`] && (await owned(spec))) await startOnce("tickets", n);
              continue;
            }
            // Only a spec whose tickets the office published is built by it: one ticketed by hand is the user's to drive.
            if (started[`implement-${n}`] || !started[`tickets-${n}`] || live.includes(`tickets-${n}`)) continue;
            const unblocked = issues.filter((t) => t.parent === n && !t.pr && t.blockedBy === 0 && t.author === me);
            if (!unblocked.length || !(await owned(spec))) continue;
            for (const t of unblocked) if ((await d.labeledBy(repo, t.number)) === me) {
              await startOnce("implement", n);
              break;
            }
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
  implement: (spec) =>
    `/mattpocock-skills:implement-spec #${spec}\n\n` +
    `You run the implement step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `The integration branch is spec-${spec}, created from main; each ticket's branch is ticket-<number>. ` +
    `Start every implementer and merger with the Agent tool and isolation: "worktree", and run the mergers one at a time. ` +
    `Tell each of them to spell git as /usr/bin/git, as the first word of its own Bash call, with no cd, no -C and no chaining (a plain git is rewritten by the user's shell hook). ` +
    `Open no pull request: close each ticket with a comment naming its merge commit on spec-${spec}. ` +
    `Leave main alone: the office's close step lands spec-${spec}. ` +
    `End when every ticket is closed, or when none can go on: then say why in a comment on #${spec}.`,
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
          parent: Number(/\/issues\/(\d+)$/.exec(String(i.parent_issue_url ?? ""))?.[1]) || null,
          subIssues: Number(i.sub_issues_summary?.total ?? 0),
          blockedBy: Number(i.issue_dependencies_summary?.blocked_by ?? 0),
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
    // shortcut: a session is live until Claude Code calls it done or failed; read its process too if a crashed one lingers as working.
    live: async (repo) => (await machine.backgroundSessions())?.filter((a) => repoOf(a.cwd) === repo && a.state !== "done" && a.state !== "failed").map((a) => a.name) ?? null,
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
