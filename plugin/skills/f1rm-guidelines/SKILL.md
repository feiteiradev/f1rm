---
name: f1rm-guidelines
description: How the f1rm company works. Roster and hiring, each role's workflow, Work and Founder editions, teams and leads, briefs, who talks to whom, evidence handoff, boards, review inside the session and `f1rm merge`, drafts only, the caps, the gates and done. Load before planning, hiring, reviewing or merging.
---

# f1rm guidelines

These rules bind every f1rm role. Nothing here needs the office app. The office only displays the sessions and the board.

Hierarchy: the user, then one PM per repo. The PM hires leads for a milestone, one or two, and one specialist directly for a simple task (`--simple`). A lead runs its tasks with implementer subagents and hires only designers, researchers and content Reviewers into its team. Nobody else hires, and there is no layer below a lead.

## Roster and hiring playbook

| Role | Hire for | Slash commands `f1rm hire` starts the brief with |
| :- | :- | :- |
| `pm` | Started by the user with `f1rm pm`. Never hired. | `mattpocock-skills:grilling` |
| `lead` | One slice of a milestone, one or two leads per milestone. Hired only by the PM | `f1rm:f1rm-guidelines`, `f1rm:hire` |
| `designer` | Layout, flows, visual system, UX copy | `design-pipeline` |
| `frontend-dev` | UI implementation. Only a simple task's dev (`--simple`, hired by the PM); a lead's tasks go to its implementer subagents | `pstack:poteto-mode`, `mattpocock-skills:tdd` |
| `backend-dev` | Server, data, API implementation. Only a simple task's dev (`--simple`, hired by the PM); a lead's tasks go to its implementer subagents | `pstack:poteto-mode`, `mattpocock-skills:tdd` |
| `reviewer` | A branch with no code, hired with `--content` by a lead. It reads and reports; `f1rm merge` lands | `f1rm:f1rm-guidelines` |
| `researcher` | A question that needs current, cited facts | `mattpocock-skills:research` |
| `marketer` | Founder only. Positioning, landing copy, launch plans, conversion, and `growth/brand.md` first | `cro`, `anthropic-skills:content-creator`, `brandkit` |
| `seo-specialist` | Founder only. Audits, keywords, AI-search visibility | `seo-audit`, `ai-seo` |
| `social-media` | Founder only. A content calendar, posts, carousels, short videos | `social`, `content-calendar-sms`, `anthropic-skills:fabrica`, `hook-writer-sms`, `carousel-writer-sms` |
| `sales` | Founder only. First customers, outreach drafts, pricing | `anthropic-skills:6-first-customers-acquisition-plan`, `anthropic-skills:7-fast-revenue-strategy` |
| `strategist` | Founder only. Idea validation, niche, customer pain points, a business plan | `anthropic-skills:1-startup-idea-validator`, `anthropic-skills:2-profitable-niche-finder`, `anthropic-skills:3-customer-pain-point-researcher`, `anthropic-skills:4-lean-startup-business-plan-builder` |

**Ponytail level.** `f1rm hire` starts every hire but a lead at ponytail `full`, because ultra adds "question the request, push back", which stalls an unattended worker. A lead keeps the config default (ultra for the user). `f1rm wake` keeps the level.

Playbook:

1. **Pick the workflow, then interview.** The PM picks by rule (see Picking the workflow). In a milestone, plan only after the user confirms a shared understanding.
2. **One task, one hire, one worktree.** A task that needs two roles is two tasks.
3. **Order by dependency.**
   - Researcher before any task whose approach depends on facts you lack.
   - Designer before Frontend dev on UI work, with the spec path in the Frontend brief.
   - Backend dev and Frontend dev in parallel only when the brief fixes the API contract between them.
   - A content Reviewer only after a branch with no code. A code branch has no Reviewer: its author reviews it inside its own session (see Review and landing).
4. **Small tasks.** Each task fits one session and has acceptance criteria that a check can prove.
   - The PM collects what the user must provide (accounts, keys, copy, decisions) while it plans, and hires only once those inputs exist.
   - The same task goes to the same session: a `CHANGES REQUESTED` and a conflict from `f1rm merge` go back to the same dev or specialist. A new task gets a fresh hire, with the previous `DONE` report in its Inputs. Hires are not reused across tasks.
5. **Hire only with `f1rm hire`**, directly or through the `f1rm:hire` skill, which runs it. Never start a hire by calling `claude` yourself, because the caps live in `f1rm hire`. Only the PM and leads hire: the PM hires leads, and for a simple task one dev, designer or researcher with `--simple`; a lead hires designers, researchers and `--content` Reviewers into its team, never a dev (an owner's code is built by its implementer subagents, see Teams); the office blocks `f1rm hire` for every specialist.

   ```
   f1rm hire lead lead-<team> <team> "<team brief>"             # the PM, for a milestone
   f1rm hire --simple <role> <name> <task> "<brief>"            # the PM, for a simple task
   f1rm hire --team <team> <role> <team>.<role>-<task> <task> "<brief>"  # a lead, into its team
   ```

   - `<role>` is `designer`, `researcher` or `reviewer` (with `--content`) for a lead's hire, `lead` for the PM's milestone hire, and `frontend-dev`, `backend-dev`, `designer` or `researcher` for `--simple`. A lead's `--team` hire of a dev is refused.
   - `<name>` and `<task>` follow rule 6. The task slug becomes the worktree `.claude/worktrees/<task>` and its branch `worktree-<task>`.
   - `<brief>` is one quoted argument in the brief format below, without the `Report to` line. `f1rm hire` adds it.
   - Flags after the brief go to `claude`, for example `--model haiku`.
   - `--skills a,b` before the role adds skills to the brief for this task, for example a stack skill, or `mattpocock-skills:diagnosing-bugs` for a bug. The office holds the hire until it has loaded them (see Gates). `--skills research` makes `/research` the first command, for a question about what the community does. `--skills security-review` is refused. `f1rm hire` refuses any `pstack:` skill in `--skills` other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only).
   - `--level low|medium|high` sets the level of a dev's own review (see Review and landing), `medium` by default, for the two devs only. Use `high` for authentication, user data, secrets, shell execution or money: the review also runs `security-review` on the diff.
   - `--content` hires a Sonnet Reviewer for a branch with no code, and every Reviewer needs it. It drops the code-review skills the role file lists and uses only the content checklist. It reports; it does not merge.
   - `--simple` before the role makes the hire a simple task's: no team and no lead, reporting to the PM, and a team of one in the cap of 2. Only the PM uses it, for a dev, designer or researcher.
   - `--report-to <session>` before the role overrides the PM session name. It defaults to `pm-<repo basename>`.
   - Run it in the repo's main working directory. Background sessions run only in folders the user has trusted.
   - It prints `backgrounded · <id>` and exits 0 on success, and exits non-zero with a message when it refuses.
6. **Name** each hire `<role>-<task slug>`, for example `backend-dev-login`; a team member `<team>.<role>-<task slug>`, for example `checkout.designer-landing`; a lead `lead-<team>`. `f1rm hire` refuses any other name. Team and task slugs are lowercase words joined by hyphens, unique on their board. A Reviewer's task slug is `review-<task>`, for the task it reviews, so its name is `<team>.reviewer-review-<task>`; its lead pastes the author's `DONE` report into its Inputs.
7. **Slash commands.** The brief of a hire starts with its role's first skill as a slash command, for example `/design-pipeline`. Only the first slash command in a prompt expands, so `f1rm hire` names the other skills in the brief and the hire loads them with the Skill tool before starting.
   - `/research` is a command, not a Skill-tool skill. `--skills research` makes it the first command; the Researcher's own skill is `mattpocock-skills:research`.
   - `pstack:architect` and `pstack:how` are slash-only too: `--skills pstack:architect` or `--skills pstack:how` on a lead's hire makes it the lead's first command, and `f1rm:f1rm-guidelines` and `f1rm:hire` then load with the Skill tool. A hire has one first command, and a dev's is `/pstack:poteto-mode`, so `f1rm hire` refuses any other slash-only skill in a dev's `--skills`; `pstack:architect` and `pstack:how` are for a lead only. The PM gives `pstack:architect` for a cross-team contract or a new module.
   - `/security-review` is never loaded at the start, because it reviews the git state where it runs. With `--level high` the dev tells its review subagent to run it on the same diff (see Review and landing).
   - `f1rm hire` writes all of this and the `Report to` line, so do not write them in the brief yourself.
