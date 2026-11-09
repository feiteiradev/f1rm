// The office's scheduler: it reads each registered repo's issues and starts the session for a spec's next step (decision "The office starts every step").
// Only the user's own GitHub account steers it: an issue, or a label, by another account starts nothing (decision "Only the user steers the company").
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readRoles, withEffort, withPonytail } from "../cli/hire.ts";
import { repoOf } from "../cli/letgo.ts";
import { endedBefore, tail } from "../cli/status.ts";
import { transcriptFile } from "../cli/wake.ts";
import { pacing, readUsage, usageFile, withUsageTap } from "../usage.ts";
import { repoKey, type BoardRow } from "./board.ts";
import { MEASURED, budgetOf, costUnits, repoBudgets, specCosts, specOfStep, type Size, type SpecCost } from "../cost.ts";
import { editionFile, readEdition } from "./editions.ts";
import { FOUNDER_ONLY, ROLE_IDS, roleOfAgentType } from "../people.ts";
import { agents, machine } from "./machine.ts";
import { writePrivate } from "./private.ts";
import { SLEEP_GAP_MS, sleepGrace } from "./sleep.ts";

/** An open issue labelled `ready-for-agent`, as the scheduler needs it: `parent` is the spec of a ticket, `subDone` a spec's closed tickets, `blockedBy` a ticket's open blockers. */
export type Issue = { number: number; title: string; author: string; parent: number | null; subIssues: number; subDone: number; blockedBy: number; pr: boolean };
/** A spec's ticket, open or closed, as the whiteboard shows it. */
export type TicketIssue = { number: number; title: string; state: "open" | "closed"; blockedBy: number; labels: string[] };
export type Step = "tickets" | "implement" | "close";
/** The steps started per repo, by session name (`tries` starts, `done` the spec's closed tickets at the last one, `asked` once a failure went to the user), so none starts twice; `decision-<n>` marks a decision ticket already announced, and `budget-<n>` is ticket n's budget (`factor` its raises, `asked` once it went to the user). */
export type Started = Record<string, { at: number; tries?: number; asked?: boolean; done?: number; factor?: number; unlimited?: boolean }>;
/** An open issue labelled `needs-decision`: `at` is when it opened (ms). */
export type DecisionIssue = { number: number; author: string; body: string; at: number; url: string };
/** A decision ticket as the office's tray shows it: `recommended` is an index into `options`, `step` the step that asked and starts again once it is answered (only for the `restart` options, when the ticket names some); a `drop` option closes the spec, a `ready` option labels it ready-for-agent (a retro's proposal is a draft spec), a `raise` option lifts the `ticket`'s limit. */
export type Decision = { id: string; repo: string; number: number; url: string; question: string; options: string[]; recommended: number | null; restart: number[] | null; drop: number[] | null; ready: number[] | null; raise: number[] | null; ticket: number | null; risk: "low" | "high"; step: string | null; spec: number | null; at: number };

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
  /** A spec's tickets, open and closed; null if gh can't read them. */
  tickets: (repo: string, spec: number) => Promise<TicketIssue[] | null>;
  /** Each spec's cost in the repo (see office/cost.ts), with the tickets' sizes. */
  costs: (repo: string) => Record<number, SpecCost>;
  /** The repo's open issues labelled `needs-decision`; null if gh can't read them. */
  decisions: (repo: string) => Promise<DecisionIssue[] | null>;
  /** Raises a macOS notification. */
  notify: (title: string, text: string) => void;
  /** Labels a draft spec `ready-for-agent`, so the office builds it. */
  approve: (repo: string, spec: number) => Promise<void>;
  /** Closes the spec as not planned. */
  drop: (repo: string, spec: number) => Promise<void>;
  /** Stops the repo's background session of this name (`claude stop`, which keeps its conversation). */
  stop: (repo: string, name: string) => Promise<void>;
  /** The session ids of the repo's office steps that Claude Code calls done or failed; null if it can't say. */
  ended: (repo: string) => Promise<string[] | null>;
  /** Stops a background session by its session id (`claude stop`, which keeps its conversation). */
  release: (id: string) => Promise<void>;
  /** Opens a decision ticket in the repo. */
  open: (repo: string, title: string, body: string) => Promise<void>;
  /** Closes the decision ticket with the answer as its comment (throws what refused that), then takes its label off and writes the answer on its spec. */
  resolve: (repo: string, number: number, spec: number | null, answer: string) => Promise<void>;
  /** True while the machine is just back from a sleep; defaults to the office's sleep rule. */
  resting?: (now: number) => boolean;
  everyMs?: number;
};

