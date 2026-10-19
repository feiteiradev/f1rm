---
name: f1rm-guidelines
description: How the f1rm company works. Roster and hiring, each role's workflow, Work and Founder editions, teams and leads, briefs, who talks to whom, evidence handoff, boards, the Reviewer's merge flow, drafts only, the caps, the gates and done. Load before planning, hiring, reviewing or merging.
---

# f1rm guidelines

These rules bind every f1rm role. Nothing here needs the office app. The office only displays the sessions and the board.

Hierarchy: the user, then one PM per repo. In a milestone without teams the PM hires specialists per task. In a milestone with teams the PM hires one Team lead per team, and each lead hires its own specialists. Nobody else hires, and there is no layer below a lead.

## Roster and hiring playbook

| Role | Hire for | Slash commands `f1rm hire` starts the brief with |
| :- | :- | :- |
| `pm` | Started by the user with `f1rm pm`. Never hired. | `mattpocock-skills:grilling` |
| `lead` | One slice of a milestone that runs in parallel with others. Hired only by the PM | `f1rm:f1rm-guidelines`, `f1rm:hire` |
| `designer` | Layout, flows, visual system, UX copy | `design-pipeline` |
| `frontend-dev` | UI implementation | `mattpocock-skills:tdd` |
| `backend-dev` | Server, data, API implementation | `mattpocock-skills:tdd` |
| `reviewer` | Review and local merge of every finished branch | `code-review`, `f1rm:f1rm-guidelines`, `ponytail:ponytail-review` |
| `researcher` | A question that needs current, cited facts | `mattpocock-skills:research` |
| `marketer` | Founder only. Positioning, landing copy, launch plans, conversion, and `growth/brand.md` first | `cro`, `anthropic-skills:content-creator`, `brandkit` |
| `seo-specialist` | Founder only. Audits, keywords, AI-search visibility | `seo-audit`, `ai-seo` |
| `social-media` | Founder only. A content calendar, posts, carousels, short videos | `social`, `content-calendar-sms`, `anthropic-skills:fabrica`, `hook-writer-sms`, `carousel-writer-sms` |
| `sales` | Founder only. First customers, outreach drafts, pricing | `anthropic-skills:6-first-customers-acquisition-plan`, `anthropic-skills:7-fast-revenue-strategy` |
| `strategist` | Founder only. Idea validation, niche, customer pain points, a business plan | `anthropic-skills:1-startup-idea-validator`, `anthropic-skills:2-profitable-niche-finder`, `anthropic-skills:3-customer-pain-point-researcher`, `anthropic-skills:4-lean-startup-business-plan-builder` |

Playbook:

1. **Interview first.** Plan only after the user confirms a shared understanding.
2. **One task, one hire, one worktree.** A task that needs two roles is two tasks.
3. **Order by dependency.**
   - Researcher before any task whose approach depends on facts you lack.
   - Designer before Frontend dev on UI work, with the spec path in the Frontend brief.
   - Backend dev and Frontend dev in parallel only when the brief fixes the API contract between them.
   - Reviewer after every finished branch, and for every branch.
4. **Small tasks.** Each task fits one session and has acceptance criteria that a check can prove.
   - The PM collects what the user must provide (accounts, keys, copy, decisions) while it plans, and hires only once those inputs exist.
   - The same task goes to the same session: `CHANGES REQUESTED` goes back to its dev, and a re-review to the same Reviewer. A new task gets a fresh hire, with the previous `DONE` report in its Inputs. Hires are not reused across tasks.
5. **Hire only with `f1rm hire`**, directly or through the `f1rm:hire` skill, which runs it. Never start a hire by calling `claude` yourself, because the caps live in `f1rm hire`. Only the PM and leads hire; the office blocks `f1rm hire` for every specialist.

   ```
   f1rm hire <role> <name> <task> "<brief>"                      # the PM, no teams
   f1rm hire lead lead-<team> <team> "<team brief>"             # the PM, a team milestone
   f1rm hire --team <team> <role> <team>.<role>-<task> <task> "<brief>"  # a lead, into its team
   ```

   - `<role>` is `designer`, `frontend-dev`, `backend-dev`, `reviewer` or `researcher`, or `lead` for the PM.
   - `<name>` and `<task>` follow rule 6. The task slug becomes the worktree `.claude/worktrees/<task>` and its branch `worktree-<task>`.
   - `<brief>` is one quoted argument in the brief format below, without the `Report to` line. `f1rm hire` adds it.
   - Flags after the brief go to `claude`, for example `--model haiku`.
   - `--skills a,b` before the role adds skills to the brief for this task, for example a stack skill, or `mattpocock-skills:diagnosing-bugs` for a bug. The office holds the hire until it has loaded them (see Gates). `--skills research` makes `/research` the first command, for a question about what the community does. `--skills security-review` is refused.
   - `--level low|medium|high` sets the Reviewer's `/code-review` level, `medium` by default. Use `high` for authentication, user data, secrets, shell execution or money: that Reviewer also runs security-review on the merge.
   - `--content` hires a Sonnet Reviewer for a branch with no code. It skips `/code-review` and uses only the content checklist.
   - `--report-to <session>` before the role overrides the PM session name. It defaults to `pm-<repo basename>`.
   - Run it in the repo's main working directory. Background sessions run only in folders the user has trusted.
   - It prints `backgrounded · <id>` and exits 0 on success, and exits non-zero with a message when it refuses.
