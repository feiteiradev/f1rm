---
name: hire
description: Hire a lead or a specialist with `f1rm hire`, which starts it in its own background session (a specialist also in its own worktree) and refuses past the caps (30 working sessions on the machine, 2 teams per project, 2 working per team, 1 specialist per task). Use whenever the PM or a lead starts a task.
argument-hint: <role> <name> <task> "<brief>"
---

# Hire

Run `f1rm hire $ARGUMENTS` with the Bash tool from the repo's main working directory, and report what it prints.

- Roles, names, task slugs and the brief format are in the `f1rm:f1rm-guidelines` skill. Load it first if it is not in context.
- Never start a hire by calling `claude` yourself. The cap lives in `f1rm hire`.
- If it refuses at the cap, do not retry. Leave the task `todo` and tell the session you report to. Only the PM asks the user, and only after the user approves this hire is it rerun with --override.
