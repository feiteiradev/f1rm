# f1rm plugin

The f1rm company for Claude Code: twelve roles, the `f1rm-guidelines` skill, the `hire` skill, which runs `f1rm hire`. It works from a plain terminal. The office app is only a view of it.

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

| Role | Agent | Skills | Model |
| :- | :- | :- | :- |
| PM | `f1rm:pm` | `mattpocock-skills:grilling`, `f1rm:f1rm-guidelines` | opus |
| Team lead | `f1rm:lead` | `f1rm:f1rm-guidelines`, `f1rm:hire` | sonnet |
| Designer | `f1rm:designer` | `design-pipeline` | sonnet |
| Frontend dev | `f1rm:frontend-dev` | `mattpocock-skills:tdd` | sonnet |
| Backend dev | `f1rm:backend-dev` | `mattpocock-skills:tdd` | sonnet |
| Reviewer | `f1rm:reviewer` | `code-review`, `f1rm:f1rm-guidelines`, `ponytail:ponytail-review` | opus |
| Researcher | `f1rm:researcher` | `mattpocock-skills:research` | sonnet |
| Marketer (Founder) | `f1rm:marketer` | `cro`, `anthropic-skills:content-creator`, `brandkit` | sonnet |
| SEO specialist (Founder) | `f1rm:seo-specialist` | `seo-audit`, `ai-seo` | sonnet |
| Social media (Founder) | `f1rm:social-media` | `social`, `content-calendar-sms`, `anthropic-skills:fabrica`, `hook-writer-sms`, `carousel-writer-sms` | sonnet |
| Sales (Founder) | `f1rm:sales` | `anthropic-skills:6-first-customers-acquisition-plan`, `anthropic-skills:7-fast-revenue-strategy` | sonnet |
| Strategist (Founder) | `f1rm:strategist` | `anthropic-skills:1-startup-idea-validator`, `anthropic-skills:2-profitable-niche-finder`, `anthropic-skills:3-customer-pain-point-researcher`, `anthropic-skills:4-lean-startup-business-plan-builder` | sonnet |

Only the PM talks to you. For a milestone with slices that can run in parallel, the PM forms up to two teams and hires a Team lead for each; a lead plans its slice, gets the PM's `GO`, hires its own specialists (at most two working at a time), works out contracts with the other leads, and reports to the PM. Specialists never hire: the office's hook blocks `f1rm hire` for them. The same hook holds each hire's work tools until it has loaded the skills its brief names, and keeps the PM and leads to the board, memory, evidence and scratch files. The Reviewer runs in the repo itself and merges from a scratch worktree. Each role's steps, and the skill or command at each step, are in the guidelines' [Workflows](skills/f1rm-guidelines/SKILL.md#workflows) section.

Every project is a **Work** or a **Founder** project, which you choose the first time you open it (or with `f1rm edition work|founder`). Work is the engineering company. Founder adds the five go-to-market roles, which draft under `growth/` and never post, publish, send or spend: approved work waits on the PM's board as `publish` for you to put out.

Every role has `memory: user`, so it keeps what it learns across projects. The skill names are the ones installed on the author's machine. Edit the `skills:` lists in `agents/` to match yours.

## Skills load through slash commands

Claude Code does not apply a role's `skills:` list when the role is the session agent (`--agent`). The files keep the list for use as subagents, and the launcher loads the skills as a slash command at the start of the first prompt:

- `f1rm pm` runs `claude --agent f1rm:pm --name pm-<repo basename> "/mattpocock-skills:grilling Your session name is pm-<repo basename>. ..."`, so the PM interviews you before it plans and its hires know where to report. Extra arguments go to `claude`, for example `f1rm pm --model sonnet`.
- `f1rm hire <role> <name> <task> "<brief>"` does the same for each hired role: it starts the brief with the role's `skills:`, adds the session to report to (the PM, or `lead-<team>` with `--team <team>`), and refuses past the caps (30 working sessions on the machine, 2 teams per project, 2 working per team) unless `--override` is given, and always refuses a second specialist on one task. `f1rm letgo <name>...` lets finished hires go and deletes their merged worktrees and branches; the PM and leads run it after `APPROVED`. `f1rm hire lead lead-<team> <team> "<team brief>"` starts a lead, in the repo itself with no worktree. Flags before the role tune the brief: `--skills a,b` adds skills (`--skills research` makes `/research` the first command, for a question about community practice), `--level low|medium|high` sets the Reviewer's `/code-review` level (`high` also has it run `security-review` on the merge, before `APPROVED`; `--skills security-review` is refused), and `--content` starts a Reviewer for a branch with no code on the guidelines and sonnet.
- By hand, put the slash command first: `claude --agent f1rm:designer "/design-pipeline <brief>"`.

## Files

- `agents/*.md`: the twelve roles.
- `skills/f1rm-guidelines/SKILL.md`: the hiring playbook, each role's workflows, editions and the founder playbook, drafts only, teams, the brief and team brief formats, who talks to whom, the evidence handoff, boards, the review and merge flow, the caps, interns, the gates, using what is installed, and the definition of done.
- `plugin.test.ts`: checks the roles, the guidelines and a real install into a throwaway config.