/** An issue's spec: its native parent, else the one its text names (`## Parent` then `#5`, or `Part of #5`, as the tracker doc writes it without sub-issues). A ticket the tickets step forgot to link is still a ticket, never a spec. */
export function parentOf(i: { parent_issue_url?: string | null; body?: string | null }): number | null {
  const native = Number(/\/issues\/(\d+)$/.exec(String(i.parent_issue_url ?? ""))?.[1]);
  if (native) return native;
  const named = /^## Parent\s+#(\d+)/m.exec(String(i.body ?? "")) ?? /^Part of #(\d+)/m.exec(String(i.body ?? ""));
  return named ? Number(named[1]) : null;
}

/** A spec is a ready issue that is no ticket (no parent); it has tickets once the tickets step published them. */
const isSpec = (i: Issue) => !i.pr && i.parent === null;
/** A low-risk decision nobody answers takes its recommendation after this long. */
export const DEFAULT_AFTER_MS = 4 * 3_600_000;
/** A step's session name: `tickets-7`, `implement-7-2`. */
const STEP_NAME = /^(?:tickets|implement|close)-\d+(?:-\d+)?$/;
/** The office's steps in `repo` whose last turn ended: Claude Code keeps a done session's process alive to be attached to, until it is stopped. */
type Listed = { sessionId?: string; name: string; state: string; cwd: string };
/** `stale`: one Claude Code still calls working whose transcript ended its turn long ago. */
export const endedSteps = (sessions: Listed[], repo: string, repoOf: (cwd: string) => string, stale: (a: Listed) => boolean = () => false) =>
  sessions.filter((a) => (a.state === "done" || a.state === "failed" || stale(a)) && STEP_NAME.test(a.name) && repoOf(a.cwd) === repo && a.sessionId).map((a) => a.sessionId!);