8. **Role prompts stay about the work.** Do not give a hire a persona or a character name in a brief.
9. **Checkpoint.** Before a long step (a full check run, a build) and whenever it stops, every hire makes a wip commit on its branch and writes `~/.f1rm/evidence/<repo>/<task>/resume.md`: done, next step, tip. A lead's is `lead-<team>/resume.md` and the PM's `pm-<repo>/resume.md`: each lives in a folder named after the session. They have no branch to commit to, and a Reviewer only reads, so those three write only the file. A session that stopped is resumed or replaced from it (see Watching and waking). A hire checkpoints before its report, so that it is the turn's last tool call (see Handoff); the PM's report is prose, not this.

## Picking the workflow

The PM picks the workflow by this rule before it plans, and says it in one line: `Simple workflow: <what, which role>`. The user upgrades it by saying "milestone".

- **Ops** is work with no file changes (run, start, open, install, status). The PM does it at once, with no interview, board row or hire.
- **Simple** is one deliverable, one specialist role, no business, product-scope, design or strategy decision, and it fits one session. The PM asks at most one clarifying question, writes no milestone section, adds one board row and hires ONE dev, designer or researcher with `f1rm hire --simple <role> <name> <task> "<brief>"`: no lead, no team, named `<role>-<task>`, and it reports to the PM. The dev reviews its own branch (see Review and landing). When its `DONE` is in, the PM runs `f1rm merge <task>` and then `f1rm letgo <name>`. A simple task is a team of one in the project's cap of 2 for as long as its session lives.
- **Milestone** is anything else: 2 or more tasks or roles, a big decision, research needed, or the user says "milestone" or "grill". It gets the full interview and teams (see Teams).

## Workflows

Each role's steps, and the skill or command at each step. Every dev and specialist ends with a `DONE` report that has the evidence block (see Handoff) and lists the skills used. A dev's `DONE` also states its review round count and level.

- **pm**
  1. Pick up: read the board, the team boards, the milestones file and `claude agents --json` (filtered to your own repo), run `claude logs <id>` for each hire on a `doing` or `review` row, update the rows, say nothing, and answer when the user asks "status?".
  2. Load `f1rm:f1rm-guidelines`.
  3. Pick the workflow (see Picking the workflow). For ops, do it. For a simple workflow, ask at most one question. For a milestone, interview with `mattpocock-skills:grilling` until the user confirms.
  4. Write the board (and, for a milestone, its section in the milestones file), and collect what the user must provide.
  5. For a simple workflow, hire one specialist with `f1rm hire --simple`; for a milestone, one or two leads with `f1rm hire lead`.
  6. Wait, with a background watcher on your hires (see Watching and waking); never wait for an agent by message. On a simple dev's `DONE <slug>`, run `f1rm merge <task>`, mark the row `done`, then `f1rm letgo <name>`; on its `NEEDS YOU <slug>` or `BLOCKED`, ask the user. On a lead's `NEEDS YOU <team>: <topic>`, tell the user as Who talks to whom says. After `DONE <team>`, mark its row `done`, then let the lead go with `f1rm letgo`.
  7. At the end of the milestone, send the one report with its Persist and Delete lists, then run the milestone cleanup after the user replies.
  - Exploration beyond the README, CLAUDE.md, `git log` and the board goes to a Haiku Explore intern.
- **lead**
  1. Load `f1rm:f1rm-guidelines`, then `f1rm:hire`. Started with `pstack:architect`, sketch the shapes of the contract or module before you hire; a question about existing code goes to a Haiku Explore intern, or runs `pstack:how` when the PM started you with it.
  2. Plan once: write the team board, one row per task, each with acceptance criteria a check can prove and files of its own. Ask the user to approve the plan once (Teams 6), then run without asking again.
  3. Run each task with an implementer subagent in its own worktree (Teams 7), at most 2 at a time. Hire a designer or researcher into the team with `f1rm hire --team` only for work that stands alone, and a `--content` Reviewer for a branch with no code. Watch those sessions with a background watcher (see Watching and waking). Ask the user a decision as Who talks to whom says.
  4. Check each task's `DONE` against its brief and its check record (Teams 8), have it reviewed by one fresh-context subagent, send the blocking findings back for one fix pass, then run `f1rm merge <task>`.
  5. Close the team (Teams 9): the batch task, each task's row `done`, `f1rm letgo`, then `DONE <team>`.
- **designer**
  1. Read the existing UI and tokens.
  2. Run `design-pipeline` to the spec.
  3. Check the result in a browser and keep a screenshot.
- **frontend-dev**
  1. Work the way `/pstack:poteto-mode` sets, with its playbook for the task (`feature`, `bug-fix`, `refactoring` or `perf-issue`); skip its Opening a PR step.
  2. Run `mattpocock-skills:tdd`: a failing check for each criterion.
  3. Build to the Designer's spec.
  4. Run the app with `run` and take a screenshot (`claude-in-chrome` for a page).
  5. Review inside the session, once, and report `DONE` (Review and landing).
  - With no Designer spec, run `design-pipeline` before step 2.
- **backend-dev**
  1. Work the way `/pstack:poteto-mode` sets, with its playbook for the task (`feature`, `bug-fix`, `refactoring` or `perf-issue`); skip its Opening a PR step.
  2. For a bug, run `mattpocock-skills:diagnosing-bugs` first to find the cause, then `mattpocock-skills:tdd` to fix it.
  3. For a feature, run `mattpocock-skills:tdd`.
  4. Review inside the session, once, and report `DONE` (Review and landing).
- **reviewer**
  1. Load `f1rm:f1rm-guidelines`: it is the first command of a `--content` Reviewer, the only Reviewer there is.
  2. Read the branch against the brief with read-only git, and check the content checklist (Review and landing).
  3. Report `APPROVED <slug>` or `CHANGES REQUESTED <slug>` to the lead. It changes and merges nothing.
- **researcher**
  1. Run `mattpocock-skills:research` on the question.
  2. For a question about community practice, the hire starts with `/research` (`--skills research`).
- **marketer**
  1. Read `growth/brand.md`, or write it first.
  2. Draft with `cro`, `anthropic-skills:content-creator` and `brandkit`.
- **seo-specialist**
  1. Audit with `seo-audit`.
  2. Plan AI-search visibility with `ai-seo`.
- **social-media**
  1. Plan the calendar with `social` and `content-calendar-sms`.
  2. Write each opening with `hook-writer-sms`, each carousel with `carousel-writer-sms`, and each short video with `anthropic-skills:fabrica`.
- **sales**
  1. Find the first customers with `anthropic-skills:6-first-customers-acquisition-plan`.
  2. Draft the outreach and pricing with `anthropic-skills:7-fast-revenue-strategy`.
- **strategist**
  1. Validate the idea with `anthropic-skills:1-startup-idea-validator`.
  2. Pick the niche with `anthropic-skills:2-profitable-niche-finder`.
  3. Research customer pain with `anthropic-skills:3-customer-pain-point-researcher`.
  4. Write the plan with `anthropic-skills:4-lean-startup-business-plan-builder`.

## Skill stack

The mattpocock skills and the pstack skills work side by side. Each row names the skill of a phase and the f1rm rule that wins when the two disagree.

| Phase | mattpocock skill | pstack skill | Rule that wins |
| :- | :- | :- | :- |
| Interview | `mattpocock-skills:grilling`, the PM's first command | none | Ask the user only for big decisions. |
| Plan a cross-team contract or new module | none | `pstack:architect`, slash-only: a lead's first command, which the PM names with `--skills pstack:architect` | Sketch first, then hire. |
| Questions about existing code | none | `pstack:how`, slash-only like architect (`--skills pstack:how`) | A lead not started with it sends a Haiku Explore intern. |
| Build | `mattpocock-skills:tdd`, loaded second with the Skill tool | `pstack:poteto-mode`, a dev's first command, with its playbook: `feature`, `bug-fix`, `refactoring`, `perf-issue` | The tdd skill is mattpocock's, never pstack's of the same name. Every criterion has a check that fails first. |
| Diagnose a bug | `mattpocock-skills:diagnosing-bugs`, before tdd (`--skills`) | the `bug-fix` playbook | Diagnose first, then fix test-first. |
| Review | none; the dev's one review subagent runs the `code-review` skill on its diff, and `security-review` at `--level high` | `pstack:interrogate`, slash-only: the user can run it by hand at `--level high` | The dev's own review decides what is fixed; `f1rm merge` lands. |
| Parallel work | none | `pstack:arena`, `pstack:swarm`, slash-only | Not wired inside hires (the Skill tool refuses them); the user can run them by hand. |
| Ship | none | the playbooks' Opening a PR, Babysit and Shipping | None of it runs inside a hire. |

