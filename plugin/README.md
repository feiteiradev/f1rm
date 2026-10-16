# f1rm plugin

The f1rm company for Claude Code: seven roles, the `f1rm-guidelines` skill and the `hire` skill, which runs `f1rm hire`. It works from a plain terminal. The office app is only a view of it.

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
| Reviewer | `f1rm:reviewer` | `code-review`, `f1rm:f1rm-guidelines` | opus |
| Researcher | `f1rm:researcher` | none | sonnet |

Only the PM talks to you. For a milestone with slices that can run in parallel, the PM forms up to two teams and hires a Team lead for each; a lead plans its slice, gets the PM's `GO`, hires its own specialists (at most two working at a time), works out contracts with the other leads, and reports to the PM. Specialists never hire: the office's hook blocks `f1rm hire` for them.

Every role has `memory: user`, so it keeps what it learns across projects. The skill names are the ones installed on the author's machine. Edit the `skills:` lists in `agents/` to match yours.

## Skills load through slash commands

Claude Code does not apply a role's `skills:` list when the role is the session agent (`--agent`). The files keep the list for use as subagents, and the launcher loads the skills as a slash command at the start of the first prompt:

- `f1rm pm` runs `claude --agent f1rm:pm --name pm-<repo basename> "/mattpocock-skills:grilling Your session name is pm-<repo basename>. ..."`, so the PM interviews you before it plans and its hires know where to report. Extra arguments go to `claude`, for example `f1rm pm --model sonnet`.
- `f1rm hire <role> <name> <task> "<brief>"` does the same for each hired role: it starts the brief with the role's `skills:` and slash-only commands, adds the session to report to (the PM, or `lead-<team>` with `--team <team>`), and refuses past the caps (6 working sessions on the machine, 2 teams per project, 2 working per team) unless `--override` is given, and always refuses a second specialist on one task. `f1rm hire lead lead-<team> <team> "<team brief>"` starts a lead, in the repo itself with no worktree. `/research` (Researcher) and `/security-review` (Reviewer) are slash commands, not Skill-tool skills, so they appear only there and in no `skills:` list.
- By hand, put the slash command first: `claude --agent f1rm:designer "/design-pipeline <brief>"`.

## Files

- `agents/*.md`: the seven roles.
- `skills/f1rm-guidelines/SKILL.md`: the hiring playbook, teams, the brief and team brief formats, who talks to whom, handoff, boards, the review and merge flow, the caps, interns, using what is installed, and the definition of done.
- `plugin.test.ts`: checks the roles, the guidelines and a real install into a throwaway config.