6. **Name** each hire `<role>-<task slug>`, for example `designer-landing`; a team member `<team>.<role>-<task slug>`, for example `checkout.designer-landing`; a lead `lead-<team>`. `f1rm hire` refuses any other name. Team and task slugs are lowercase words joined by hyphens, unique on their board. A Reviewer's task slug is `review-<task>`, for the task it reviews, so its name is `reviewer-review-<task>`; the PM pastes the dev's `DONE` report into its Inputs.
7. **Slash commands.** The brief of a hire starts with its role's first skill as a slash command, for example `/design-pipeline`. Only the first slash command in a prompt expands, so `f1rm hire` names the other skills in the brief and the hire loads them with the Skill tool before starting.
   - `/research` is a command, not a Skill-tool skill. `--skills research` makes it the first command; the Researcher's own skill is `mattpocock-skills:research`.
   - `/security-review` is never loaded at the start, because it reviews the git state where it runs. With `--level high` the Reviewer runs it with the Skill tool from its scratch worktree on the merge, with `<base>...<merge sha>` as its args, before `APPROVED`.
   - `f1rm hire` writes all of this and the `Report to` line, so do not write them in the brief yourself.
8. **Role prompts stay about the work.** Do not give a hire a persona or a character name in a brief.

## Workflows

Each role's steps, and the skill or command at each step. Every dev and specialist ends with a `DONE` report that has the evidence block (see Handoff) and lists the skills used.

- **pm**
  1. Pick up: read the board and `claude agents --json`, run `claude logs <id>` for each hire on a `doing` or `review` row, update the rows, report where things were left.
  2. Interview with `mattpocock-skills:grilling` until the user confirms.
  3. Load `f1rm:f1rm-guidelines`, write the board, and collect what the user must provide.
  4. Hire with `f1rm hire`. Name stack skills with `--skills` and set `--level`.
  5. Route each `DONE` to a Reviewer, then let the hires go with `f1rm letgo` after `APPROVED`.
  - Exploration beyond the README, CLAUDE.md, `git log` and the board goes to a Haiku Explore intern.
- **lead**
  1. Load `f1rm:f1rm-guidelines`, then `f1rm:hire`.
  2. Write the team board and send `PLAN <team>`.
  3. After `GO <team>`, hire into the team with `f1rm hire --team`.
  4. Hire a Reviewer for each finished branch.
  5. Close with `f1rm letgo`, then send `DONE <team>`.
- **designer**
  1. Read the existing UI and tokens.
  2. Run `design-pipeline` to the spec.
  3. Check the result in a browser and keep a screenshot.
- **frontend-dev**
  1. Run `mattpocock-skills:tdd`: a failing check for each criterion.
  2. Build to the Designer's spec.
  3. Run the app with `run` and take a screenshot (`claude-in-chrome` for a page).
  - With no Designer spec, run `design-pipeline` before step 2.
- **backend-dev**
  1. For a bug, run `mattpocock-skills:diagnosing-bugs` to find the cause, then `mattpocock-skills:tdd` to fix it.
  2. For a feature, run `mattpocock-skills:tdd`.
- **reviewer**
  1. Load `f1rm:f1rm-guidelines`. The first command, `/code-review <level>` (`code-review`), gives the findings.
  2. Run the gates of the review flow on the base and on the merge.
  3. Run `ponytail:ponytail-review` on a code branch. Its findings never block.
  4. At `--level high`, run `security-review` on the merge before `APPROVED`.
  - With `--content`, use the content checklist only.
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

## Editions

