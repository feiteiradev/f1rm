# f1rm plugin

The f1rm company for Claude Code: thirteen roles, the `f1rm-guidelines` skill, and the `hire` skill, which runs `f1rm hire`, plus two commands only you can run: `/f1rm:stop-all` and `/f1rm:resume-all` pause and resume every project. It works from a plain terminal. The office app is only a view of it.

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
| PM | `f1rm:pm` | `f1rm:f1rm-guidelines` | sonnet |
| Team lead | `f1rm:lead` | `f1rm:f1rm-guidelines`, `f1rm:hire` | sonnet |
| Designer | `f1rm:designer` | `design-pipeline` | sonnet |
| Frontend dev | `f1rm:frontend-dev` | `pstack:poteto-mode`, `mattpocock-skills:tdd` | sonnet |
| Backend dev | `f1rm:backend-dev` | `pstack:poteto-mode`, `mattpocock-skills:tdd` | sonnet |
| Reviewer (content only) | `f1rm:reviewer` | `code-review`, `f1rm:f1rm-guidelines`, `ponytail:ponytail-review`, `mattpocock-skills:code-review` | opus |
| Researcher | `f1rm:researcher` | `mattpocock-skills:research` | sonnet |
| Advisor | `f1rm:advisor` | `mattpocock-skills:domain-modeling`, `mattpocock-skills:research` | opus |
| Marketer (Founder) | `f1rm:marketer` | `cro`, `anthropic-skills:content-creator`, `brandkit` | sonnet |
| SEO specialist (Founder) | `f1rm:seo-specialist` | `seo-audit`, `ai-seo` | sonnet |
| Social media (Founder) | `f1rm:social-media` | `social`, `content-calendar-sms`, `anthropic-skills:fabrica`, `hook-writer-sms`, `carousel-writer-sms` | sonnet |
| Sales (Founder) | `f1rm:sales` | `anthropic-skills:6-first-customers-acquisition-plan`, `anthropic-skills:7-fast-revenue-strategy` | sonnet |
| Strategist (Founder) | `f1rm:strategist` | `anthropic-skills:1-startup-idea-validator`, `anthropic-skills:2-profitable-niche-finder`, `anthropic-skills:3-customer-pain-point-researcher`, `anthropic-skills:4-lean-startup-business-plan-builder` | sonnet |