/** A step whose transcript has shown a finished turn for this long has ended, whatever Claude Code's list says. */
const STALE_MS = 10 * 60_000;
const META = /<!--\s*f1rm:decision\b([^>]*?)-->/;
const OPTION = /^\s*\d+\.\s+(?=\S)/;
/** `restart=1,3` as indices into the options; null when the header has no such field. */
const indices = (field: string | undefined, count: number) => (field ? field.split(",").map((x) => Number(x) - 1).filter((i) => i >= 0 && i < count) : null);
/** A failed step is judged only this long after it started: `claude agents` may not list a session that has just been started. */
const GRACE_MS = 3 * 60_000;
/** A step that ended twice without moving its spec on is not started a third time: the user is asked. */
const MAX_TRIES = 2;
/** Reads a decision ticket's body: an HTML comment `<!-- f1rm:decision risk=low step=implement-7 spec=7 recommended=2 -->`, the question, then the options as a numbered list. A risk that is not `low` is high. */
export function decisionOf(body: string) {
  const meta = Object.fromEntries([...(META.exec(body)?.[1] ?? "").matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const lines = body.replace(META, "").trim().split("\n");
  const first = lines.findIndex((l) => OPTION.test(l));
  const options = lines.filter((l) => OPTION.test(l)).map((l) => l.replace(OPTION, "").trim());
  const rec = Number(meta.recommended);
  const worded = options.flatMap((o, i) => (/^drop the spec\b/i.test(o) ? [i] : []));
  return {
    question: (first < 0 ? lines : lines.slice(0, first)).join("\n").trim(),
    options,
    recommended: Number.isInteger(rec) && rec >= 1 && rec <= options.length ? rec - 1 : null,
    restart: indices(meta.restart, options.length),
    // A step that wrote "Drop the spec" but no drop= still means it: the user's answer must do what its words say.
    drop: indices(meta.drop, options.length) ?? (worded.length ? worded : null),
    ready: indices(meta.ready, options.length),
    raise: indices(meta.raise, options.length),
    ticket: Number(meta.ticket) || null,
    risk: meta.risk === "low" ? ("low" as const) : ("high" as const),
    step: STEP_NAME.test(meta.step ?? "") ? meta.step! : null,
    spec: Number(meta.spec) || null,
  };
}

/** A step's session name: `implement-7`, and `implement-7-2` for its second round. */
const inK = (units: number) => `${Math.round(units / 1000).toLocaleString("en-US")}k`;
/** A repo's specs with their tickets, the cost of each, and the tickets' sizes, as the whiteboard and the budget check read them. */
type Board = { rows: BoardRow[]; lists: [Issue, TicketIssue[]][]; costs: Record<number, SpecCost>; sizes: Record<number, Size>; base: Record<Size, number> };

export const stepName = (step: Step, spec: number, round = 1) => `${step}-${spec}${round > 1 ? `-${round}` : ""}`;

export function createScheduler(d: SchedulerDeps) {
  const resting = d.resting ?? sleepGrace(Math.max(SLEEP_GAP_MS, 2 * (d.everyMs ?? 0)));
  let ticking = false;
  let shown: Decision[] = [];
  let walls: Record<string, BoardRow[]> = {};
  const budget = (started: Started, sizes: Record<number, Size>, n: number, base: Record<Size, number>) => (started[`budget-${n}`]?.unlimited ? Infinity : budgetOf(sizes[n], started[`budget-${n}`]?.factor, base));
  /** The whiteboard of a repo's live specs: a row per spec (the step at work, its total and coordination share) and a row per ticket (state, role, cost, over its budget). */
  async function issueBoard(repo: string, specs: Issue[], live: string[], started: Started): Promise<Board | null> {
    const lists: [Issue, TicketIssue[]][] = [];
    for (const spec of specs) {
      const tickets = spec.subIssues ? await d.tickets(repo, spec.number) : [];
      if (!tickets) return null;
      lists.push([spec, tickets]);
    }
    const sizes: Record<number, Size> = {};
    for (const [, tickets] of lists) for (const t of tickets) for (const l of t.labels) if (/^size:[sml]$/.test(l)) sizes[t.number] = l.slice(5) as Size;
    const costs = d.costs(repo);
    const open = new Set(lists.flatMap(([, tickets]) => tickets.filter((t) => t.state !== "closed").map((t) => t.number)));
    const base = repoBudgets(Object.values(costs).flatMap((c) => Object.entries(c.tickets).filter(([t]) => !open.has(Number(t))).map(([, t]) => costUnits(t))));
    const rows = lists.flatMap(([spec, tickets]) => {
      const n = spec.number;
      const step = live.find((name) => specOfStep(name) === n);
      const cost = costs[n];
      const building = !!step?.startsWith("implement-");
      return [
        { id: `#${n}`, owner: step ?? "spec", status: step ? "doing" : "todo", branch: `spec-${n}`, task: cost ? `${spec.title} · ${inK(cost.total)} cost units, ${Math.round(cost.share * 100)}% coordination` : spec.title },
        ...tickets.map((t) => {
          const spent = cost?.tickets[t.number];
          return {
            id: `#${t.number}`,
            owner: t.labels.find((l) => l.startsWith("role:")) ?? "intern",
            status: t.state === "closed" ? "done" : t.blockedBy > 0 ? "blocked" : building ? "doing" : "todo",
            branch: `ticket-${t.number}`,
            task: `${t.title}${spent ? ` · ${inK(costUnits(spent))} cost units` : ""}${spent && costUnits(spent) > budget(started, sizes, t.number, base) ? " · over its budget" : ""}`,
          };
        }),
      ];
    });
    return { rows, lists, costs, sizes, base };
  }
  // A tick and an answer each load a repo's store, await gh, then save it: they run one after the other, so neither saves over the other's change.
  let busy: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  };
  /** Writes the answer, and clears the asking step's record so the next tick starts it again by the usual rules. */
  async function settle(one: Decision, started: Started, option: number, answer = one.options[option]) {
    // A proposal is made ready before the answer is written: when GitHub refuses, the decision stays open.
    if (one.spec && one.ready?.includes(option)) await d.approve(one.repo, one.spec);
    await d.resolve(one.repo, one.number, one.spec, answer);
    started[`answered-${one.number}`] = { at: d.now() };
    if (one.step && (!one.restart || one.restart.includes(option))) {
      delete started[one.step];
      // A tickets step that asked about its preview has published its tickets: the mark starts it again though they exist.
      if (one.step.startsWith("tickets-")) started[`again-${one.step}`] = { at: d.now() };
    }
    // Let it finish: the ticket has no limit any more, so it is never asked about twice.
    if (one.ticket && one.raise?.includes(option)) started[`budget-${one.ticket}`] = { at: d.now(), unlimited: true };
    if (one.spec && one.drop?.includes(option)) await d.drop(one.repo, one.spec).catch((err) => console.log(`scheduler ${basename(one.repo)}: spec #${one.spec} not dropped: ${(err as Error).message}`));
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
  /** A ticket past its measured budget while the implement step builds it: the office asks the user, once per budget, and stops that step; only the answer starts it again. */
  async function overBudget(repo: string, started: Started, board: Board, live: string[]) {
    for (const [spec, tickets] of board.lists) {
      const step = live.find((name) => specOfStep(name) === spec.number && name.startsWith("implement-"));
      if (!step) continue;
      for (const t of tickets) {
        const size = board.sizes[t.number] ?? "m";
        const prior = started[`budget-${t.number}`];
        const spent = board.costs[spec.number]?.tickets[t.number];
        const limit = budget(started, board.sizes, t.number, board.base);
        if (t.state !== "open" || !MEASURED.includes(size) || prior?.asked || !spent || costUnits(spent) <= limit) continue;
        const title = `Ticket #${t.number} is over its budget`;
        const body = `<!-- f1rm:decision risk=high step=${step} spec=${spec.number} recommended=1 restart=1 raise=1 ticket=${t.number} drop=3 -->\n${title}: it has spent ${inK(costUnits(spent))} cost units of its ${inK(limit)} (size ${size}). The office stopped ${step}. Give it more?\n\n1. Let it finish: no limit for this ticket\n2. I'll re-scope it\n3. Drop the spec\n`;
        try {
          await d.open(repo, title, body);
        } catch (err) {
          console.log(`scheduler ${basename(repo)}: ticket #${t.number} over budget, not asked: ${(err as Error).message}`);
          continue;
        }
        // Asked, the step never starts again by itself: Let it finish clears it, re-scoping leaves it to the user.
        started[`budget-${t.number}`] = { at: d.now(), factor: prior?.factor ?? 1, asked: true };
        started[step] = { ...started[step], at: started[step]?.at ?? d.now(), asked: true };
        d.store.save(repo, started);
        await d.stop(repo, step).then(
          () => console.log(`scheduler ${basename(repo)}: ${step} stopped, ticket #${t.number} over budget`),
          (err) => console.log(`scheduler ${basename(repo)}: ticket #${t.number} over budget, ${step} not stopped: ${(err as Error).message}`),
        );
        return; // the step is stopped: its other tickets wait for the answer
      }
    }
  }
  return {
    /** The open decision tickets of the repos the last tick read. */
    decisions: () => shown,
    /** Each repo's whiteboard, from its issues, as the last tick read them. */
    boards: () => walls,
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
        // A repo the tick does not read this time keeps the whiteboard it had.
        const nextWalls: Record<string, BoardRow[]> = Object.fromEntries(repos.filter((r) => walls[r]).map((r) => [r, walls[r]]));
        for (const repo of repos) {
          const started = d.store.load(repo);
          const paused = d.paused(repo);
          await decide(repo, me, started, list, paused);
          for (const id of (await d.ended(repo)) ?? []) await d.release(id).catch((err) => console.log(`scheduler ${basename(repo)}: ${id} not stopped: ${(err as Error).message}`));
          const issues = await d.ready(repo);
          const live = issues && (await d.live(repo));
          if (!issues || !live) continue;
          const board = await issueBoard(repo, issues.filter(isSpec), live, started);
          if (board) nextWalls[repo] = board.rows;
          if (board && !paused) await overBudget(repo, started, board, live);
          if (held || paused) continue;
          const owned = async (i: Issue) => i.author === me && (await d.labeledBy(repo, i.number, "ready-for-agent")) === me;
          const startOnce = async (step: Step, spec: Issue, round = 1, tries = 1) => {
            const name = stepName(step, spec.number, round);
            try {
              await d.start(repo, step, spec.number, round);
            } catch (err) {
              return console.log(`scheduler ${basename(repo)}: ${name} not started: ${(err as Error).message}`);
            }
            started[name] = { at: d.now(), tries, done: spec.subDone };
            d.store.save(repo, started);
            console.log(`scheduler ${basename(repo)}: started ${name}${tries > 1 ? " again" : ""}`);
          };
          // A step that ended while what it was for is still there failed: it starts once more (a closed ticket since its start counts as progress, not a failure), then the user is asked. One waiting on a decision ticket it opened has not failed.
          const retryOrAsk = async (step: Step, spec: Issue, round = 1) => {
            const name = stepName(step, spec.number, round);
            const rec = started[name];
            if (d.now() - rec.at < GRACE_MS || rec.asked || list.some((x) => x.repo === repo && x.step === name) || !(await owned(spec))) return;
            const tries = rec.done !== undefined && spec.subDone > rec.done ? 0 : (rec.tries ?? 1);
            if (tries < MAX_TRIES) return startOnce(step, spec, round, tries + 1);
            const title = `${name} ended twice without moving spec #${spec.number} on`;
            const body = `<!-- f1rm:decision risk=high step=${name} spec=${spec.number} recommended=1 restart=1 drop=2 -->\n${title}. Its last words are in \`claude logs\` for ${name}, and the office's log says when it started.\n\n1. Retry it\n2. Drop the spec\n3. Leave it to me\n`;
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
                if (await owned(spec)) await startOnce("tickets", spec);
              } else if (!live.includes(`tickets-${n}`)) await retryOrAsk("tickets", spec);
              continue;
            }
            if (started[`again-tickets-${n}`] && !started[`tickets-${n}`]) {
              if (await owned(spec)) await startOnce("tickets", spec);
              if (started[`tickets-${n}`]) {
                delete started[`again-tickets-${n}`];
                d.store.save(repo, started);
              }
              continue;
            }
            // Only a spec whose tickets the office published is built by it: one ticketed by hand is the user's to drive. One step of a spec runs at a time.
            if (!started[`tickets-${n}`] || live.some((name) => specOfStep(name) === n)) continue;
            // A failing acceptance criterion becomes a ticket at the first close, which gets one more round; tickets left after the last close are the user's.
            const unfinished = spec.subDone < spec.subIssues;
            const round = started[stepName("close", n)] && (unfinished || started[stepName("implement", n, 2)]) ? 2 : 1;
            const implement = stepName("implement", n, round), close = stepName("close", n, round);
            if (!unfinished) {
              if (!started[implement]) continue;
              if (!started[close]) {
                if (await owned(spec)) await startOnce("close", spec, round);
              } else await retryOrAsk("close", spec, round);
              continue;
            }
            if (round === 2 && started[close]) continue;
            if (started[implement]) {
              await retryOrAsk("implement", spec, round);
              continue;
            }
            const unblocked = issues.filter((t) => t.parent === n && !t.pr && t.blockedBy === 0 && t.author === me);
            if (!unblocked.length || !(await owned(spec))) continue;
            for (const t of unblocked) if ((await d.labeledBy(repo, t.number, "ready-for-agent")) === me) {
              await startOnce("implement", spec, round);
              break;
            }
          }
        }
        shown = list;
        walls = nextWalls;
      }).finally(() => (ticking = false));
    },
  };
}