Inside a hire: no PR opening, no babysit loops, no `/loop` ticks, no `afk`; `pstack:arena` and `pstack:swarm` are not wired inside hires (the user can run them by hand, as `pstack:interrogate`); at most 2 interns; pushing stays the user's. A question a pstack skill would put to the human goes to the session in your `Report to` as `BLOCKED`.

Every pstack skill but its setup skill carries `disable-model-invocation`: the Skill tool refuses it, so only a first slash command runs one. `f1rm hire` refuses any `pstack:` skill in `--skills` other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only); the user can run the rest, such as `pstack:interrogate`, `pstack:arena` and `pstack:swarm`, by hand. A dev picks its playbook inside poteto-mode; the playbooks are its files, not skills.

## Editions

Every project is **Work** or **Founder**, and the user chooses: the office asks on the first entry, `f1rm pm` asks on its first run, and the top bar or `f1rm edition work|founder`, once `f1rm pm` has registered the project, changes it. It lives in `~/.f1rm/projects/<repo>.json`, outside the repo. Never set it yourself.

- **Work** is the engineering company: every role above that is not marked Founder only.
- **Founder** adds the five Founder-only roles for a product of the user's own. `f1rm hire` refuses a Founder-only role in a Work project, and a project with no edition chosen counts as Work.
- The PM's first prompt states the edition. When the user switches a project to Work, Founder roles already working finish their tasks and no new one is hired.

## Founder playbook

In a Founder project the PM follows this on top of everything else here.

1. **Interview the business too.** Ask about the customer, the problem they have, the offer, and the channel that reaches them, as well as what to build.
2. **Strategist first** when the idea is not validated, that is, when no customer has confirmed the problem. A plan built on an untested idea waits for the Strategist's verdict, the way a task waits for the Researcher's facts.
3. **Brand first.** If the repo has no `growth/brand.md`, the Marketer's first task writes it: the voice, the audience, words to avoid, and the claims the product can back. Every Founder role reads it before drafting.
4. **Go-to-market alongside the build.** Put launch work (landing copy, SEO, social, outreach, pricing) on the board next to the engineering tasks, ordered by what the launch needs. A team can mix roles, for example a `launch` team with a Frontend dev, a Marketer and an SEO specialist.
5. **Where it lands.** Founder work is files in the repo, under `growth/marketing/`, `growth/seo/`, `growth/social/`, `growth/sales/` and `growth/strategy/`, delivered as commits on the hire's worktree branch, read by a content Reviewer when the lead hired one, and landed by `f1rm merge` like code.

## Drafts only

- Founder roles draft. They never post, publish, send, schedule or spend. The user puts everything out.
- Connectors are fine for drafts, for example a Canva design or a Gmail draft. The office's hook blocks a Founder role's connector tools whose names say send, publish, post or schedule.
- Generating with paid credits (Higgsfield video, for example) counts as spending. Ask the session in your `Report to`; the lead asks the user for each spend as Who talks to whom says, records the answer on its team board and passes it down.
- When founder work that is meant to go out has landed through `f1rm merge`, the lead marks its team-board row `publish` and sends the PM `NEEDS YOU <team>: publish`, because only the user can put it out. The PM tells the user. When the user says it is out, the PM tells the lead, who marks the row `done`.

## Teams

1. **Every milestone runs through one or two teams**, even a milestone of one task. A simple workflow is one specialist, a team of one (see Picking the workflow). The PM hires only leads for a milestone, so hire traffic stays out of its chat with the user. Its own Haiku Explore interns are the one exception.
2. **What a team owns.** One vertical slice of the milestone, end to end (design, frontend, backend), with its own acceptance criteria. Name the team after its slice, for example `checkout`.
3. **At most 2 teams** work in a project at once, live leads and simple tasks together. Every task of a milestone goes through a team.
4. **No nested teams.** Only the PM hires leads, and a lead hires only designers, researchers and `--content` Reviewers, only into its own team.
5. **Order.** The PM orders teams by dependency, as it orders tasks. When a team needs only a contract from another (an API shape, a shared file), the two leads agree on it directly.
6. **Plan once, approve once.** A lead plans once: it writes its team board, one row per task, each with acceptance criteria a check can prove and files of its own. It asks the user to approve the plan once, as a numbered round with its recommendation, the open question on its board and `NEEDS YOU <team>: plan` to the PM, and then runs without asking again. Only a decision the user alone can make (Who talks to whom) interrupts it, and it starts nothing that answer could change until it has the answer.
7. **Owners run implementer subagents.** A lead cannot hire a frontend-dev or a backend-dev (`f1rm hire` refuses it) and writes no product code. It runs each task with an implementer subagent, in the shape of the `implement-spec` skill with the team board as its ticket list: a general-purpose subagent (Agent tool) that works test-first in its own worktree, `.claude/worktrees/<task>` on branch `worktree-<task>`, where the gate lets it write and commit and nowhere else, and that sends `f1rm report DONE <task> --commit <sha>` when its checks pass. It runs at most 2 implementers at a time, the review subagent counting among the 2 sub-agents. A designer or a researcher is a separate session only when its work stands alone, and a `--content` Reviewer reads a branch with no code.
8. **Scrutiny.** A lead checks each task's `DONE` against its brief and its check record (see Test runs in Handoff). If anything is missing, it sends the work back to the same specialist (an implementer gets a fix pass; a designer or researcher whose session has no live process is woken first: **No live session** in Watching and waking). Then one fresh-context review subagent reviews the branch as a dev's does (see Review and landing); the lead sends only the blocking findings back, for one fix pass, copies the non-blocking ones to `~/.f1rm/kept/<repo>/findings.md`, and runs `f1rm merge <task>`. A second blocking round, a conflict the implementer cannot resolve, or a decision only the user can make goes to the user.
9. **Closing.** When every task of the team is merged, the lead runs one batch task for the non-blocking findings in its findings file: a normal task through the same flow (its own non-blocking findings stay `left` and start no second batch). The lead skips it, and says so in its `DONE <team>`, when the list is empty or the user says to leave them. The findings file records each finding as `fixed` or `left`. Then the lead marks each task's row `done` on its team board, lets its specialists go with `f1rm letgo <name>...`, which also removes their merged worktrees and branches, removes its implementers' merged worktrees and branches, and sends the PM one `DONE <team>`: a 5-line summary (the merged commits, how to try it, what is open), the path of the findings file, and the specialists' `keep:` lines. The PM then marks the team's row `done` and only after that lets the lead go with `f1rm letgo lead-<team>`: the office wakes a hire whose row still says `doing` or `review` once `claude stop` has ended it, so the row is marked first.

## Watching and waking

The PM watches its leads and its simple tasks' devs, and each lead watches its own team's sessions, so a session that stopped is found without the user. Judge by real activity, never by status text: `claude agents` and `claude logs` read "working" for hours on a session that hit the subscription limit. `f1rm status --json` lists this repo's hires, judged by their transcripts and branches: `idleMinutes` (since the transcript was last written), `lastCommit`, `ended` (`claude agents` no longer lists the session) and `limitUntil` (when the last line of the conversation is a limit stop of any kind, session or weekly: the text after "resets" as the stop gives it, such as `8:40pm (Europe/Lisbon)` or `Monday 9:00 (Europe/Lisbon)`; `unknown` if it names no time).

**The office wakes first.** Every minute the office itself looks at the background hires and leads of each registered project whose process has ended while their board row is `doing` or `review`, and wakes each one through the same checks as `f1rm wake`, caps included. A limit stop is woken a minute after its reset time, with `resumed after the session limit; continue your task`; any other end (an update, a crash, a shutdown) at once, with `resumed after your session ended; continue your task`. Each stop is woken once. When the office cannot wake one (no reset time, a cap, an error), or a hire ends again within 10 minutes of a wake with no new commit and no more than one assistant message after it (the reply to the wake), it tells the session in the hire's `Report to`: `<name> stopped again after a wake; f1rm wake <name>` or `<name> stopped at the session limit; f1rm wake <name>`, and `f1rm status` shows it in the NOTE column (`recovery` in `--json`). A live, idle hire or lead on a `doing` or `review` row whose last turn ended 20 minutes ago without a report (the turn delivered no `SendMessage` whose first word is `DONE`, `APPROVED`, `CHANGES REQUESTED`, `BLOCKED`, `ESCALATE` or `NEEDS YOU`; text never counts) gets one message: `your turn ended without a report; send your DONE or BLOCKED`. The office wakes no interactive session, no PM, no hire that was let go (its row is not `doing` or `review`) and no project that is not registered. The watcher below is the second line: it catches what the office reports it could not wake, and the hires that are alive but quiet.

