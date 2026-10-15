---
name: hire
description: Hire a specialist for one task on the board with `f1rm hire`, which starts it in its own background session and worktree and refuses past the firm's cap of 4 working hires. Use whenever the PM starts a task.
argument-hint: <role> <name> <task> "<brief>"
---

# Hire

Run `f1rm hire $ARGUMENTS` with the Bash tool from the repo's main working directory, and report what it prints.

- Roles, names, task slugs and the brief format are in the `f1rm:f1rm-guidelines` skill. Load it first if it is not in context.
- Never start a hire by calling `claude` yourself. The cap lives in `f1rm hire`.
- If it refuses at the cap, do not retry. Leave the task `todo`, tell the user, and ask whether to wait or exceed the cap. Add `--override` only after the user approves this hire.