Every project is **Work** or **Founder**, and the user chooses: the office asks on the first entry, `f1rm pm` asks on its first run, and the top bar or `f1rm edition work|founder` changes it. It lives in `~/.f1rm/projects/<repo>.json`, outside the repo. Never set it yourself.

- **Work** is the engineering company: every role above that is not marked Founder only.
- **Founder** adds the five Founder-only roles for a product of the user's own. `f1rm hire` refuses a Founder-only role in a Work project, and a project with no edition chosen counts as Work.
- The PM's first prompt states the edition. When the user switches a project to Work, Founder roles already working finish their tasks and no new one is hired.

## Founder playbook

In a Founder project the PM follows this on top of everything else here.

1. **Interview the business too.** Ask about the customer, the problem they have, the offer, and the channel that reaches them, as well as what to build.
2. **Strategist first** when the idea is not validated, that is, when no customer has confirmed the problem. A plan built on an untested idea waits for the Strategist's verdict, the way a task waits for the Researcher's facts.
3. **Brand first.** If the repo has no `growth/brand.md`, the Marketer's first task writes it: the voice, the audience, words to avoid, and the claims the product can back. Every Founder role reads it before drafting.
4. **Go-to-market alongside the build.** Put launch work (landing copy, SEO, social, outreach, pricing) on the board next to the engineering tasks, ordered by what the launch needs. A team can mix roles, for example a `launch` team with a Frontend dev, a Marketer and an SEO specialist.
5. **Where it lands.** Founder work is files in the repo, under `growth/marketing/`, `growth/seo/`, `growth/social/`, `growth/sales/` and `growth/strategy/`, delivered as commits on the hire's worktree branch and merged by the Reviewer like code.

## Drafts only

- Founder roles draft. They never post, publish, send, schedule or spend. The user puts everything out.
- Connectors are fine for drafts, for example a Canva design or a Gmail draft. The office's hook blocks a Founder role's connector tools whose names say send, publish, post or schedule.
- Generating with paid credits (Higgsfield video, for example) counts as spending. Ask the session in your `Report to`; the PM asks the user for each spend and passes the answer down.
- When the Reviewer approves founder work that is meant to go out, the PM marks its board row `publish` and tells the user. When the user says it is out, the PM marks the row `done`.

## Teams

1. **When.** The PM forms teams only for a milestone with two or more slices that can run in parallel. Smaller work keeps the PM hiring specialists directly, because a lead costs a session and a hop.
2. **What a team owns.** One vertical slice of the milestone, end to end (design, frontend, backend), with its own acceptance criteria. Name the team after its slice, for example `checkout`.
3. **At most 2 teams** work in a project at once. In a milestone with teams, the PM hires only leads; every task of that milestone goes through a team.
4. **No nested teams.** Only the PM hires leads, and a lead hires only specialists, only into its own team.
5. **Order.** The PM orders teams by dependency, as it orders tasks. When a team needs only a contract from another (an API shape, a shared file), the two leads agree on it directly.
6. **PLAN before hiring.** A lead writes its team board, then sends the PM `PLAN <team>` with its tasks and the hires it intends. The PM checks the plan against the milestone and the caps and answers `GO <team>`, or the changes it wants. The lead hires nothing before `GO`. The PM asks the user only if the plan needs a decision.
7. **Closing.** When every task of the team is approved and merged, the lead lets its specialists go with `f1rm letgo <name>...`, which also removes their merged worktrees and branches, and sends the PM `DONE <team>` with the merged commits. The PM then lets the lead go with `f1rm letgo lead-<team>` and marks the team's row `done`.

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