1. **Watch.** After hiring, run `f1rm status --watch <names>` in the background (`run_in_background`); its exit wakes you. It polls once a minute and prints each stalled name with its reason: idle for 20 minutes, ended, on a limit stop, missing from the list or without an activity time. It also prints `<name>: reported <KIND> (commit <sha>, report.json seq <n>)`, once for each new report of a watched name (see Handoff); this is how you read reports. It exits 1 when `claude agents --json` can't be read. A lead counts as stalled only when it and every hire of its team have been quiet, so a lead waiting on active hires is not. It only reads, so the delegation gate lets it through.
   - Pass a session waiting for an answer to its report (`DONE`, `BLOCKED`, `CHANGES REQUESTED`, `ESCALATE`, `APPROVED`, or a lead's `NEEDS YOU` or `DONE <team>`) as `name:waiting`: a waiting name is judged only for ended, missing or a limit stop, never for being quiet, and a waiting name is watched as a plain name as soon as it writes again, so an approval at the hire's desk (which no message reports) puts it back without you. A message you send to a waiting session counts as a write and makes it plain. Until it writes, a waiting name is woken only for ended, missing or a limit stop.
   - Leave out a hire waiting on a reset timer you hold.
   - When you answer a session's report (and it works again), restart the watcher with it as a plain name.
   - Start no watcher when no name is left; the reset timers wake you.
2. **On wake**, read what the watcher printed and take each stalled session in turn:
   - **Reported**: take the report as you would its message (the REPORT column of `f1rm status` and the file's `note` hold the same words), whether or not the message arrived; the last bullet covers one you already handled.
   - **Limit stop** (`limitUntil`): the office wakes it a minute after the time it names, so the watcher does not race it: wait until a minute after that time, with a background `sleep` whose exit wakes you, then run `f1rm status`. A live session of that name is woken; a woken session continues from its history, and gets `resume` and where it stopped, from its `resume.md` (see the Checkpoint rule), only if it lost its place. Run `f1rm wake <name>` when its NOTE says the office could not, and when it is still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported` (the office may have stopped after writing its NOTE; a live session is refused, so racing it is harmless). A NOTE that says `reported` needs no wake. A `resume` sent at the reset time itself reaches no process, and the gate refuses it.
   - **Limit stop with no time** (`limitUntil` is `unknown`): a rate-limit error that is not the subscription's reads this way, so wait a few minutes with a background `sleep` whose exit wakes you, then send it `resume` as for an idle session.
   - **Idle 20 minutes**, still listed, no limit stop: send it `resume`.
   - **No live session**: a limit stop, a `claude stop` or a finished turn ends the session's process, though `claude agents` may still list it as blocked, and a message to it is queued and never arrives. The project gate refuses one with `no live session; f1rm wake <name>`. Run `f1rm wake <name> "<the message you meant to send>"` instead: it resumes that hire in place, from its own worktree, with its history, name and `Report to`, and the message is its first prompt (`resumed; continue your task` when you give none). The woken session has a new session id and the old transcript stays as it was, so address it by name. It counts against the caps like a hire (a cap refusal goes the way a hire's does), and refuses a hire that was let go, another project's hire, a live one (message it instead) and an unknown name. The PM wakes leads and its simple tasks' devs, and a lead wakes the members of its own team (enforced); a specialist wakes nobody. A sender who may not wake resends after the one who may has: a member asks its lead for an ended peer, and for an ended lead the PM wakes it (a lead has no lead to ask).
   - **Ended**: the office wakes it within a minute, so look at `f1rm status` first: a hire that is live again needs nothing, and a NOTE that says the office could not wake it (or that it stopped again) means you run `f1rm wake <name>`, as above; so does a hire still ended two minutes after the reset (a limit stop) or after the end (any other stop), unless its NOTE says `reported` (the office may not run, or the project may not be registered). A NOTE that says `reported` needs no wake: send your answer with `f1rm wake <name> "<answer>"` when you have one. Re-hire only a hire that was let go or whose wake failed: run `f1rm letgo <name>`, then hire it again with a resume brief placed before the original brief: the merged commits, the branch tip, the stale scratch worktrees to remove first, the remaining specs. A specialist gets a new task slug and resets its worktree to the old tip; a lead keeps its name. If `letgo` refuses because the branch is not merged, leave the old session: its tip lives on in the new branch, and it is let go after that merge.
   - **Missing or no activity time**: keep it in the names; if the next wake still finds it so, treat it as ended.
   - **Status can't be read**: if status refuses the repo itself (not a git repo, path too long), don't restart: tell the session in your `Report to` (the PM tells the user). Otherwise run `f1rm status` by hand to see why, then restart the watcher.
   - **After you send `resume`**, restart the watcher. The delivered `resume` clears the stop, so the old stop does not wake the watcher again. A hire that hits the limit again shows a new stop and wakes you again; a second `resume` in a row that brought no new commit, message or timed limit stop in between means it is ended (an `unknown` stop does not count, so a persistent error ends after two resumes).
   - When a session sends its report, restart the watcher with it as `name:waiting`.
   - After handling any wake (unless status refused the repo), restart the watcher with the names still working. After `f1rm letgo`, restart the watcher without the names you let go. A wake from a stale watcher is ignored when its hire is not in the names you now watch. For a wake about a session you already handled (or took a report from) since that watcher started: ignore it, but still restart the watcher.
3. **Known limit.** If the PM and the leads are stopped by the same limit, the office wakes the leads after the reset and the PM waits for the user. Nothing watches the PM; if it stops, the user restarts it. A watcher wake in a limited session fails, and the brief rejects a daemon outside the office that restarts sessions by itself.
4. **Address a woken or re-hired session** as `name [ref]` (the ref from ListAgents) or `uds:<socket>` when an offline Remote Control mirror of the old session shares its name. The project gate decides on the bare name (see Gates).

## Pause and checkpoint

The user can stop the whole project and come back to it later. Only the PM runs this, when the user says so; the office does the work, so no agent is asked to stop or to checkpoint.

- **Pause.** On "pause", "stop everything" or the like, run `f1rm pause [reason]` yourself. Never wait for the agents by message, and never ask a lead to pause its team. It stops every session of the project, the helpers inside them included, then kills the background processes they started (test runs, second offices, browsers), never the office, a terminal or the user's own sessions. It checks afterwards that nothing of the project still runs, saves each worktree under `refs/f1rm/checkpoint/<task>` with its uncommitted and untracked changes and without touching the files, and writes a manifest of the sessions (name, role, task, board row, session id). It prints `All N stopped` and the checkpoint id only after that check; it does not see a detached job a lead or Reviewer started in the main checkout, or a dev's second office's own `claude` daemon and sessions (it kills only that office's `bun serve`). An orphan a user's own `claude -w` left in `.claude/worktrees` with no terminal is killed with the rest, and an application started from a worktree (such as an editor opened with `code .`) never is. A worktree with no commit to save on top of is named `NOT saved`. If it exits non-zero it names what still runs: do not close anything, tell the user, and run it again.
- **Pause and close.** When the user says "pause and close", "I am going to bed" or the like, run `f1rm pause`; once it prints the checkpoint id, write `paused at <time>, checkpoint <id>` to the milestones file and tell the user "safe to close".
- **Restart.** `f1rm pm` on a paused project starts a fresh PM with a note to read the board, the milestones file and the manifest, and to say in one line where everything stopped. Wake nothing yourself.
- **Resume.** When the user says "resume", run `f1rm resume`. It wakes every session of the manifest, leads first, one at a time within the cap of 8 (it waits for a slot), each with a note of where it stopped: its task, its board row, the snapshot ref when it had uncommitted work, and the checkpoint id. A session it cannot wake, because its conversation is gone, is named in the output: tell the user. While the project is paused `f1rm hire`, `f1rm wake` and the office's Hire dialog are refused with a pointer to `f1rm resume`.
- `f1rm pause --all` and `f1rm resume --all` are for the user's terminal, never a session.
- **Work hours.** The office pauses by itself: at the end of the work day (Mon-Fri 09:00-19:00 Europe/Lisbon unless `~/.f1rm/config.json` says otherwise, or turns it off) every project it knows is paused with the same full stop and checkpoint, flagged `by: schedule`; at the start of the next work day it resumes only the projects the schedule paused, never one paused by hand. A `f1rm resume` out of work hours lasts until the next 19:00. After a sleep (a tick gap over 2 minutes) nobody is judged stalled, woken or nudged for 5 minutes. Do not run `f1rm pause` or `f1rm resume` to follow the schedule.

## Brief format

A hire sees only its brief and the repo. Write the brief so it can work without asking. `f1rm hire` puts `Report to: <PM session name>` right after the slash commands. Write exactly these sections, in this order.

```
Task: <slug>: <one-line goal>
Context: <what exists, which files matter, decisions the user made in the interview>
Inputs: <paths or links to specs, designs, research from earlier tasks, or "none">
Deliverable: <what must exist when done>, as commits on this worktree branch
Acceptance criteria:
- <criterion> (proved by: <the check>)
Out of scope: <what to leave alone>
Report: when done or blocked, SendMessage to the session named in `Report to`, as described in the handoff rules
```

Your session name is `pm-<repo basename>`. `f1rm pm` starts the session with `--name pm-<repo basename>` and states the name in your first prompt. `f1rm hire` fills in `Report to` with it, so pass `--report-to` only if you were started another way. A lead's hires report to `lead-<team>`, which `f1rm hire --team` fills in, and a simple task's dev reports to the PM. The ListAgents tool shows your hires and their state. A content Reviewer's brief also names the branch to read, the base branch, and the brief of the task under review, and its Inputs hold the author's `DONE` report.

A dev's brief Context also names the pstack playbook that fits the task (see Skill stack). A brief's Context names the notes file for its role: `~/.f1rm/kept/<repo>/notes/<role>.md`, with `<repo>` the repo folder's basename, as in `~/.f1rm/evidence/<repo>/`. The hire reads it before it starts and keeps this project's learnings there. Agent memory is shared across projects, so it holds only facts about the user and how they like to work, and lessons that hold in any project.

When a task carries a core decision, its Context states the decision and why, and a criterion reads "docs/decisions.md has the entry <title>" (see Milestones and decisions).

## Team brief

The PM hires a lead with a team brief in place of a task brief. Write exactly these sections, in this order.

```
Team: <team slug>: <one-line goal of the slice>
Milestone: <the milestone this slice belongs to>
Context: <what exists, decisions the user made, installed skills that fit this slice>
Other teams: <each other team's slug and its lead's session name, and what this team needs from it or owes it>
Contracts: <the contracts already fixed between teams, or "none">
Acceptance criteria:
- <criterion> (proved by: <the check>)
Out of scope: <what to leave to other teams or later>
Report: NEEDS YOU <team>: <topic> for what needs the user, DONE <team> when the slice is merged. Nothing else goes to the PM.
```

A lead writes its specialists' briefs in the task brief format above. Every brief's Context names the installed skills, slash commands and plugins that fit the task, beyond the role's own skills that `f1rm hire` adds.

## Who talks to whom

- **Ask the user only for big decisions.** The PM's interview and every question to the user cover only business, product scope (what the software does), design direction, strategy, irreversible or external actions (push, deploy, spend, data deletion, messaging people), exceeding a cap, and a permission only the user can give. Technical choices (architecture, libraries, refactors, test approach, tooling, f1rm's own internal rules), the caps excepted, are made by the PM or the lead; a core one goes into a brief's Context so the hire logs it (see Who writes it). The end-of-milestone report lists them under "Decisions taken without you".
- **The user talks to each lead directly.** In a milestone with teams the user answers a lead in the lead's own session (the office's Jump), and the PM does not relay.
  - A lead asks its decisions as a numbered round, each item with its recommended answer, so "yes to all" works, and writes the open question on its team board, one line under `## Open question for the user`, and replaces it with `none` once the user answers. The office tags the lead "needs you" while that line stands, and while its own permission request waits.
  - The moment a lead needs the user it sends the PM `NEEDS YOU <team>: <topic>`, a one-liner. The question itself is not in the message.
  - The PM then tells the user: "lead-<team> needs you about <topic>: Jump to lead-<team> in the office". It names the session, never an id or a `claude attach` command, and the same goes for any other session the user must open. For a permission it says "approve <name>'s request in the office" (see A permission is answered in the office).
  - The PM helps the user decide when asked, and writes the end-of-milestone report.
- **The PM and a lead exchange only** `NEEDS YOU <team>: <topic>`, `DONE <team>`, and the PM's `resume` and answers. A lead messages the other leads directly about contracts, shared files and the order of handoffs, and records each agreement on its team board. Status, `BLOCKED`, `ESCALATE` and a cap override reach the user through the lead.
- **In ops and the simple workflow the PM stays the user's contact.** On `NEEDS YOU` the PM sends the user to the session that acts on the answer: the office's permission card for a permission, the lead for anything else, a cap included (the override needs the approval in the lead's own conversation). In the simple workflow the dev reports to the PM, so a dev's `NEEDS YOU <slug>` or `BLOCKED` is the PM's to put to the user, and the PM answers the dev; a cap goes to the user, and a permission to the office's card.
- **Unprompted, the PM tells the user only:**
  - big decisions;
  - that a lead needs them (`NEEDS YOU`), worded as above;
  - things only the user can do: a permission request, spend, credentials or inputs, a `git push`, a dirty main checkout;
  - one end-of-milestone report: what landed, how to try it, what is open, "Decisions taken without you" (the decisions-log titles), ending with the `git push` line (see Milestones and decisions for its cleanup lists).

  Everything else stays between agents: `DONE` reports, review rounds, research, findings. The board and the findings file hold it, and the user asks "status?" for more.
- A specialist reports only to the session in its `Report to`, its team's lead (the PM for a simple task), and messages only who the Messaging table allows.
- **A lead receives all of its team's messages**, scrutinizes them (see Teams), and sends the PM only `NEEDS YOU <team>: <topic>` and `DONE <team>`. There are no per-task reports, and the watcher is your own (see Watching and waking).
- **A permission is answered in the office.** The hire sends `BLOCKED <slug> permission` with the exact command, and its lead tells the PM with `NEEDS YOU <team>: permission for <hire>` (a simple task's dev sends the PM the `BLOCKED` itself). The PM tells the user "approve <name>'s request in the office" and never runs the command itself. The office holds the request for at least 30 minutes, on a card on the hire's desk and in the top bar that shows the command, who asks, why (the hire's last words) and three buttons: Approve once, Deny, and Always for this project, which adds exactly the allow rule Claude Code suggested for this request (the card shows its text) to the repo's `.claude/settings.local.json`; with no suggestion the card has no such button. Unanswered, the request falls back to the hire's own prompt. Only the user's browser answers (see Gates). When a brief already names an exact command the hire will need, the lead may pass `--allowedTools "<that command>"` after the brief, and only then.
- **The user may talk to anyone.** An Ask is a read-only side question whose answer goes straight to the user. A Tell is an instruction: act on it, then tell the session in your `Report to` what changed (a lead records it on its team board, which the PM reads), so nobody above you is surprised.
- **Projects are isolated.** A session works inside its own repo. The PM and leads filter `claude agents --json` and ListAgents to their own repo (a cwd under its main working directory) at pickup and every time after, and never name, address or rely on another project's sessions, boards, milestones or evidence. A problem with f1rm itself goes to the user as one line, `f1rm feedback: <problem> -> <suggestion>`, written in your reply and addressed to no session. The project gate (see Gates) refuses a message to another project.

## Spawning table

Who may start what. **Enforced** means the gate or the hire command refuses a breach; **rule only** means the rule binds you and nothing refuses a breach. The gate runs only while the office does, so every rule stands either way.

| Role | `f1rm hire` | Sub-agents | `/loop` and `/schedule` | Background shell watchers | `claude --bg` and `claude -p` |
| :- | :- | :- | :- | :- | :- |
| PM | Leads, and one dev, designer or researcher with `--simple` (enforced) | At most 2, never an `f1rm:*` role; an implementer or reviewer sub-agent may write and commit in its own worktree under `.claude/worktrees/` (enforced) | Never (enforced) | `f1rm status --watch` and wake timers (rule only: no command is refused) | Never outside `f1rm hire`, except `--bg --resume` to wake a session (enforced: the forms the gate reads) |
| Lead | Designers, researchers and `--content` Reviewers of its own team, never a dev or a lead (enforced) | At most 2, never an `f1rm:*` role; an implementer or reviewer sub-agent may write and commit in its own worktree under `.claude/worktrees/` (enforced) | Never (enforced) | `f1rm status --watch` and wake timers (rule only: no command is refused) | Never outside `f1rm hire`, except `--bg --resume` to wake a session (enforced: the forms the gate reads) |
| Specialist or Reviewer | Nothing (enforced) | At most 2, never an `f1rm:*` role (enforced) | Never (enforced) | A check or a dev server only (rule only: none is refused) | Never (enforced: the forms the gate reads) |
| Intern | Nothing (enforced for a specialist's or a Reviewer's intern; a PM's or a lead's intern is held to its parent's row (enforced), so what its parent may do passes (rule only)) | Counts against its parent's 2 (enforced) | Never (enforced) | A check only (rule only: none is refused) | Never (enforced for a specialist's or a Reviewer's intern; a PM's or a lead's intern is held to its parent's row (enforced), so what its parent may do passes (rule only)) |

- `/loop` and `/schedule` mean the two skills, with or without a plugin prefix, and the `ScheduleWakeup`, `CronCreate` and `RemoteTrigger` tools they start recurring work with.
- `claude --bg --resume <id>` is how an ended session is woken, and `f1rm wake` is the sanctioned wrapper: it passes the agent, name, folder and `Report to` a wake needs and counts the caps like a hire. Wake with it; who may wake is in **No live session** in Watching and waking.
- The one other `claude --bg` or `claude -p` is a second office whose command sets its own temporary HOME (a literal absolute path or `$(mktemp -d)`, never the user's home). `--resume` with `--fork-session` starts a new session, so it is no wake.
- **Rule only** for the launchers the gate does not read: `bash -c "claude …"` is not parsed, and neither are an alias or a variable, a script that runs `claude`, and `node …/cli.js`; a HOME exported by an earlier call is not seen either, so that `claude -p` is refused. Start sessions with the hire command whatever the gate sees.

## Messaging table

Who may message whom. The gate reads the recipient's role and team from the session title that the hire command sets; the message type is **rule only** except where marked.

| Sender | May message | Message types | When | Why |
| :- | :- | :- | :- | :- |
| The user | Anyone, from the office (Jump, Ask, Tell): not held, the user is no session | Ask (read-only side question), Tell (an instruction; act, then tell your `Report to` what changed (a lead records it on its team board)) | Any time | The user decides |
| PM | Leads of its project and its simple tasks' devs only (enforced) | Answers to a lead or a simple dev and `resume` (rule only); the lead's `NEEDS YOU` and `DONE <team>` and a simple dev's reports come to the PM | After a report, and on a wake | The PM's chat stays free of hire traffic |
| Lead | The PM, other leads and the members of its own team (enforced) | To the PM: `NEEDS YOU <team>: <topic>` the moment it needs the user, and `DONE <team>` at the end (rule only). To leads: contracts, shared files, handoff order. To its team: briefs, answers, `resume`, `CHANGES REQUESTED` back to a dev (rule only) | As the work needs | The lead owns its team and filters traffic for the PM |
| Team member | Its own lead and the members of its own team (enforced). Formal reports `DONE`, `APPROVED`, `CHANGES REQUESTED`, `BLOCKED`, `ESCALATE`, `NEEDS YOU` only to its lead (enforced for a message that opens with one of those words; a report in other words is rule only) | Formal reports to the lead; plain words to peers (rule only) | Once when done, once if blocked; a peer when the work needs it | The lead scrutinizes every report |
| Simple task's dev | The PM only, its reports included (enforced) | Formal reports `DONE`, `BLOCKED`, `NEEDS YOU`, `ESCALATE` (rule only) | Once when done, once if blocked, once if a second review round would still block (rule only) | The PM is its lead and lands its branch |
| Intern | Its parent session or "main" only (enforced) | Its result, in its answer (rule only) | When its subtask ends | An intern is a subtask of one session |
| Anyone | A team member never messages another team; leads message each other (a member reaches another team through its lead). Never another project, and Elsewhere is no room: two sessions outside every project reach each other only when one works inside the other's folder (all enforced) | None | Never | Teams and projects stay isolated |
| Anyone, to an ended hire | A hire of its project with no live process is refused (enforced), by name, by `name [ref]` or by session id, with `no live session; f1rm wake <name>`; the checks above come first | None | Never | A message to an ended session is queued and never arrives |

"main" is the user's own top-level session and is open to every employee while no online session answers to that name.

## Handoff via SendMessage

- A deliverable is commits on the hire's worktree branch. Messages carry status and pointers, never the work itself.
- A hire reports with the SendMessage tool to the session named in `Report to` (its team's lead, or the PM for a simple task), once when done and once if blocked. Checkpoint (wip commit, `resume.md`) before you send it, so the report is the turn's last tool call: the office skips an ended hire whose turn ended with a delivered report, and wakes one that kept working after it. A hire that sent a report and went on working is not nudged for a missing one. Use one of these first lines:
  - `DONE <slug> branch=<branch> commit=<sha>` then a short summary and the evidence block below.
  - `BLOCKED <slug>` then the question or the missing input. Send one `BLOCKED` message that lists every open question, and keep working on the rest.
  - `BLOCKED <slug> permission` then the exact command that auto mode blocked. Wait for the answer; do not work around it.
  - `NEEDS YOU <slug>` from a dev when a second review round would still have blocking findings, or when its task cannot have a failing test (see Review and landing). The session in its `Report to` asks the user (see Who talks to whom).
  - `APPROVED <slug>` from a content Reviewer, with nothing merged: the lead then runs `f1rm merge`.
  - `CHANGES REQUESTED <slug>` from a content Reviewer, then the blocking findings with file and line.
  - `CHANGES REQUESTED <slug> conflict` from the PM or the owner to a dev whose `f1rm merge` hit a conflict. The dev rebases its unpushed branch onto the current main, runs the suite once more, records it and sends a new `DONE`. A branch that moved after its `DONE` ("tip moved") gets a new `DONE` the same way.
  - `ESCALATE <slug>` from a content Reviewer in place of a third blocking round (see Review and landing). The lead re-scopes the task, or asks the user (see Who talks to whom) if the user must decide.
- **Every report is also a file.** `SendMessage` can return success while the message never arrives, so a hire first runs `f1rm report <KIND> <slug> [--commit <sha>] [--note "<one line>"]`, then sends its message, which stays the turn's last tool call; both carry the same words. `KIND` is `DONE`, `APPROVED`, `CHANGES` (for `CHANGES REQUESTED`), `NEEDS` (for `NEEDS YOU`), `BLOCKED` or `ESCALATE`, and a Reviewer's `<slug>` is `review-<task>`. The command writes `~/.f1rm/evidence/<repo>/<slug>/report.json` with `{kind, slug, commit, note, at, seq}`, and `seq` rises by 1 on every write. `f1rm status --watch` wakes the lead once for each new `seq` of a watched name (a `name:waiting` one too), `f1rm status` shows the last one in its REPORT column, and the office counts a report file written in the hire's turn as a delivered report. The lead acts on a report it has not handled whether or not the message arrived.
- **The evidence block** of a `DONE` report holds:
  - each acceptance criterion's check command, with its result on the base (it fails) and on the branch (it passes);
  - the check record of the full suite (see Test runs);
  - a screenshot for a visible change, from `run` or `claude-in-chrome`;
  - for a dev, the review round count and the review level (see Review and landing);
  - the skills used.

  Evidence files go in `~/.f1rm/evidence/<repo>/<task>/`, and the report points to them. The lead pastes the author's report into a content Reviewer's Inputs.
- **Test runs.** Every role runs the full suite with `bun run check`, and never run two at once: it takes a per-repo lock kept in the repo's git common dir, so every worktree of the repo shares it. A second caller waits (up to 20 minutes), prints who holds it and since when, and starts when the first ends; the lock of a holder that died is taken over, and the exit code is the suite's. One test file, `bun test <file>`, stays unlocked. The dev runs the full suite once per round, on its final commit, and writes `{commit, exit code, pass/fail counts}` to `check-record.json` in `~/.f1rm/evidence/<repo>/<task>/`; its `DONE` names the file. A dev that changes code after its review's fix pass runs the suite once more and records again. The PM or the owner checks the record against the branch tip (same commit, exit 0) and does not rerun the suite. `f1rm merge` runs only the new tests on the base (red) and the full suite once on the merge.
- **Working files never enter the repo.** Research notes, plans and proofs live in `~/.f1rm/evidence/<repo>/`, and findings in `~/.f1rm/kept/<repo>/findings.md`. A `DONE` report adds `keep: <path> — <why>` for anything a later milestone will need, or `keep: none`. The lead passes those lines on in `DONE <team>`.
- A hire reports to the session in its `Report to` and messages only who the Messaging table allows.
- The PM or the lead answers a `BLOCKED` message with the missing input or a re-scoped task, then updates its board. A `BLOCKED` that needs the user goes to the user through the lead (see Who talks to whom).
- Messages arrive between tool calls, and a session whose turn has ended wakes when one arrives. A PM or lead waiting on hires stops instead of polling.

## Board format

Each repo has one board file, written only by the PM, and each team has its own, written only by its lead, so two writers never share a file. Both live outside the repo, so project repos stay clean.

- **Path.** `~/.f1rm/boards/<repo>.md`, where `<repo>` is the absolute path of the repo's main working directory with every character that is not an ASCII letter or digit (`A-Z`, `a-z`, `0-9`) replaced by `-`. A git repo's main working directory is the parent of `git rev-parse --path-format=absolute --git-common-dir`. A repo's worktrees use the main repo's board. Create the directory if it is missing.
- **Contents.** A title line, then one Markdown table with exactly these columns.

```
# Board: <repo name>

| id | owner | status | branch | task |
| :- | :- | :- | :- | :- |
| T1 | researcher-auth-options | done | worktree-auth-options | Compare session and token auth |
| T2 | backend-dev-auth-api | doing | worktree-auth-api | Add login endpoint |
| T3 | - | todo | - | Build the login form |
```

- **id.** `T<n>`, never reused.
- **owner.** The hire's session name, or `-` before hiring.
- **status.** One of `todo`, `doing`, `review`, `publish`, `done`, `blocked`. `doing` means a hire is working. `review` means the branch is under review or awaits `f1rm merge`. `publish` means landed founder work waiting for the user to put it out. `done` follows `f1rm merge` only, and for work meant to go out, the user saying it is out.
- **branch.** `worktree-<task slug>`, or `-` before hiring.
- **task.** One line, without `|`.
- One row per task. Update the row in place. Rows stay until the milestone cleanup removes the done ones (see Milestones and decisions). On a team board the lead sets `publish` and `done`.
- **Team boards.** A lead's board is `~/.f1rm/boards/<repo>.team.<team>.md`, with `<repo>` encoded as above, titled `# Board: <repo name> / <team>`, in the same table format, one row per task of its slice. On the PM's board a team is one row: owner `lead-<team>`, branch `-`, task the slice's goal.

## Milestones and decisions

Two documents keep the why of the work: a milestones file outside the repo, which the PM writes, and a decisions log inside it, which hires write.

**The milestones file.** Only the PM writes it, and it lives outside the repo, like the board. The office does not display it.

- **Path.** `~/.f1rm/milestones/<repo>.md`, with `<repo>` encoded exactly as the board path is (see Board format). Create the directory if it is missing.
- **Contents.** A title line `# Milestones: <repo name>`, then one `## <milestone slug>` section per milestone in progress, with four parts: **Goal**, **Settled** (what the interview decided), **Tasks** (the board's `T` ids) and **Done when**. Task status stays on the board only; never copy it here.
- **Life.** The PM adds a milestone's section when the user confirms the plan, reads the file at pickup alongside the board, and, once the milestone cleanup is done, replaces the section with a 5-line record. By then its core decisions are in `docs/decisions.md`, through the tasks.
- **Milestone cleanup.** When the milestone is reached, the PM's one end-of-milestone report also lists two groups:
  - **Persist**: what the hires' `keep:` lines named, and anything else a later milestone will need. It moves to `~/.f1rm/kept/<repo>/` (with `mv`) and is never deleted automatically.
  - **Delete**: the milestone's evidence folders, briefs, research, plans and done board rows.

  `~/.f1rm/kept/<repo>/notes/` is in neither group; it stays. So does `~/.f1rm/kept/<repo>/findings.md`, whose rows say `fixed` or `left`.

  The user may move items between the groups. The PM moves and deletes only after the user replies. Then it replaces the milestone's section in the milestones file with a 5-line record: what shipped (task ids and landing commits), how to try it, and what is open (ponytail-review findings and anything the user must decide). `docs/decisions.md` and git history stay.

**The decisions log.** `docs/decisions.md` in each project repo, created the first time a decision is recorded and committed like code.

- **Core decision.** Any of: a feature or behaviour the user chose; a refactor or architecture choice; a cap, limit, dependency or version change; anything rejected for a reason. Bug fixes and wording tweaks get no entry.
- **Format.** The log is append-only, oldest first. Each entry is a heading `## <YYYY-MM-DD> <title>` and four lines: `- Decision:`, `- Why:`, `- Rejected:` and `- Where:` (the task id and commit, or the task id alone when the commit doesn't exist yet).
- **Who writes it.** When a task carries a core decision, the PM (or the lead) puts the decision and its why in the brief's Context, with the criterion "docs/decisions.md has the entry <title>". The hire adds that entry in its own commit, plus an entry for any core design decision it made that the brief didn't fix.
- **Merging.** A hire that creates the decisions log file, whatever its path (`docs/decisions.md` here; some repos keep `docs/decisions.html`), also adds the line `<that path> merge=union` to the repo's `.gitattributes`, for example `docs/decisions.md merge=union`, so two branches that append different entries merge without a conflict. Union folds the identical first and last lines of two new entries into one, so start and end every entry with a line of its own: the heading and the `- Where:` line are, and an HTML entry needs an opening tag with an id and a closing comment after its closing tag. The blank line that opens an entry folds too, so the second heading follows the first entry's last line. Nobody resolves a conflict by hand: `f1rm merge` sends it back to the dev.
- **Check.** The review (a dev's own, or a content Reviewer's) confirms that every entry the brief asks for is there, and a missing entry blocks.
- **ADRs.** A repo that has `docs/adr/` keeps its ADRs; an entry links to the ADR rather than copying it.

## Review and landing

Nobody reviews code in a second session, and only `f1rm merge` lands on the base branch. Nobody pushes; the user pushes.

**Review inside the session.** A dev (a simple task's dev) reviews its own branch before it sends `DONE`, and an owner has each implementer's branch reviewed the same way (Teams 8).

1. Run the checks (Test runs in Handoff). When they pass, run ONE review in a fresh context: start a general-purpose subagent with the Agent tool and tell it to run the `code-review` skill at the task's level on `git diff <base>...HEAD`, where `<base>` is the branch the task started from; at `--level high` (authentication, user data, secrets, shell execution or money) it also runs `security-review` on that same diff. `code-review` is a forked skill and through the Skill tool it may send nothing back, so tell the subagent to read the diff itself too. The level is the dev's `--level low|medium|high`, `medium` by default.
2. Have the subagent sort each finding as blocking or non-blocking. A finding is blocking when it is a wrong or missing behaviour against the brief, a bypass or security hole, a false positive in a main flow, or a test that does not test what it claims; a wording nit, a style point, a hypothetical edge or a cleanup is not. A `docs/decisions.md` entry the brief asks for and the diff lacks is blocking.
3. Fix the blocking findings ONCE and run the checks again. Send the non-blocking findings to `~/.f1rm/kept/<repo>/findings.md`, as lines in its table format: `| date | area | status | finding | evidence |`.
4. If a second review would still have blocking findings, do not fix again: send `NEEDS YOU <slug>` (after `f1rm report NEEDS <slug>`) to the session in your `Report to`, which asks the user.
5. A dev implements inline and never delegates the implementation: the one subagent it starts is this reviewer (and at most 2 interns, as before). The `DONE` states the review round count and the review level.
6. Every task has at least one failing test. A branch of test-only or renamed tests has no failing new test, and `f1rm merge` does not land it: send `NEEDS YOU <slug>` and the user decides.

**Content review.** A branch with no code (founder work under `growth/`, and research a brief puts in the repo) may be read by a content Reviewer, which a lead hires with `--content`. It reads the branch against the brief with read-only git (`git diff <base>...worktree-<task>`, `git show`, or `git worktree add --detach .claude/worktrees/review-<task> <branch>` to read it whole, removed when done). It does not merge, commit or change a file. It checks the **content checklist**:

- every acceptance criterion is met;
- no claim is made up: every number, quote, testimonial and promise has a source or is marked as an assumption;
- it follows `growth/brand.md`;
- nothing in it was posted, published, sent or paid for;
- every `docs/decisions.md` entry the brief asks for is there.

It sends the lead `APPROVED <slug>`, or `CHANGES REQUESTED <slug>` with the blocking findings only, file and line for each. Its non-blocking findings go under `Non-blocking (for the batch task)` in the verdict, and the lead copies them to the findings file. At most 2 blocking rounds per branch: it sends `ESCALATE <slug>` in place of a third.

**Landing.** Only `f1rm merge <task>` lands on the base branch, run by the PM (a simple task) or the owner (a milestone) in the main working directory once the `DONE` is in, and a content Reviewer's `APPROVED` where one was hired. It refuses, leaving main untouched, a main with uncommitted changes, a task with no `DONE` report, a branch tip that is not the `DONE` commit ("tip moved"), a conflict, code without tests (documentation, `*.md`, `growth/` and `docs/` land without a red check), a repo with no `check` script, and a branch that changes how the suite runs. Otherwise it merges the branch in a scratch worktree, runs the branch's new tests on the base, where they must fail (a test that passes on the base proves nothing), runs the full suite once on the merge behind the suite lock, then moves the base with `--ff-only`. It never pushes. A conflict or a moved tip goes back to the dev as `CHANGES REQUESTED <slug> conflict` (see Handoff), and any other refusal is read and acted on. Then the PM (a simple task) or the team's lead marks the task's row `done` and lets the session go with `f1rm letgo <name>...`, which also deletes the merged branch and worktree.

Never run `git push`, never force, never rewrite published history; the gate refuses these (see Gates).

## Cap rule

`f1rm hire` enforces these, refusing with a non-zero exit and a message naming the cap:

- At most **8 background sessions working at once**, counted across the whole machine, not per repo. Leads, the Reviewer, the Researcher and the user's own background sessions all count.
- At most **2 teams** per project, counting live leads and simple tasks (a team of one) together.
- At most **2 working in a team**, its Reviewer included. A member whose `claude agents --json` status is `idle` (it ended its turn and waits for a message, as after its DONE) frees its slot, though its state still reads working; a blocked member never does; a missing or unreadable status counts as working. The cap of 8 counts an idle member all the same.
- **One specialist per task**, which no override skips. Split a task only into tasks that each have their own acceptance criteria and their own files.
- When it refuses a lead, the lead does not retry or override: it tells the PM (`NEEDS YOU <team>: cap`), asks the user in its own session whether to wait or exceed the cap, and waits. The PM does not retry either.
- When it refuses the PM, the PM leaves the team's row `todo`, tells the user why, and asks whether to wait or exceed the cap. Start the task when a slot frees if the user chooses to wait.
- Use the override flag of `f1rm hire` (`f1rm hire --override <role> <name> <task> "<brief>"`) only after the user has approved exceeding the cap in this conversation, for this hire. An earlier approval or your own judgment is not approval. Ask again for each later hire.

## Interns

- An employee runs **at most 2 interns** (sub-agents started with the Agent tool) at once. The office blocks a third.
- Use an intern only for a subtask that is independent of your other work, and run it on Haiku unless the subtask needs more.
- A dev's review subagent and an owner's implementer and review subagents are sub-agents too, and count among the 2.

## Gates

The office holds four gates with hooks. A refusal says which rule held the call, and each is logged to `~/.f1rm/office.log`. With the office stopped, none runs.

- The **skill gate** holds a hire's work tools until it has loaded every skill its first prompt names. Only a session's first prompt arms it; a later message that quotes that prompt's skill list changes nothing, and a session resumed with its own id is not armed again. A woken session (`f1rm wake`) is a new session whose first prompt is the wake note: it names no skills to load (its history has them). Reading tools, Skill and SendMessage are never held, and neither is a sub-agent such as a dev's review subagent. A Reviewer session started before the Reviewer became content-only may still carry the security sentence in its first prompt, and its `APPROVED` is then held until it has run security-review; a content Reviewer carries none. Way out: load the skills with the Skill tool; a skill the Skill tool refuses counts as tried, read from the session's own transcript. If the refusal says disable-model-invocation, go on without that skill; if it says Unknown skill, go on and send `BLOCKED <slug>` naming it.
- The **delegation gate** holds the PM and leads to coordinating. Their Write and Edit work only in the boards, milestones, kept files, memory, evidence and scratch folders. Their Bash runs no `git commit`, `merge`, `push`, `rebase`, `reset` or `cherry-pick`. They start no `f1rm:*` role as an intern. An implementer or reviewer sub-agent of the PM or of a lead may write and commit inside its own worktree under `.claude/worktrees/` and nowhere else; the rest of its parent's limits hold for it. The PM's `f1rm hire` runs only for a lead or with `--simple`, a lead's only into its own team and never for a dev, and `f1rm wake` follows the hire rules (**No live session** in Watching and waking). Way out: put the work on the board and hire for it with `f1rm hire`. Landing is `f1rm merge`'s, and pushing is the user's, who can run it with `!`.
- **Landing** is a rule of the delegation and push gates. Only `f1rm merge` lands on the base branch for any session that holds a role, and only the PM and leads run it, never an intern or a specialist. In the main checkout (by cwd, `cd`, `-C` or `--work-tree`) it refuses `merge`, `cherry-pick`, `rebase`, `reset`, `commit`, `am`, `pull`, `revert`, `checkout <ref> -- <path>`, `checkout -B`, `switch -C` and `restore --source`, and from any folder `update-ref`, `branch -f` and `fetch . x:<base>` on the base branch. A dev's git in its own worktree is unchanged. Way out: send `DONE` to the session in your `Report to`, which runs `f1rm merge`; the user's own terminal is free.
- The **push gate** holds every hire. It refuses `git push` in any form (also behind `timeout`, `nice` or `stdbuf`), `gh pr merge` and a `gh api` call that writes to code-landing endpoints (pull request and branch merges and updates, refs, commits, trees, blobs and contents, and graphql merge, update and ref mutations; other `gh api` calls stay allowed), so only the user pushes and lands on a remote. The Reviewer's git is an allowlist: reading commands, `git branch` as a listing, and `git worktree` add, list, prune and remove (a forced remove only of `.claude/worktrees/red-<task>`); merge, commit, checkout, switch, fetch, config and the rest are refused. Way out: ask the user to run it with `!`, or leave it undone.
- The **project gate** holds every company role's SendMessage. It refuses a message to a session of another project, to a hire of the project with no live process (way out: **No live session** in Watching and waking), and to a name the office does not know or that sessions of more than one project answer to; inside the project it refuses what the Messaging table marks enforced, and Elsewhere is no room. Messages to `main`, to your own sub-agents and to the sessions the table allows pass. Way out: message only who the table allows; a problem with f1rm goes to the user as `f1rm feedback: <problem> -> <suggestion>`.
- A specialist cannot run `f1rm hire`, `f1rm wake` or `f1rm merge`, and only the PM hires with `--simple`. Way out: ask the session in your `Report to`.
- A session can't answer a permission request. A Bash command that names this office's approve, deny and always routes (by its port, its link key or the saved link) is refused for every company role. Only the user's browser, which holds the link key, answers. The gate reads the command text, so a commit message or heredoc that quotes a route is refused too: write it to a file and use `git commit -F`. Way out: wait for the user's answer in the office.

## Use what is installed

Before doing work by hand, check the skills, slash commands and plugins your session has, and use the ones that fit the task. Name the ones you used in your report.

## Definition of done

A task is done when all of these hold, and not before.

1. Every acceptance criterion has a check that fails without the change and passes with it.
2. The repo's full check command is green on the merged result.
3. The branch has been reviewed (a dev's own review, or a content Reviewer's `APPROVED` for a branch with no code) and `f1rm merge` has landed it locally on the base branch.
4. The board row says `done`. Founder work meant to go out passes through `publish` first, and is done when the user says it is out.

The PM and its leads mark a task done only on this basis. A hire's own `DONE` means ready for `f1rm merge`. A team is done when every task on its board is done and its lead has sent `DONE <team>`.
