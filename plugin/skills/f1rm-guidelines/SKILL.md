---
name: f1rm-guidelines
description: How the f1rm company works. Roster and hiring, teams and leads, briefs, who talks to whom, boards, the Reviewer's merge flow, the caps and done. Load before planning, hiring, reviewing or merging.
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
| `reviewer` | Review and local merge of every finished branch | `code-review`, `f1rm:f1rm-guidelines`, `security-review` |
| `researcher` | A question that needs current, cited facts | `research` |

Playbook:

1. **Interview first.** Plan only after the user confirms a shared understanding.
2. **One task, one hire, one worktree.** A task that needs two roles is two tasks.
3. **Order by dependency.**
   - Researcher before any task whose approach depends on facts you lack.
   - Designer before Frontend dev on UI work, with the spec path in the Frontend brief.
   - Backend dev and Frontend dev in parallel only when the brief fixes the API contract between them.
   - Reviewer after every finished branch, and for every branch.
4. **Small tasks.** Each task fits one session and has acceptance criteria that a check can prove.
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
   - `--report-to <session>` before the role overrides the PM session name. It defaults to `pm-<repo basename>`.
   - Run it in the repo's main working directory. Background sessions run only in folders the user has trusted.
   - It prints `backgrounded · <id>` and exits 0 on success, and exits non-zero with a message when it refuses.
6. **Name** each hire `<role>-<task slug>`, for example `designer-landing`; a team member `<team>.<role>-<task slug>`, for example `checkout.designer-landing`; a lead `lead-<team>`. `f1rm hire` refuses any other name. Team and task slugs are lowercase words joined by hyphens, unique on their board.
7. **Slash commands.** The brief of a hire starts with its role's first skill as a slash command, for example `/design-pipeline` or `/research`. Only the first slash command in a prompt expands, so `f1rm hire` names the role's other skills in the brief and the hire loads them with the Skill tool before starting. `/research` is a command, not a Skill-tool skill, so it is always a role's first entry. `/security-review` is built in, and the Reviewer loads it with the Skill tool. `f1rm hire` writes all of this and the `Report to` line, so do not write them in the brief yourself.
8. **Role prompts stay about the work.** Do not give a hire a persona or a character name in a brief.

## Teams

1. **When.** The PM forms teams only for a milestone with two or more slices that can run in parallel. Smaller work keeps the PM hiring specialists directly, because a lead costs a session and a hop.
2. **What a team owns.** One vertical slice of the milestone, end to end (design, frontend, backend), with its own acceptance criteria. Name the team after its slice, for example `checkout`.
3. **At most 2 teams** work in a project at once. In a milestone with teams, the PM hires only leads; every task of that milestone goes through a team.
4. **No nested teams.** Only the PM hires leads, and a lead hires only specialists, only into its own team.
5. **Order.** The PM orders teams by dependency, as it orders tasks. When a team needs only a contract from another (an API shape, a shared file), the two leads agree on it directly.
6. **PLAN before hiring.** A lead writes its team board, then sends the PM `PLAN <team>` with its tasks and the hires it intends. The PM checks the plan against the milestone and the caps and answers `GO <team>`, or the changes it wants. The lead hires nothing before `GO`. The PM asks the user only if the plan needs a decision.
7. **Closing.** When every task of the team is approved and merged, the lead lets its specialists go (`claude stop <id>`, then `claude rm <id>`, ids from ListAgents), removes worktrees that are left (`git worktree remove`), and sends the PM `DONE <team>` with the merged commits. The PM then lets the lead go the same way and marks the team's row `done`.

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

Your session name is `pm-<repo basename>`. `f1rm pm` starts the session with `--name pm-<repo basename>` and states the name in your first prompt. `f1rm hire` fills in `Report to` with it, so pass `--report-to` only if you were started another way. A lead's hires report to `lead-<team>`, which `f1rm hire --team` fills in. The ListAgents tool shows your hires and their state. The Reviewer's brief also names the branch to review, the base branch, and the brief of the task under review.

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
- **The user may talk to anyone.** An Ask is a read-only side question whose answer goes straight to the user. A Tell is an instruction: act on it, then tell the session in your `Report to` (a lead tells the PM) what changed, so nobody above you is surprised.

## Handoff via SendMessage

