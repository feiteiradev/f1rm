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
- A refusal on a counted cap makes it wait for a free slot; it asks nobody, and `--override` is refused to every session. On exit 75 run the same command again, and run a hire that may wait with `run_in_background` or `timeout` 600000, since the default Bash timeout is 2 minutes. Any other refusal: leave the task `todo` and tell the session you report to.