The PM does ops at once and starts a topic lead for any other work; it starts no simple task (`--simple` is a legacy flag: a simple task already running reports `DONE` to the PM, which lands it with `f1rm merge` and lets it go). In a milestone you talk to each lead directly, in its own session (Jump), and the PM tells you which lead needs you, plus a big decision (the guidelines' "Ask the user only for big decisions": technical choices are made by the PM or the lead, and the hires log the core ones), something only you can do, and one report at the end of a milestone, with a "Decisions taken without you" line, that asks nothing of you and says whether main was pushed. A hire's permission request waits for you in the office for at least 30 minutes, on a card with the command, who asks and why: approve it once, deny it, or allow it Always for this project; a lead that waits on you (a permission, or an open question on its team board) is tagged "needs you". Every topic runs through its own team, even a one-task topic, and no cap counts teams: when you ask the PM for work it starts the topic's Team lead at once with `f1rm hire --topic`, or you start one with the office's New topic button. A lead plans its slice once and approves its own plan (it asks you only for a product, design or business choice in it), then runs its tasks with implementer subagents (independent tasks in parallel, each in its own worktree) and cannot hire a dev; it hires a designer, a researcher or a Founder role only for work that stands alone, and an advisor before a core decision. It checks each `DONE` against its brief, lands it with `f1rm merge`, works out contracts with the other leads, asks you its decisions as a numbered round with its recommended answer (a core decision first goes to an advisor, which tests it against the why of your product; a STRAINS or BREAKS verdict comes to you even where you told the lead to take its recommended options), and sends the PM only `NEEDS YOU` and `DONE`, with its findings in `~/.f1rm/kept/<repo>/findings.md`. Specialists never hire: the office's hook blocks `f1rm hire` for them. The same hook holds each hire's work tools until it has loaded the skills its brief names, keeps the PM and leads to boards, milestones, memory, evidence and scratch files, and refuses every `git push` and `gh pr merge`, so only the PM's `f1rm push` reaches a remote. Two documents keep the why: the PM's milestones file `~/.f1rm/milestones/<repo>.md`, outside the repo, where a finished milestone shrinks to a 5-line record after the PM's own cleanup (what to keep in `~/.f1rm/kept/<repo>/`, what to delete), which its end report lists, and `docs/decisions.md` in the repo, which hires append to in their commits. Working files (research, plans, proofs, findings) stay outside the repo in `~/.f1rm/evidence/<repo>/`. A dev reviews its own branch inside its session: one review in a fresh context, one fix pass for the blocking findings, and a second blocking round goes to its owner as `ESCALATE`, who decides and logs it; the non-blocking findings wait in `~/.f1rm/kept/<repo>/findings.md` for one batch task at the end of the milestone. Only `f1rm merge` lands a branch on main: it runs the new tests on the base (they must fail), the full suite once on the merge, and fast-forwards; a merge conflict goes back to the dev to rebase. A Reviewer exists only for a branch with no code (`--content`) and does not merge. A dev runs the full suite once per round and records it, and the PM or lead checks the record without rerunning the suite. Devs start with pstack's `/pstack:poteto-mode` and load mattpocock's `tdd` second; the guidelines' Skill stack table says which skill runs in each phase and which f1rm rule wins. Each role's steps, and the skill or command at each step, are in the guidelines' [Workflows](skills/f1rm-guidelines/SKILL.md#workflows) section.

Every project is a **Work** or a **Founder** project, which you choose the first time you open it (or with `f1rm edition work|founder`, once `f1rm pm` has registered the project). Work is the engineering company. Founder adds the five go-to-market roles, which draft under `growth/` and never post, publish, send or spend: approved work waits on the PM's board as `publish` for you to put out.

Every role has `memory: user`, so it keeps what it learns across projects. The skill names are the ones installed on the author's machine. Edit the `skills:` lists in `agents/` to match yours.

## Skills load through slash commands

Claude Code does not apply a role's `skills:` list when the role is the session agent (`--agent`). The files keep the list for use as subagents, and the launcher loads the skills as a slash command at the start of the first prompt:

- `f1rm pm` runs `claude --agent f1rm:pm --name pm-<repo basename> "Your session name is pm-<repo basename>. ..."`, so its hires know where to report. The PM interviews no one: each topic lead interviews you in its own session. Extra arguments go to `claude`, for example `f1rm pm --model sonnet`.
- `f1rm hire <role> <name> <task> "<brief>"` does the same for each hired role: it starts the brief with the role's `skills:`, adds the session to report to (the PM, or `lead-<team>` with `--team <team>`), and, under a usage hold, waits for a free slot and asks nobody (`--override` is refused to a session); no cap counts sessions, teams or members, and it always refuses a second specialist on one task. `f1rm merge <task>` lands a reviewed branch on main (the PM runs it for a simple task, a lead for its team's; nothing else lands there). `f1rm letgo <name>...` lets finished hires go and deletes their merged worktrees and branches; the PM and leads run it after `f1rm merge`. `f1rm wake <name|id> [message]` resumes a stopped, blocked or done hire (or lead) of this project in place, in its own worktree, with its history, name and `Report to`; the PM wakes leads and its simple tasks' devs, and a lead its own team's members, it runs the hire checks and waits on a usage hold like a hire, and the office's gate answers a message to a hire with no live process with `no live session; f1rm wake <name>`. The office also wakes, by itself and once per stop, the hires and leads of a registered project that stopped on the session limit or lost their process while their board row is `doing` or `review`, and nudges once a live idle hire whose turn ended without a report; when it cannot wake one it tells the session that hire reports to, and `f1rm status` shows the NOTE. `f1rm status [--json]` lists this repo's hires by real activity (transcript and commit times, `ended`, `limitUntil`), and `f1rm status --watch <names>` is the background watcher the PM and leads run (see Watching and waking in the guidelines). `f1rm hire lead lead-<team> <team> "<team brief>"` starts a lead, in the repo itself with no worktree; with `--topic` before `lead` its first command is the grilling interview, which is how the PM starts a topic lead when you ask it for work. Flags before the role tune the brief: `--skills a,b` adds skills (`--skills research` makes `/research` the first command, for a question about community practice; `--skills pstack:architect` or `pstack:how` does the same for a lead, because the Skill tool refuses those two; any `pstack:` skill other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only) is refused), `--level low|medium|high` sets the level of a dev's own review (`high` also runs `security-review` on its diff; `--skills security-review` is refused), `--simple` is the legacy flag of a simple task with no lead and no team, which the PM no longer starts (a lead's `--team` hire of a dev is refused), and `--content` starts a Reviewer for a branch with no code on the guidelines and sonnet (the only Reviewer there is). Every hire but a lead (and every `f1rm wake` of one) starts at ponytail `full` through the session's `--settings` env; a lead keeps the ponytail default from the user's config.
- `f1rm report <KIND> <slug> [--commit <sha>] [--note "<one line>"]` is run by a hire before it sends a report, so the report is also `~/.f1rm/evidence/<repo>/<slug>/report.json`, which `f1rm status --watch` wakes the lead for, once per new `seq`, and the office counts as delivered: `SendMessage` can return success while the message never arrives.
- By hand, put the slash command first: `claude --agent f1rm:designer "/design-pipeline <brief>"`.

## Files

- `agents/*.md`: the thirteen roles.
- `skills/f1rm-guidelines/SKILL.md`: the hiring playbook, each role's workflows, editions and the founder playbook, drafts only, teams, the brief and team brief formats, who talks to whom, the evidence handoff, boards, review inside the session and `f1rm merge`, the cap rule, interns, the gates, using what is installed, and the definition of done.
- `plugin.test.ts`: checks the roles, the guidelines and a real install into a throwaway config.