- A deliverable is commits on the hire's worktree branch. Messages carry status and pointers, never the work itself.
- A hire reports with the SendMessage tool to the session named in `Report to` (the PM, or its team's lead), once when done and once if blocked. Use one of these first lines:
  - `DONE <slug> branch=<branch> commit=<sha>` then a short summary and the check results.
  - `BLOCKED <slug>` then the question or the missing input.
  - `APPROVED <slug> merged=<sha>` from the Reviewer, after the merge.
  - `CHANGES REQUESTED <slug>` from the Reviewer, then the blocking findings with file and line.
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
- **status.** One of `todo`, `doing`, `review`, `done`, `blocked`. `doing` means a hire is working. `review` means the branch awaits the Reviewer. `done` follows Reviewer sign-off only.
- **branch.** `worktree-<task slug>`, or `-` before hiring.
- **task.** One line, without `|`.
- One row per task. Update the row in place. Never delete rows.
- **Team boards.** A lead's board is `~/.f1rm/boards/<repo>.team.<team>.md`, with `<repo>` encoded as above, titled `# Board: <repo name> / <team>`, in the same table format, one row per task of its slice. On the PM's board a team is one row: owner `lead-<team>`, branch `-`, task the slice's goal.

## Review and merge flow

The Reviewer is the only role that merges, and it merges locally. Nobody pushes.

1. Receive from whoever hired you, the PM or your team's lead, the branch, its brief and the base branch. The base branch defaults to the branch checked out in the main working directory. The main working directory is the parent of `git rev-parse --path-format=absolute --git-common-dir`.
2. Stop and report to the session in your `Report to` if the main working directory has uncommitted changes. Never stash or discard them.
3. Review the diff `base...branch` with the code-review skill. Add the security-review skill when the change touches authentication, user data, secrets, permissions, network input or shell execution. Check each acceptance criterion's proving check.
4. If any finding blocks, send `CHANGES REQUESTED` and stop. Do not fix the code yourself.
5. Otherwise, in the Reviewer's own worktree:
   - `git reset --hard <base>` on the Reviewer's throwaway branch, then `git merge --no-ff <branch>`.
   - Run the repo's full check command on that result. If it fails, send `CHANGES REQUESTED` with the failure.
6. Move the base branch to the verified result: `git -C <main working directory> merge --ff-only <reviewer branch>`. If it fails because the base moved, repeat from step 5.
7. Send `APPROVED` with the merged commit to the session in your `Report to`.

Never run `git push`, never force, never rewrite published history, never merge a branch you did not review. Whoever hired the specialists, the PM or the team's lead, lets them go and deletes their finished branches and worktrees, not the Reviewer.

## Cap rule

`f1rm hire` enforces these, refusing with a non-zero exit and a message naming the cap:

- At most **6 background sessions working at once**, counted across the whole machine, not per repo. Leads, the Reviewer, the Researcher and the user's own background sessions all count.
- At most **2 teams** (live leads) per project.
- At most **2 working in a team**, its Reviewer included. A finished member frees its slot.
- **One specialist per task**, which no override skips. Split a task only into tasks that each have their own acceptance criteria and their own files.
- When it refuses a lead, do not retry or override: tell the PM. When it refuses the PM, leave the task `todo`, tell the user why, and ask whether to wait or exceed the cap. Start the task when a slot frees if the user chooses to wait.
- Use the override flag of `f1rm hire` (`f1rm hire --override <role> <name> <task> "<brief>"`) only after the user has approved exceeding the cap in this conversation, for this hire. An earlier approval or your own judgment is not approval. Ask again for each later hire.

## Interns

- An employee runs **at most 2 interns** (sub-agents started with the Agent tool) at once. The office blocks a third.
- Use an intern only for a subtask that is independent of your other work, and run it on Haiku unless the subtask needs more.

## Use what is installed

Before doing work by hand, check the skills, slash commands and plugins your session has, and use the ones that fit the task. Name the ones you used in your report.

## Definition of done

A task is done when all of these hold, and not before.

1. Every acceptance criterion has a check that fails without the change and passes with it.
2. The repo's full check command is green on the merged result.
3. The Reviewer has signed off with `APPROVED` and merged the branch locally into the base branch.
4. The board row says `done`.

The PM reports a task to the user as done only on this basis. A hire's own `DONE` means ready for review. A team is done when every task on its board is done and its lead has sent `DONE <team>`.