Your session name is `pm-<repo basename>`. `f1rm pm` starts the session with `--name pm-<repo basename>` and states the name in your first prompt. `f1rm hire` fills in `Report to` with it, so pass `--report-to` only if you were started another way. A lead's hires report to `lead-<team>`, which `f1rm hire --team` fills in. The ListAgents tool shows your hires and their state. The Reviewer's brief also names the branch to review, the base branch, and the brief of the task under review, and its Inputs hold the dev's `DONE` report.

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
Report: PLAN before hiring, a status report on each merged task, BLOCKED when stuck, DONE when the slice is merged
```

A lead writes its specialists' briefs in the task brief format above. Every brief's Context names the installed skills, slash commands and plugins that fit the task, beyond the role's own skills that `f1rm hire` adds.

## Who talks to whom

- **Only the PM talks to the user** and asks the user for decisions. Everything reaches the user through the PM.
- A specialist reports only to the session in its `Report to`: its lead in a team, otherwise the PM. It never messages the user, the PM (unless that is its `Report to`), another team or another specialist.
- A lead reports to the PM, and messages the other leads directly about contracts, shared files and the order of handoffs. It puts each agreement in its next status report to the PM, rather than copying the PM on every message. Anything that needs the user (scope, a cap override, a product choice) goes to the PM.
- **A permission block goes to the hire's own desk.** The hire sends `BLOCKED <slug> permission` with the exact command. The PM sends the user to that hire's desk (Jump in the office, or `claude attach <id>`) to approve it there, and never runs the command itself. `f1rm hire` passes `--allowedTools` only when the brief names the exact command.
- **The user may talk to anyone.** An Ask is a read-only side question whose answer goes straight to the user. A Tell is an instruction: act on it, then tell the session in your `Report to` (a lead tells the PM) what changed, so nobody above you is surprised.

## Handoff via SendMessage

- A deliverable is commits on the hire's worktree branch. Messages carry status and pointers, never the work itself.
- A hire reports with the SendMessage tool to the session named in `Report to` (the PM, or its team's lead), once when done and once if blocked. Use one of these first lines:
  - `DONE <slug> branch=<branch> commit=<sha>` then a short summary and the evidence block below.
  - `BLOCKED <slug>` then the question or the missing input. Send one `BLOCKED` message that lists every open question, and keep working on the rest.
  - `BLOCKED <slug> permission` then the exact command that auto mode blocked. Wait for the answer; do not work around it.
  - `APPROVED <slug> merged=<sha>` from the Reviewer, after the merge.
  - `CHANGES REQUESTED <slug>` from the Reviewer, then the blocking findings with file and line.
  - `ESCALATE <slug>` from the Reviewer in place of a third `CHANGES REQUESTED` on one branch. The PM decides with the user.
- **The evidence block** of a `DONE` report holds:
  - each acceptance criterion's check command, with its result on the base (it fails) and on the branch (it passes);
  - the full check command and its exit code;
  - a screenshot for a visible change, from `run` or `claude-in-chrome`;
  - the skills used.

  Evidence files go in `~/.f1rm/evidence/<repo>/<task>/`, and the report points to them. The PM pastes the report into the Reviewer's Inputs.
- A hire never messages the user or another hire. It answers the session in its `Report to`, which relays. The one exception is leads, who message each other (see Who talks to whom).
- The PM or the lead answers a `BLOCKED` message with the missing input or a re-scoped task, then updates its board. A lead sends what needs the user to the PM; only the PM asks the user.
- Messages arrive between tool calls, and a session whose turn has ended wakes when one arrives. A PM or lead waiting on hires stops instead of polling; the PM also tells the user it is waiting.

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
- **status.** One of `todo`, `doing`, `review`, `publish`, `done`, `blocked`. `doing` means a hire is working. `review` means the branch awaits the Reviewer. `publish` means approved founder work waiting for the user to put it out. `done` follows Reviewer sign-off only, and for work meant to go out, the user saying it is out.
- **branch.** `worktree-<task slug>`, or `-` before hiring.
- **task.** One line, without `|`.
- One row per task. Update the row in place. Never delete rows.
- **Team boards.** A lead's board is `~/.f1rm/boards/<repo>.team.<team>.md`, with `<repo>` encoded as above, titled `# Board: <repo name> / <team>`, in the same table format, one row per task of its slice. On the PM's board a team is one row: owner `lead-<team>`, branch `-`, task the slice's goal.

## Review and merge flow

The Reviewer is the only role that merges, and it merges locally. Nobody pushes; the user pushes.

1. Receive from whoever hired you, the PM or your team's lead, the branch, its brief (the dev's `DONE` report is in its Inputs) and the base branch. The base branch defaults to the branch checked out in the main working directory. The main working directory is the parent of `git rev-parse --path-format=absolute --git-common-dir`.
2. Stop and report to the session in your `Report to` if the main working directory has uncommitted changes. Never stash or discard them.
3. Take the findings from the `/code-review <level>` that started your session. The review is that one; your own work is the gates below. On a code branch, also run `ponytail:ponytail-review`: its findings go in your report and never block. For work that is not code (founder work under `growth/`, and `docs/research/`), skip both and check the **content checklist** instead:
   - every acceptance criterion is met;
   - no claim is made up: every number, quote, testimonial and promise has a source or is marked as an assumption;
   - it follows `growth/brand.md`;
   - nothing in it was posted, published, sent or paid for.
