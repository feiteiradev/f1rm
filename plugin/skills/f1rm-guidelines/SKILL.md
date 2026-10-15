---
name: f1rm-guidelines
description: How the f1rm company works. The roster and hiring playbook, brief format, handoff via SendMessage, task board format, Reviewer merge flow, 4-hire cap and definition of done. Load before planning, hiring, reviewing or merging.
---

# f1rm guidelines

These rules bind every f1rm role. Nothing here needs the office app. The office only displays the sessions and the board.

Hierarchy: the user, then one PM per repo, then specialists hired per task. The Reviewer and the Researcher are shared staff that any PM can hire. There is no layer between the PM and the specialists.

## Roster and hiring playbook

| Role | Hire for | Slash commands `f1rm hire` starts the brief with |
| :- | :- | :- |
| `pm` | Started by the user with `f1rm pm`. Never hired. | `mattpocock-skills:grilling` |
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
5. **Hire only with `f1rm hire`**. Never start a hire by calling `claude` yourself, because the cap lives in `f1rm hire`.

   ```
   f1rm hire <role> <name> <task> "<brief>"
   ```

   - `<role>` is `designer`, `frontend-dev`, `backend-dev`, `reviewer` or `researcher`.
   - `<name>` and `<task>` follow rule 6. The task slug becomes the worktree `.claude/worktrees/<task>` and its branch `worktree-<task>`.
   - `<brief>` is one quoted argument in the brief format below, without the `Report to` line. `f1rm hire` adds it.
   - Flags after the brief go to `claude`, for example `--model haiku`.
   - `--report-to <session>` before the role overrides the PM session name. It defaults to `pm-<repo basename>`.
   - Run it in the repo's main working directory. Background sessions run only in folders the user has trusted.
   - It prints `backgrounded · <id>` and exits 0 on success, and exits non-zero with a message when it refuses.
6. **Name** each hire `<role>-<task slug>`, for example `designer-landing`. The task slug is lowercase words joined by hyphens, unique on the board.
7. **Slash commands.** The brief of a hire starts with its role's first skill as a slash command, for example `/design-pipeline` or `/research`. Only the first slash command in a prompt expands, so `f1rm hire` names the role's other skills in the brief and the hire loads them with the Skill tool before starting. `/research` is a command, not a Skill-tool skill, so it is always a role's first entry. `/security-review` is built in, and the Reviewer loads it with the Skill tool. `f1rm hire` writes all of this and the `Report to` line, so do not write them in the brief yourself.
8. **Role prompts stay about the work.** Do not give a hire a persona or a character name in a brief.

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

Your session name is `pm-<repo basename>`. `f1rm pm` starts the session with `--name pm-<repo basename>` and states the name in your first prompt. `f1rm hire` fills in `Report to` with it, so pass `--report-to` only if you were started another way. The ListAgents tool shows your hires and their state. The Reviewer's brief also names the branch to review, the base branch, and the brief of the task under review.

## Handoff via SendMessage

- A deliverable is commits on the hire's worktree branch. Messages carry status and pointers, never the work itself.
- A hire reports with the SendMessage tool to the PM session named in `Report to`, once when done and once if blocked. Use one of these first lines:
  - `DONE <slug> branch=<branch> commit=<sha>` then a short summary and the check results.
  - `BLOCKED <slug>` then the question or the missing input.
  - `APPROVED <slug> merged=<sha>` from the Reviewer, after the merge.
  - `CHANGES REQUESTED <slug>` from the Reviewer, then the blocking findings with file and line.
- A hire never messages the user or another hire. It answers the PM, and the PM relays.
- The PM answers a `BLOCKED` message with the missing input, a re-scoped task, or a question to the user, then updates the board.
- Messages arrive between tool calls. A PM waiting on hires says so to the user and stops, instead of polling.

## Board format

Each repo has one board file, written only by the PM. It lives outside the repo, so project repos stay clean.

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

## Review and merge flow

The Reviewer is the only role that merges, and it merges locally. Nobody pushes.

1. Receive from the PM the branch, its brief and the base branch. The base branch defaults to the branch checked out in the main working directory. The main working directory is the parent of `git rev-parse --path-format=absolute --git-common-dir`.
2. Stop and report to the PM if the main working directory has uncommitted changes. Never stash or discard them.
3. Review the diff `base...branch` with the code-review skill. Add the security-review skill when the change touches authentication, user data, secrets, permissions, network input or shell execution. Check each acceptance criterion's proving check.
4. If any finding blocks, send `CHANGES REQUESTED` and stop. Do not fix the code yourself.
5. Otherwise, in the Reviewer's own worktree:
   - `git reset --hard <base>` on the Reviewer's throwaway branch, then `git merge --no-ff <branch>`.
   - Run the repo's full check command on that result. If it fails, send `CHANGES REQUESTED` with the failure.
6. Move the base branch to the verified result: `git -C <main working directory> merge --ff-only <reviewer branch>`. If it fails because the base moved, repeat from step 5.
7. Send `APPROVED` with the merged commit.

Never run `git push`, never force, never rewrite published history, never merge a branch you did not review. The PM, not the Reviewer, deletes finished branches and worktrees.

## Cap rule

- At most **4 hired employees working at once**, counted across the whole firm, not per repo. The Reviewer and the Researcher count.
- `f1rm hire` refuses at 4 working hires, with a non-zero exit and a message.
- When it refuses, leave the task `todo`, tell the user why, and ask whether to wait or exceed the cap. Start the task when a slot frees if the user chooses to wait.
- Use the override flag of `f1rm hire` (`f1rm hire --override <role> <name> <task> "<brief>"`) only after the user has approved exceeding the cap in this conversation, for this hire. An earlier approval or your own judgment is not approval. Ask again for each later hire.

## Definition of done

A task is done when all of these hold, and not before.

1. Every acceptance criterion has a check that fails without the change and passes with it.
2. The repo's full check command is green on the merged result.
3. The Reviewer has signed off with `APPROVED` and merged the branch locally into the base branch.
4. The board row says `done`.

The PM reports a task to the user as done only on this basis. A hire's own `DONE` means ready for review.