/** The role files that are no ticket's role: the advisor tests a decision for a step and fresh-eyes previews a spec's tickets; they build nothing. */
const NOT_TICKET_ROLES = ["advisor", "fresh-eyes"];
/** The roles a ticket's `role:<name>` label can name, with their skills, read from the role files, the one place they are kept. A Founder role only in a Founder project. */
export const roleSkills = (founder: boolean): Record<string, string[]> =>
  Object.fromEntries(
    readRoles()
      .filter((r) => !NOT_TICKET_ROLES.includes(r.id) && (founder || !FOUNDER_ONLY.has(roleOfAgentType(`f1rm:${r.id}`)!)))
      .sort((a, b) => ROLE_IDS.indexOf(roleOfAgentType(`f1rm:${a.id}`)!) - ROLE_IDS.indexOf(roleOfAgentType(`f1rm:${b.id}`)!))
      .map((r) => [r.id, r.skills]),
  );
const roleMapText = (founder: boolean) =>
  [...Object.entries(roleSkills(founder)).map(([id, skills]) => `role:${id} → ${skills.join(", ")}`), "no role label → mattpocock-skills:tdd"].join("; ");

/** f1rm's own GitHub repo (`owner/name`) from the checkout the office runs from, where a retro files changes to f1rm itself; null when git can't say. */
const F1RM_REPO = (() => {
  const url = Bun.spawnSync(["git", "-C", join(import.meta.dir, "..", ".."), "remote", "get-url", "origin"]).stdout.toString().trim();
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
})();