4. If any finding blocks, send `CHANGES REQUESTED` and stop. Do not fix the code yourself. After the second `CHANGES REQUESTED` on one branch, send `ESCALATE <slug>` in place of a third; the PM decides with the user.
5. Otherwise, build the result in a scratch worktree, so the main working directory stays untouched until the result is verified. You run in the main working directory, and `<task>` is the task under review:
   - `git worktree add --detach .claude/worktrees/review-<task> <base>`.
   - In it, run each criterion's proving check on the base. It fails on the base; one that passes there proves nothing.
   - Then `git merge --no-ff <branch>`, where `<branch>` is `worktree-<task>`, and note the merge commit's sha.
   - On the merge, run each criterion's check, which passes, and the repo's full check command.
   - A criterion with no check, a check that passes on the base, and a failure on the merge all block: remove the scratch worktree and send `CHANGES REQUESTED`.
   - At `--level high`, run security-review with the Skill tool from the scratch worktree, with `<base>...<merge sha>` as its args. The office holds your approval until it has run.
6. Move the base branch to the verified result: in the main working directory, `git merge --ff-only <merge sha>`. If it fails because the base moved, remove the scratch worktree and repeat from step 5.
7. Remove the scratch worktree with `git worktree remove .claude/worktrees/review-<task>`. Then send `APPROVED` with the merged commit to the session in your `Report to`, only after main has moved: never for a merge that exists only in the scratch worktree.

Never run `git push`, never force, never rewrite published history, never merge a branch you did not review. Whoever hired the specialists, the PM or the team's lead, lets them go with `f1rm letgo <name>...` after `APPROVED`, the Reviewer included. It also deletes the finished branches and worktrees that are merged.

## Cap rule

`f1rm hire` enforces these, refusing with a non-zero exit and a message naming the cap:

- At most **6 background sessions working at once**, counted across the whole machine, not per repo. Leads, the Reviewer, the Researcher and the user's own background sessions all count.
- At most **2 teams** (live leads) per project.
- At most **2 working in a team**, its Reviewer included. A finished member frees its slot.
- **One specialist per task**, which no override skips. Split a task only into tasks that each have their own acceptance criteria and their own files.
- When it refuses a lead, the lead does not retry or override: it tells the PM and waits. The PM does not retry either.
- When it refuses the PM, or a lead tells the PM of a refusal, the PM leaves the task `todo`, tells the user why, and asks whether to wait or exceed the cap. Start the task when a slot frees if the user chooses to wait.
- Use the override flag of `f1rm hire` (`f1rm hire --override <role> <name> <task> "<brief>"`) only after the user has approved exceeding the cap in this conversation, for this hire. An earlier approval or your own judgment is not approval. Ask again for each later hire.

## Interns

- An employee runs **at most 2 interns** (sub-agents started with the Agent tool) at once. The office blocks a third.
- Use an intern only for a subtask that is independent of your other work, and run it on Haiku unless the subtask needs more.

## Gates

The office holds two gates with hooks. A refusal says which rule held the call, and each is logged to `~/.f1rm/office.log`. With the office stopped, neither runs.

- The **skill gate** holds a hire's work tools until it has loaded every skill its first prompt names. Reading tools, Skill and SendMessage are never held, and neither is a sub-agent such as the one `/code-review` forks. A high-level Reviewer's `APPROVED` is also held until it has run security-review. Way out: Load the skills with the Skill tool. If one is not installed, send `BLOCKED <slug>` naming it.
- The **delegation gate** holds the PM and leads to coordinating. Their Write and Edit work only in the boards, memory, evidence and scratch folders. Their Bash runs no `git commit`, `merge`, `push`, `rebase`, `reset` or `cherry-pick`. They start no `f1rm:*` role as an intern. Way out: put the work on the board and hire for it with `f1rm hire`. Landing is the Reviewer's, and pushing is the user's, who can run it with `!`.
- A specialist cannot run `f1rm hire`. Way out: ask the session in your `Report to`.

## Use what is installed

Before doing work by hand, check the skills, slash commands and plugins your session has, and use the ones that fit the task. Name the ones you used in your report.

## Definition of done

A task is done when all of these hold, and not before.

1. Every acceptance criterion has a check that fails without the change and passes with it.
2. The repo's full check command is green on the merged result.
3. The Reviewer has signed off with `APPROVED` and merged the branch locally into the base branch.
4. The board row says `done`. Founder work meant to go out passes through `publish` first, and is done when the user says it is out.

The PM reports a task to the user as done only on this basis. A hire's own `DONE` means ready for review. A team is done when every task on its board is done and its lead has sent `DONE <team>`.
