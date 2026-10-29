---
name: hire
description: Hire a lead or a specialist with `f1rm hire`, which starts it in its own background session (a specialist also in its own worktree) and refuses past the caps (8 working sessions on the machine, 2 teams per project, 2 working per team, 1 specialist per task). Use whenever the PM or a lead starts a task.
argument-hint: <role> <name> <task> "<brief>"
---

# Hire

Run `f1rm hire $ARGUMENTS` with the Bash tool from the repo's main working directory, and report what it prints.

- Roles, names, task slugs and the brief format are in the `f1rm:f1rm-guidelines` skill. Load it first if it is not in context.
- The PM hires a lead for a milestone (`f1rm hire lead lead-<team> <team> "<team brief>"`) and, for a simple task, one dev, designer or researcher with `f1rm hire --simple <role> <name> <task> "<brief>"`: no lead, no team, named `<role>-<task>`, reporting to the PM. A lead hires only specialists other than devs and `--content` Reviewers into its team (`--team <team>`), never a dev.
- Never start a hire by calling `claude` yourself. The cap lives in `f1rm hire`.
- If it refuses at the cap, do not retry. Leave the task `todo` and tell the session you report to. The lead asks the user in its own session (the PM, for a hire of its own), and only after the user approves this hire in that conversation is it rerun with --override.