const PROMPTS: Record<Step, (spec: number, round: number, founder: boolean) => string> = {
  tickets: (spec, _round, founder) =>
    `/mattpocock-skills:to-tickets #${spec}\n\n` +
    `You run the tickets step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `Publish your breakdown without asking: the breakdown is the company's call. ` +
    `Make each ticket a sub-issue of #${spec} (gh issue create --parent ${spec}, or gh issue edit ${spec} --add-sub-issue <ticket> after), then check that #${spec} lists them (gh api repos/{owner}/{repo}/issues/${spec}/sub_issues): a ticket that is not linked is not built. If tickets for #${spec} already exist (an earlier run published them without the link), link them instead of publishing them again. ` +
    `Give each ticket a Boundary: line (the files it owns, so parallel interns never collide) and a Depends: line (the tickets it waits for). ` +
    `Label each ticket that is not code with its role (${Object.keys(roleSkills(founder)).map((r) => `role:${r}`).join(", ")}); a code ticket gets no role label. ` +
    `Give each ticket a Serves: line naming the examples of #${spec} it serves (a plumbing ticket names the example it makes possible); work that serves no example is no ticket: list it under Out of scope in your breakdown comment. ` +
    `When there are 3 or more tickets, the first is the thinnest end-to-end slice of example 1, and the others depend on it. ` +
    `Then comment the breakdown on #${spec} (each ticket's number, title, Serves: and blockers). ` +
    `If #${spec} has more than one ticket, publish them without the ready-for-agent label, then start one intern with the Agent tool whose whole prompt is: "Read agents/fresh-eyes.md in the f1rm plugin (the newest ~/.claude/plugins/cache/f1rm/f1rm/*/agents/fresh-eyes.md) and do what it says for spec #${spec}." Add nothing to that prompt. Post its preview on #${spec} as one comment, word for word. ` +
    `If its last line is SURPRISES: 0, label every ticket ready-for-agent and end. Otherwise open a high-risk decision ticket whose header is <!-- f1rm:decision risk=high step=tickets-${spec} spec=${spec} recommended=1 restart=1 drop=3 -->, its question "The preview of #${spec} has changes no example asks for. Go on?" with the surprising rows, and its options 1. Go as planned, 2. I'll re-scope it, 3. Drop the spec; and end without the label. ` +
    `When you start again with a decision on #${spec} answered "Go as planned", the tickets exist: label every ticket ready-for-agent and end.`,
  implement: (spec, _round, founder) =>
    `/mattpocock-skills:implement-spec #${spec}\n\n` +
    `You run the implement step of spec #${spec}, started by the office, and nobody is in this session. ` +
    `The integration branch is spec-${spec} (create it from main if it does not exist yet); each ticket's branch is ticket-<number>. ` +
    `Start every implementer and merger with the Agent tool and isolation: "worktree", and run the mergers one at a time. ` +
    `Tell each implementer to load, with the Skill tool and before it builds, the skills its ticket's role label names, in place of tdd for a ticket with a role label: ${roleMapText(founder)}. A ticket whose role label is none of these is not built: comment on the ticket naming the label, and leave it open. ` +
    `Tell each of them to spell git as /usr/bin/git, as the first word of its own Bash call, with no cd, no -C and no chaining (a plain git is rewritten by the user's shell hook), and to start its branch with /usr/bin/git checkout -b ticket-<number> spec-${spec} (the gate refuses checkout -B and switch -C). ` +
    `After the code review of spec-${spec}, fix every finding it raised in one implementer, as the skill says, before you end. ` +
    `Open no pull request: close each ticket with a comment naming its merge commit on spec-${spec}. ` +
    `When the first ticket is a slice of example 1, post on #${spec} once it merges: the command you ran and its output, and for something visible a screenshot (gh issue comment ${spec} --attach <file>); then go on, waiting for nobody. ` +
    `Leave main alone: the office's close step lands spec-${spec}. ` +
    `End when every ticket is closed, or when none can go on: then say why in a comment on #${spec}.`,
  close: (spec, round) =>
    `You run the close step of spec #${spec}, started by the office, and nobody is in this session${round > 1 ? "; this is its last round" : ""}.\n` +
    `1. Read the examples of #${spec} (its ## Examples; on an older spec, its acceptance criteria). Check each one once on spec-${spec}, in a scratch worktree (/usr/bin/git worktree add .claude/worktrees/close-${spec} spec-${spec}), never in the main checkout; then remove that worktree.\n` +
    (round > 1
      ? `2. This is the last round: a criterion that still fails is listed as open in your closing comment; open no ticket.\n`
      : `2. If a criterion fails, open one ticket per failing criterion with gh issue create --parent ${spec} --label ready-for-agent (what to build, and its check), comment on #${spec} which criteria failed, and end: the office builds them and starts this step again.\n`) +
    `3. Land: note main's commit (/usr/bin/git rev-parse main), then run f1rm merge spec-${spec} in the main working directory. If it refuses, comment its message on #${spec} and end.\n` +
    `4. Push: run f1rm push. If it refuses, say why in your closing comment.\n` +
    `5. Clean up: /usr/bin/git branch -d spec-${spec}, then /usr/bin/git branch -d for each ticket-<number> of its tickets and each worktree-agent-* branch that git branch --merged lists (git keeps any a worktree still uses).\n` +
    `6. Close the spec: gh issue close ${spec} --comment with, first, a Mermaid flowchart of what changed built from /usr/bin/git diff <the commit you noted> main (its --stat and the diff itself), never from memory; then one table, a row per example: ✅ or ❌, the example, and its evidence (the command and its output); then the merge commit, pushed or not (and why), and any example still failing, in at most 3 lines; last, the line "Intent: <passed>/<examples> examples passed at the first close · <n> comments by the user · preview correction: yes|no" (yes when the user answered a preview's decision ticket other than "Go as planned"). For an example you can see, attach a screenshot of main before and after (gh issue comment ${spec} --attach <file>).\n` +
    `7. Retro, with nobody to ask: follow the retro skill over this spec (it can't be loaded with the Skill tool: read the newest ~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/retro/SKILL.md), with measured evidence: f1rm cost for each ticket's cost and the coordination share, grep -E "refused [a-z]+ (tickets|implement|close)-${spec}(-[0-9]+)? " ~/.f1rm/office.log for the gate's refusals, and the comments on #${spec} and its tickets for the review rounds and findings. Read the Intent: line of this spec's closing comment and of the last 5 closed specs' (gh issue list --state closed --search "Intent: in:comments"): if 5 have one and none says "preview correction: yes", one of your changes is to drop the fresh-eyes review. Open each review finding left unfixed as an issue labelled needs-triage (gh label create needs-triage --force first). Then propose at most 3 changes, most severe first, each where its files live. A change to f1rm itself (a role or step prompt, a rule, a check, a budget, the office) is never built here: ${F1RM_REPO ? `when gh api user -q .login prints ${F1RM_REPO.split("/")[0]}, open it on ${F1RM_REPO} (gh issue create --repo ${F1RM_REPO} --label needs-triage) with what to change, why and the evidence; otherwise ` : ""}list it under "For f1rm" in your closing comment. A change to this repo's own files (its CLAUDE.md, docs/agents/, its ticket template, its tests) is a draft spec issue here with no label (what to change, why, the evidence), then a decision ticket for it whose header is <!-- f1rm:decision risk=high spec=<the draft's number> recommended=1 ready=1 drop=2 -->, its question "Build this change?" with the evidence in one line, and its options 1. Build it and 2. Drop it. Change no file yourself. Then end.`,
};

