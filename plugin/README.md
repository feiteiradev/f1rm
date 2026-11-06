# f1rm plugin

The f1rm company for Claude Code: the PM, the office's step agent, the roles a ticket's label picks, the advisor, and the `f1rm-guidelines` skill that holds the rules, plus two commands only you can run: `/f1rm:stop-all` and `/f1rm:resume-all`.

## Install

The repo root is a Claude Code marketplace named `f1rm`, and this folder is its one plugin.

```sh
claude plugin marketplace add feiteiradev/f1rm
claude plugin install f1rm@f1rm
```

From a local checkout, add the marketplace by path instead:

```sh
claude plugin marketplace add /path/to/f1rm
claude plugin install f1rm@f1rm
```

A local marketplace is read in place, so edits to the role files apply at the next session start.

To try the plugin for one session without installing it, point `claude` at this folder:

```sh
claude --plugin-dir ./plugin --agent f1rm:designer
```

The plugin name is fixed as `f1rm`. Role memory lives in `~/.claude/agent-memory/f1rm-<role>/`, so renaming the plugin would orphan it.

## Roles

- **PM** (`f1rm:pm`, started by `f1rm pm` or the office's New spec). It checks the repo's issue tracker is set up for the spec skills, interviews you on what your ask leaves open, publishes the spec on GitHub Issues labelled `ready-for-agent`, and stops.
- **Office step** (`f1rm:step`). The office starts one for each step of a spec, named `tickets-<n>`, `implement-<n>` or `close-<n>`, and it ends with its step. Its first command is the step's skill (`/mattpocock-skills:to-tickets`, `/mattpocock-skills:implement-spec`), or the close's own prompt.
- **Ticket roles.** A ticket that is not code carries a `role:` label, and its intern loads that role's skills from its file, in place of `tdd`: Designer and Researcher in every project, Marketer, SEO specialist, Social media, Sales and Strategist in a Founder project.
- **Advisor** (`f1rm:advisor`). Before a step opens a high-risk decision ticket on a product, design or business choice, one of its interns reads the advisor's file and runs its `test` task, and the verdict goes into the ticket.

Nobody hires and no session messages another: the office starts each step from the issues, and the steps read and write the issues and git. A question only you can answer becomes a decision ticket in the office's tray. The rules are in [`skills/f1rm-guidelines/SKILL.md`](skills/f1rm-guidelines/SKILL.md).

## Files

- `agents/*.md`: the PM, the office step, the advisor and the ticket roles.
- `skills/f1rm-guidelines/SKILL.md`: the rules: the flow, the steps and their retries, decision tickets, roles, cost units and budgets, what the gates enforce, editions and drafts, the docs each repo keeps.
- `skills/stop-all`, `skills/resume-all`: the commands only you can run.
- `plugin.test.ts`: checks the roles, the rules and a real install into a throwaway config.
