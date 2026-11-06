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

/** An open issue labelled `ready-for-agent`, as the scheduler needs it: `parent` is the spec of a ticket, `subDone` a spec's closed tickets, `blockedBy` a ticket's open blockers. */
export type Issue = { number: number; author: string; parent: number | null; subIssues: number; subDone: number; blockedBy: number; pr: boolean };
export type Step = "tickets" | "implement" | "close";
/** The steps started per repo, by session name (`tries` starts, `asked` once a failure went to the user), so none starts twice; `decision-<n>` marks a decision ticket already announced. */
export type Started = Record<string, { at: number; tries?: number; asked?: boolean }>;
/** An open issue labelled `needs-decision`: `at` is when it opened (ms). */
export type DecisionIssue = { number: number; author: string; body: string; at: number; url: string };
/** A decision ticket as the office's tray shows it: `recommended` is an index into `options`, `step` the step that asked and starts again once it is answered (only for the `restart` options, when the ticket names some). */
export type Decision = { id: string; repo: string; number: number; url: string; question: string; options: string[]; recommended: number | null; restart: number[] | null; risk: "low" | "high"; step: string | null; spec: number | null; at: number };

export type SchedulerDeps = {
  now: () => number;
  /** The login of the user's own GitHub account; null if gh can't say. */
  owner: () => Promise<string | null>;
  /** The repo's open issues labelled `ready-for-agent`; null if gh can't read them. */
  ready: (repo: string) => Promise<Issue[] | null>;
  /** Who added the issue's current `label`; null if nobody did or gh can't say. */
  labeledBy: (repo: string, issue: number, label: string) => Promise<string | null>;
  /** Starts the step's background session in the repo (round 2: the one more round a failing acceptance criterion gets); throws what refused it. */
  start: (repo: string, step: Step, spec: number, round: number) => Promise<void>;
  /** True while a usage hold stops every new start. */
  held: () => boolean;
  paused: (repo: string) => boolean;
  /** The names of the repo's background sessions still running; null if Claude Code can't say. */
  live: (repo: string) => Promise<string[] | null>;
  store: { load: (repo: string) => Started; save: (repo: string, started: Started) => void };
  /** The repo's open issues labelled `needs-decision`; null if gh can't read them. */
  decisions: (repo: string) => Promise<DecisionIssue[] | null>;
  /** Raises a macOS notification. */
  notify: (title: string, text: string) => void;
  /** Opens a decision ticket in the repo. */
  open: (repo: string, title: string, body: string) => Promise<void>;
  /** Closes the decision ticket with the answer as its comment (throws what refused that), then takes its label off and writes the answer on its spec. */
  resolve: (repo: string, number: number, spec: number | null, answer: string) => Promise<void>;
  /** True while the machine is just back from a sleep; defaults to the office's sleep rule. */
  resting?: (now: number) => boolean;
  everyMs?: number;
};