/** The `claude` argv that starts a step: a named background session in the repo itself, coordinating at medium effort. `founder` for a Founder project, whose tickets may take the Founder roles. */
export const stepArgv = (step: Step, spec: number, round = 1, founder = false) => [
  "claude", "--bg", "--agent", "f1rm:step", "--name", stepName(step, spec, round), `${PROMPTS[step](spec, round, founder)}\n\nThis step is ${stepName(step, spec, round)}.`,
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
  // Read only for a step Claude Code calls working: its transcript tells whether its last turn ended long ago.
  const stale = (a: Listed) => a.state === "working" && STEP_NAME.test(a.name) && !!a.sessionId && endedBefore(tail(transcriptFile(home, a.cwd, a.sessionId)), Date.now() - STALE_MS);
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
          title: String(i.title ?? ""),
          author: String(i.user?.login ?? ""),
          parent: parentOf(i),
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
    tickets: async (repo, spec) => {
      const out = await gh(repo, ["api", `repos/{owner}/{repo}/issues/${spec}/sub_issues?per_page=100`]);
      if (out === null) return null;
      try {
        return (JSON.parse(out) as any[]).map((i) => ({ number: i.number, title: String(i.title ?? ""), state: i.state === "closed" ? ("closed" as const) : ("open" as const), blockedBy: Number(i.issue_dependencies_summary?.blocked_by ?? 0), labels: (i.labels ?? []).map((l: any) => String(l.name)) }));
      } catch {
        return null;
      }
    },
    costs: (repo) => specCosts(join(home, ".claude", "projects"), repo),
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
    approve: async (repo, spec) => {
      if ((await gh(repo, ["issue", "edit", String(spec), "--add-label", "ready-for-agent"])) === null) throw new Error(`gh issue edit #${spec} failed`);
    },
    stop: async (repo, name) => {
      // The newest session of that name in the repo: an older one keeps its name after it ends.
      const s = ((await agents(false)) ?? []).filter((a) => a?.name === name && typeof a.cwd === "string" && repoOf(a.cwd) === repo).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      if (!s || !(await machine.stop(String(s.sessionId ?? s.id)))) throw new Error(`could not stop ${name}`);
    },
    drop: async (repo, spec) => {
      if ((await gh(repo, ["issue", "close", String(spec), "--reason", "not planned", "--comment", "Dropped in the office."])) === null) throw new Error(`gh issue close #${spec} failed`);
    },
    open: async (repo, title, body) => {
      if ((await gh(repo, ["label", "create", "needs-decision", "--force", "--description", "A question only the user answers, in the office's tray"])) === null) throw new Error("gh label create needs-decision failed");
      if ((await gh(repo, ["issue", "create", "--label", "needs-decision", "--title", title, "--body", body])) === null) throw new Error("gh issue create failed");
    },
    // The close carries the answer, so a retry after a failure never writes it twice; the label and the spec's note are best effort after it.
    resolve: async (repo, n, spec, answer) => {
      if ((await gh(repo, ["issue", "close", String(n), "--comment", `Answered in the office: ${answer}`])) === null) throw new Error(`gh issue close #${n} failed`);
      // Both at once: neither depends on the other, and a bulk answer waits on each.
      await Promise.all([["issue", "edit", String(n), "--remove-label", "needs-decision"], ...(spec ? [["issue", "comment", String(spec), "--body", `Decision #${n}: ${answer}`]] : [])].map(async (args) => {
        if ((await gh(repo, args)) === null) console.log(`scheduler ${basename(repo)}: gh ${args.slice(0, 2).join(" ")} #${args[2]} failed after decision #${n} was answered`);
      }));
    },
    start: async (repo, step, spec, round) => void (await machine.spawnBackground(stepArgv(step, spec, round, readEdition(editionFile(repo)) === "founder"), repo)),
    // shortcut: a session is live until Claude Code calls it done or failed; read its process too if a crashed one lingers as working.
    live: async (repo) => (await machine.backgroundSessions())?.filter((a) => repoOf(a.cwd) === repo && a.state !== "done" && a.state !== "failed" && !stale(a)).map((a) => a.name) ?? null,
    ended: async (repo) => {
      const list = await machine.backgroundSessions();
      return list && endedSteps(list, repo, repoOf, stale);
    },
    release: async (id) => {
      if (!(await machine.stop(id))) throw new Error("claude stop refused");
    },
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