/** A spec is a ready issue that is no ticket (no parent); it has tickets once the tickets step published them. */
const isSpec = (i: Issue) => !i.pr && i.parent === null;
/** A low-risk decision nobody answers takes its recommendation after this long. */
export const DEFAULT_AFTER_MS = 4 * 3_600_000;
const META = /<!--\s*f1rm:decision\b([^>]*?)-->/;
const OPTION = /^\s*\d+\.\s+(?=\S)/;
/** Reads a decision ticket's body: an HTML comment `<!-- f1rm:decision risk=low step=implement-7 spec=7 recommended=2 -->`, the question, then the options as a numbered list. A risk that is not `low` is high. */
export function decisionOf(body: string) {
  const meta = Object.fromEntries([...(META.exec(body)?.[1] ?? "").matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const lines = body.replace(META, "").trim().split("\n");
  const first = lines.findIndex((l) => OPTION.test(l));
  const options = lines.filter((l) => OPTION.test(l)).map((l) => l.replace(OPTION, "").trim());
  const rec = Number(meta.recommended);
  return {
    question: (first < 0 ? lines : lines.slice(0, first)).join("\n").trim(),
    options,
    recommended: Number.isInteger(rec) && rec >= 1 && rec <= options.length ? rec - 1 : null,
    restart: meta.restart ? meta.restart.split(",").map((x) => Number(x) - 1).filter((i) => i >= 0 && i < options.length) : null,
    risk: meta.risk === "low" ? ("low" as const) : ("high" as const),
    step: /^(?:tickets|implement|close)-\d+(?:-\d+)?$/.test(meta.step ?? "") ? meta.step! : null,
    spec: Number(meta.spec) || null,
  };
}

/** A step's session name: `implement-7`, and `implement-7-2` for its second round. */
export const stepName = (step: Step, spec: number, round = 1) => `${step}-${spec}${round > 1 ? `-${round}` : ""}`;

export function createScheduler(d: SchedulerDeps) {
  const resting = d.resting ?? sleepGrace(Math.max(SLEEP_GAP_MS, 2 * (d.everyMs ?? 0)));
  let ticking = false;
  let shown: Decision[] = [];
  // A tick and an answer each load a repo's store, await gh, then save it: they run one after the other, so neither saves over the other's change.
  let busy: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  };
  /** Writes the answer, and clears the asking step's record so the next tick starts it again by the usual rules. */
  async function settle(one: Decision, started: Started, option: number, answer = one.options[option]) {
    await d.resolve(one.repo, one.number, one.spec, answer);
    started[`answered-${one.number}`] = { at: d.now() };
    if (one.step && (!one.restart || one.restart.includes(option))) delete started[one.step];
    d.store.save(one.repo, started);
    console.log(`scheduler ${basename(one.repo)}: decision #${one.number} answered`);
  }
  /** Lists the repo's decision tickets by the owner, announces each new one once, and answers a low-risk one nobody answered in 4 hours with its recommendation (not while the project is paused). */
  async function decide(repo: string, me: string, started: Started, list: Decision[], paused: boolean) {
    const open = await d.decisions(repo);
    // A repo gh can't read keeps the tickets it showed.
    if (!open) return void list.push(...shown.filter((x) => x.repo === repo));
    for (const i of open) {
      if (i.author !== me || started[`answered-${i.number}`]) continue;
      // Checked once, before it is announced: a ticket another account labelled never shows.
      if (!started[`decision-${i.number}`] && (await d.labeledBy(repo, i.number, "needs-decision")) !== me) continue;
      const one: Decision = { id: `${repo}#${i.number}`, repo, number: i.number, url: i.url, ...decisionOf(i.body), at: i.at };
      if (!paused && one.risk === "low" && one.recommended !== null && d.now() - one.at >= DEFAULT_AFTER_MS) {
        await settle(one, started, one.recommended, `${one.options[one.recommended]} (no answer in 4 hours: the recommendation)`).catch((err) => console.log(`scheduler ${basename(repo)}: decision #${i.number} not answered: ${(err as Error).message}`));
        continue;
      }
      list.push(one);
      if (started[`decision-${i.number}`]) continue;
      d.notify(`f1rm: ${basename(repo)} needs a decision`, one.question.split("\n")[0]);
      started[`decision-${i.number}`] = { at: d.now() };
      d.store.save(repo, started);
    }
  }
  return {
    /** The open decision tickets of the repos the last tick read. */
    decisions: () => shown,
    /** The user's answer from the office: the option they picked, written onto the ticket. */
    answer: (id: string, option: number): Promise<{ ok: true } | { ok: false; error: string }> => exclusive(async () => {
      const one = shown.find((x) => x.id === id);
      if (!one) return { ok: false, error: "That decision is no longer open." };
      if (!Number.isInteger(option) || !one.options[option]) return { ok: false, error: "That decision has no such option." };
      try {
        await settle(one, d.store.load(one.repo), option);
      } catch (err) {
        return { ok: false, error: `GitHub refused the answer: ${(err as Error).message}` };
      }
      shown = shown.filter((x) => x !== one);
      return { ok: true as const };
    }),
    async tick(repos: string[]) {
      const asleep = resting(d.now());
      if (ticking || asleep || !repos.length) return;
      ticking = true;
      await exclusive(async () => {
        const me = await d.owner();
        if (!me) return;
        const held = d.held();
        const list: Decision[] = [];
        for (const repo of repos) {
          const started = d.store.load(repo);
          const paused = d.paused(repo);
          await decide(repo, me, started, list, paused);
          if (held || paused) continue;
          const issues = await d.ready(repo);
          const live = issues && (await d.live(repo));
          if (!issues || !live) continue;
          const owned = async (i: Issue) => i.author === me && (await d.labeledBy(repo, i.number, "ready-for-agent")) === me;
          // shortcut: a step that ended without moving its spec on is never started again; #90 adds one retry, then a decision ticket.
          const startOnce = async (step: Step, spec: number, round = 1, tries = 1) => {
            const name = stepName(step, spec, round);
            try {
              await d.start(repo, step, spec, round);
            } catch (err) {
              return console.log(`scheduler ${basename(repo)}: ${name} not started: ${(err as Error).message}`);
            }
            started[name] = { at: d.now(), tries };
            d.store.save(repo, started);
            console.log(`scheduler ${basename(repo)}: started ${name}${tries > 1 ? " again" : ""}`);
          };
          // A step that ended while what it was for is still there failed: it starts once more, then the user is asked. One waiting on a decision ticket has not failed.
          const again = async (step: Step, spec: number, round = 1) => {
            const name = stepName(step, spec, round);
            const rec = started[name];
            if (rec.asked || list.some((x) => x.repo === repo && x.step === name)) return;
            if ((rec.tries ?? 1) < 2) return startOnce(step, spec, round, (rec.tries ?? 1) + 1);
            const title = `${name} ended twice without moving spec #${spec} on`;
            const body = `<!-- f1rm:decision risk=high step=${name} spec=${spec} recommended=1 restart=1 -->\n${title}. Its last words are in \`claude logs\` for ${name}, and the office's log says when it started.\n\n1. Retry it\n2. Leave it to me\n`;
            try {
              await d.open(repo, title, body);
            } catch (err) {
              return console.log(`scheduler ${basename(repo)}: could not ask about ${name}: ${(err as Error).message}`);
            }
            rec.asked = true;
            d.store.save(repo, started);
          };
          for (const spec of issues.filter(isSpec)) {
            const n = spec.number;
            if (!spec.subIssues) {
              if (!started[`tickets-${n}`]) {
                if (await owned(spec)) await startOnce("tickets", n);
              } else if (!live.includes(`tickets-${n}`)) await again("tickets", n);
              continue;
            }
            // Only a spec whose tickets the office published is built by it: one ticketed by hand is the user's to drive. One step of a spec runs at a time.
            const mine = new RegExp(`^(?:tickets|implement|close)-${n}(?:-\\d+)?$`);
            if (!started[`tickets-${n}`] || live.some((name) => mine.test(name))) continue;
            // A failing acceptance criterion becomes a ticket at the first close, which gets one more round; tickets left after the last close are the user's.
            const open = spec.subDone < spec.subIssues;
            const round = started[stepName("close", n)] && (open || started[stepName("implement", n, 2)]) ? 2 : 1;
            const implement = stepName("implement", n, round), close = stepName("close", n, round);
            if (!open) {
              if (!started[implement]) continue;
              if (!started[close]) {
                if (await owned(spec)) await startOnce("close", n, round);
              } else await again("close", n, round);
              continue;
            }
            if (round === 2 && started[close]) continue;
            const unblocked = issues.filter((t) => t.parent === n && !t.pr && t.blockedBy === 0 && t.author === me);
            if (!unblocked.length || !(await owned(spec))) continue;
            for (const t of unblocked) if ((await d.labeledBy(repo, t.number, "ready-for-agent")) === me) {
              await (started[implement] ? again("implement", n, round) : startOnce("implement", n, round));
              break;
            }
          }
        }
        shown = list;
      }).finally(() => (ticking = false));
    },
  };
}

const PROMPTS: Record<Step, (spec: number, round: number) => string> = {
  tickets: (spec) =>
    `/mattpocock-skills:to-tickets #${spec}\n\n` +
    `You run the tickets step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `Publish your breakdown without asking: the breakdown is the company's call. ` +
    `Then comment the breakdown on #${spec} (each ticket's number, title and blockers), and end.`,
  implement: (spec) =>
    `/mattpocock-skills:implement-spec #${spec}\n\n` +
    `You run the implement step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `The integration branch is spec-${spec} (create it from main if it does not exist yet); each ticket's branch is ticket-<number>. ` +
    `Start every implementer and merger with the Agent tool and isolation: "worktree", and run the mergers one at a time. ` +
    `Tell each of them to spell git as /usr/bin/git, as the first word of its own Bash call, with no cd, no -C and no chaining (a plain git is rewritten by the user's shell hook), and to start its branch with /usr/bin/git checkout -b ticket-<number> spec-${spec} (the gate refuses checkout -B and switch -C). ` +
    `After the code review of spec-${spec}, fix every finding it raised in one implementer, as the skill says, before you end. ` +
    `Open no pull request: close each ticket with a comment naming its merge commit on spec-${spec}. ` +
    `Leave main alone: the office's close step lands spec-${spec}. ` +
    `End when every ticket is closed, or when none can go on: then say why in a comment on #${spec}.`,
  close: (spec, round) =>
    `You run the close step of spec #${spec}, started by the office, and nobody is in this session${round > 1 ? "; this is its last round" : ""}.\n` +
    `1. Read the acceptance criteria of #${spec}. Check each one once on spec-${spec}, in a scratch worktree (/usr/bin/git worktree add .claude/worktrees/close-${spec} spec-${spec}), never in the main checkout; then remove that worktree.\n` +
    (round > 1
      ? `2. This is the last round: a criterion that still fails is listed as open in your closing comment; open no ticket.\n`
      : `2. If a criterion fails, open one ticket per failing criterion with gh issue create --parent ${spec} --label ready-for-agent (what to build, and its check), comment on #${spec} which criteria failed, and end: the office builds them and starts this step again.\n`) +
    `3. Land: run f1rm merge spec-${spec} in the main working directory. If it refuses, comment its message on #${spec} and end.\n` +
    `4. Push: run f1rm push. If it refuses, say why in your closing comment.\n` +
    `5. Clean up: /usr/bin/git branch -d spec-${spec}, then /usr/bin/git branch -d for each ticket-<number> of its tickets and each worktree-agent-* branch that git branch --merged lists (git keeps any a worktree still uses).\n` +
    `6. Close the spec: gh issue close ${spec} --comment with the merge commit, pushed or not (and why), and any criterion still open. Then end.`,
};

/** The `claude` argv that starts a step: a named background session in the repo itself, coordinating at medium effort. */
export const stepArgv = (step: Step, spec: number, round = 1) => [
  "claude", "--bg", "--agent", "f1rm:step", "--name", stepName(step, spec, round), `${PROMPTS[step](spec, round)}\n\nThis step is ${stepName(step, spec, round)}.`,
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
      // shortcut: one page of 100 open issues, tickets included; page through them if a repo ever holds more.
      const out = await gh(repo, ["api", "repos/{owner}/{repo}/issues?labels=ready-for-agent&state=open&per_page=100"]);
      if (out === null) return null;
      try {
        return (JSON.parse(out) as any[]).map((i) => ({
          number: i.number,
          author: String(i.user?.login ?? ""),
          parent: Number(/\/issues\/(\d+)$/.exec(String(i.parent_issue_url ?? ""))?.[1]) || null,
          subIssues: Number(i.sub_issues_summary?.total ?? 0),
          subDone: Number(i.sub_issues_summary?.completed ?? 0),
          blockedBy: Number(i.issue_dependencies_summary?.blocked_by ?? 0),
          pr: !!i.pull_request,
        }));
      } catch {
        return null;
      }
    },
    labeledBy: async (repo, n, label) => {
      const jq = `[.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)})] | last | .actor.login // empty`;
      const out = await gh(repo, ["api", "--paginate", `repos/{owner}/{repo}/issues/${n}/timeline?per_page=100`, "--jq", jq]);
      return out?.split("\n").filter(Boolean).at(-1) ?? null;
    },
    decisions: async (repo) => {
      // shortcut: one page of 100 open decision tickets, as for the ready issues.
      const out = await gh(repo, ["api", "repos/{owner}/{repo}/issues?labels=needs-decision&state=open&per_page=100"]);
      if (out === null) return null;
      try {
        return (JSON.parse(out) as any[]).filter((i) => !i.pull_request).map((i) => ({ number: i.number, author: String(i.user?.login ?? ""), body: String(i.body ?? ""), at: Date.parse(i.created_at), url: String(i.html_url ?? "") }));
      } catch {
        return null;
      }
    },
    notify: (title, text) => {
      const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
      try {
        Bun.spawn(["osascript", "-e", `display notification ${q(text)} with title ${q(title)}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      } catch {
        // a notification that can't show is no reason to stop the tick
      }
    },
    open: async (repo, title, body) => {
      if ((await gh(repo, ["label", "create", "needs-decision", "--force", "--description", "A question only the user answers, in the office's tray"])) === null) throw new Error("gh label create needs-decision failed");
      if ((await gh(repo, ["issue", "create", "--label", "needs-decision", "--title", title, "--body", body])) === null) throw new Error("gh issue create failed");
    },
    // The close carries the answer, so a retry after a failure never writes it twice; the label and the spec's note are best effort after it.
    resolve: async (repo, n, spec, answer) => {
      if ((await gh(repo, ["issue", "close", String(n), "--comment", `Answered in the office: ${answer}`])) === null) throw new Error(`gh issue close #${n} failed`);
      for (const args of [["issue", "edit", String(n), "--remove-label", "needs-decision"], ...(spec ? [["issue", "comment", String(spec), "--body", `Decision #${n}: ${answer}`]] : [])]) {
        if ((await gh(repo, args)) === null) console.log(`scheduler ${basename(repo)}: gh ${args.slice(0, 2).join(" ")} #${args[2]} failed after decision #${n} was answered`);
      }
    },
    start: async (repo, step, spec, round) => void (await machine.spawnBackground(stepArgv(step, spec, round), repo)),
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
