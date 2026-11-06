# f1rm

A pixel-art office for your Claude Code sessions. Every session on your Mac is an employee at a desk, in the office of the project it works on. You see who is working, reading, running a command, waiting for permission or on a coffee break. Someone shows as working only while their process is live and `claude agents` calls them busy or one of their hook events came in the last 90 seconds; otherwise they are idle, or offline once their process is gone. Click someone to jump to their terminal, ask them a question without interrupting them, or tell them something they read at their next step.

f1rm also ships a company: a Claude Code plugin with thirteen roles (PM, Team lead, Designer, Frontend dev, Backend dev, Reviewer, Researcher, Advisor and five Founder roles) and the guidelines they work by. You talk to the PM, which starts a team lead for each piece of work you ask for.

![The f1rm lobby, a Work project with its PM waiting for you at the table, the PM's panel, and a Founder project's launch team](docs/f1rm.gif)

## What you get

- **A lobby with a door per project.** Each door shows how many people are inside and whether someone is waiting for you. A door appears when you run `f1rm pm` in a project, and not before; sessions in folders without one wait under Elsewhere. Enter a door to see that project's office full screen.
- **Live employees.** Sessions you start in any terminal arrive as freelancers. Sessions started as a role, such as `claude --agent f1rm:designer`, take that role's desk and shirt. Everyone gets a name of their own. Sub-agents walk out as interns and leave when they finish.
- **The PM's table.** The PM, the one you talk to, sits at its own table in a glass corner, with a chair for you. When its turn ends, a "?" over your chair says it is waiting for your answer, and its panel's Talk button takes you to its terminal. A tap on the empty table starts a PM.
- **Work or Founder.** Each project is a Work project (the engineering company) or a Founder project, which adds a Marketer, an SEO specialist, Social media, Sales and a Strategist for your own products. You choose the first time you open a project; they draft, and you publish.
- **Teams.** Each topic is a team: ask the PM for work and it starts the topic's lead at once, or start one yourself with New topic; no cap counts teams. Each team is a pod on its own rug, its Team lead at the head and a sign that carries the team's board. A lead plans once, approves its own plan (it asks you only when the plan holds a product, design or business choice) and runs its tasks with implementer subagents, independent tasks in parallel; you talk to each lead in its own session (Jump), and the PM only tells you which lead needs you.
- **Jump.** Click an employee and press Jump to bring their exact iTerm2 tab to the front. `⌘K` searches everyone by name, role, project or task.
- **Ask.** A side question is answered by a read-only copy of the employee's session. Their work is never touched.
- **Tell.** A message the employee reads at their next step, without stopping a running tool.
- **Approvals.** You approve a project's command list once, on its "Commands for <project>" card: the office derives the commands the project needs (git, the test runner, the package manager), you tick them, and the office alone writes them into the repo's `.claude/settings.local.json`. After that a card reaches you only for a command outside the list, and no session approves, edits or widens it. That card waits for you in the office for 30 minutes, in a tray in the top bar and on the hire's desk, with the full command, who asks and why (the hire's last words). Approve once, Deny, or Always for this project, which adds exactly the allow rule Claude Code suggested for that request (the card shows it) to the repo's `.claude/settings.local.json`; with no suggestion there is no such button. A request nobody answers falls back to the hire's own prompt. A lead that waits on you, on a permission or an open question on its team board, is tagged "needs you".
- **Decisions.** A question only you can answer becomes a GitHub issue labelled `needs-decision`, with its options and a recommended answer. It waits in the Approvals tray, with a macOS notification when it opens; you answer there, and the office writes the answer onto the issue and starts the step that asked again. A low-risk one takes its recommendation after 4 hours with no answer; a high-risk one waits for you. A step that ends without moving its spec on is started once more; if it ends that way again, a decision ticket asks you to retry it, drop the spec or leave it to you.
- **Whiteboards.** Each project shows the PM's task board on the wall.
- **Plugin check.** The f1rm plugin installs from this folder and never updates by itself. While the installed one is older than the office's, the top bar says so, with the command that updates it (`claude plugin update f1rm@f1rm`).

## Quick start

You need macOS, [Bun](https://bun.sh) 1.3 or later, and Claude Code 2.1.300 or later. iTerm2 is the terminal Jump knows best. A session in a VS Code terminal brings its VS Code window forward.

```sh
git clone https://github.com/feiteiradev/f1rm && cd f1rm
bun install && bun run build
bun office/cli/f1rm.ts install                 # f1rm's hooks (your settings backed up first) and the f1rm command in ~/.local/bin
claude plugin marketplace add feiteiradev/f1rm && claude plugin install f1rm@f1rm   # the company
```

If `f1rm` isn't found, add `~/.local/bin` to your PATH, or use `bun office/cli/f1rm.ts` in its place. Then run **`f1rm`** in your project folder. It starts the office in the background if it isn't running, and shows that project in your office tab, or opens one. Every Claude Code session you start appears in the office.

The office keeps running after you close Claude Code and starts again at login, so the hooks always reach it. After a `git pull`, run `f1rm service` to restart it on the new code. Its log is `~/.f1rm/office.log`. The office keeps the same link across restarts, in `~/.f1rm/link-key`; if the link leaks, `rm ~/.f1rm/link-key` and run `f1rm service`, and the next `f1rm` opens a new link. `f1rm uninstall` removes exactly what `install` added, and keeps your event log, boards and editions.

## Commands

`f1rm install` puts the `f1rm` command in `~/.local/bin`; if that folder isn't on your PATH, add it, or use `bun office/cli/f1rm.ts` in its place.

| Command | What it does |
| :- | :- |
| `f1rm` | Opens the office on this project: installs or updates the hooks if needed, starts the background office if it isn't running, and shows the project in your office tab, or opens one. Prints one line. |
| `f1rm install` | Adds f1rm's hooks to `~/.claude/settings.json`, after backing it up, and the `f1rm` command to `~/.local/bin`. |
| `f1rm uninstall` | Removes exactly what `install` added, the `f1rm` command included. Keeps your event log, boards and editions in `~/.f1rm/`. |
| `f1rm start` | Opens the office in your browser and exits. If the office isn't running, starts the background office first, as `f1rm service` does. `f1rm serve` runs one in this terminal instead, until you stop it. |
| `f1rm service` | Runs the office in the background and at login. Run it again to restart it on new code. |
| `f1rm service off` | Stops the background office and removes it from login. Your sessions keep working; the hooks just go quiet. |
| `f1rm edition` | Prints this repo's edition. `f1rm edition work` or `f1rm edition founder` changes it, once `f1rm pm` has been run in the repo (it never creates a door). |
| `f1rm pm` | Registers this repo, which gives it a door in the lobby, and starts its PM in this terminal. Extra flags go to `claude`, for example `f1rm pm --model sonnet`. |
| `f1rm hire` | Starts a lead or a specialist in the background. The PM and leads run it; `f1rm hire --help` shows the syntax. Flags before the role: `--skills a,b` adds skills for one task (`--skills research` starts a Researcher on `/research`; any `pstack:` skill other than `pstack:poteto-mode` (devs only), `pstack:architect` and `pstack:how` (leads only) is refused), `--level low\|medium\|high` sets the level of a dev's own review (`high` also runs `security-review` on its diff), `--simple` is a legacy flag for a simple task with no lead and no team, which the PM no longer starts (a lead cannot hire a dev), `--content` starts a cheap Sonnet Reviewer for a branch with no code, and `--topic` makes the grilling interview a lead's first command (the PM starts a topic lead this way when you ask it for work). Every hire but a lead starts at ponytail `full`, a lead at your ponytail default. No cap counts sessions, teams or members; it refuses a second specialist on one task. Under a usage hold it waits for a free slot and asks nobody; after 8 minutes it exits 75 and the session runs the same command again. `--override` is yours alone (your terminal, the Hire dialog) and goes past the usage pacing; a session's is refused, as is any permission flag. |
| `f1rm merge` | `f1rm merge <task> [--check "<cmd>"] [--no-red "<reason>"]` lands a reviewed branch on main: the PM runs it for a simple task, a lead for its team's. It refuses a missing or moved `DONE`, a conflict, code without tests and a main with uncommitted changes in a file the merge changes (a dirty file it leaves alone does not block it), runs the new tests on the base (they must fail) and the suite once on the merge, then fast-forwards. `--check` names the suite command for a repo without a `check` script and is remembered per project; `--no-red` lands a test-only branch on a logged call (`~/.f1rm/kept/<repo>/calls.md`). A branch that touches `.claude/settings*.json`, `.claude/hooks/`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/` or `.mcp.json` is refused for everyone. It never pushes, and nothing else lands on main. |
| `f1rm push` | `f1rm push [--check "<cmd>"]` is the PM's push of the base branch to origin, once at the end of a milestone, after everything landed and the full suite is green. Fast-forward only, never force, never another branch; when origin has commits main lacks it pushes nothing and the end report says "not pushed: origin moved". A raw `git push` is refused for every session. |
| `f1rm letgo` | `f1rm letgo <name>...` lets finished hires go: it archives what they left unfinished (uncommitted and untracked files, unmerged commits) under `refs/f1rm/archive/<task>`, then stops them and removes their worktree and branch, with no prompt. `f1rm letgo --leftovers` does that for every worktree and `worktree-*` branch no live session works in. The PM and leads run it after `f1rm merge`. |
| `f1rm archives` | `f1rm archives` lists the archives with task, date and size; `f1rm archives --prune` deletes those older than 30 days and prints them. |
| `f1rm wake` | `f1rm wake <name\|id> [message]` resumes a stopped, blocked or done hire (or lead) of this project in the background, in its own worktree, with its history, name and report line. It runs the hire checks and waits on a usage hold the same way. The message cannot start with a slash: a resumed session would run it as a slash command. The PM wakes leads and a lead its own team's members. A message to a hire with no live process is refused with `no live session; f1rm wake <name>`. The office runs it by itself, once per stop, for hires and leads of a registered project that stopped on the session limit (a minute after the reset) or lost their process (an update, a crash) while their board row is `doing` or `review`; when it cannot, it tells the session they report to. |
| `f1rm pause` | `f1rm pause [reason...]` pauses this project: the office answers every hook of its hires with `continue:false`, so each stops at its next step, and 30 s later `claude stop` ends any still busy (conversation and worktree kept, never removed). While paused the office wakes, nudges and reports nothing for it, `f1rm wake` is refused, and `f1rm status` says `PAUSED`. The PM runs it for its own project; `--all` pauses every project and is yours, not an agent's (see Stop all and resume all). The flag lives in `~/.f1rm/paused/`, so a restart keeps it. |
| `f1rm resume` | `f1rm resume [--all]` clears the pause and, one hire at a time, tells the ones the pause halted whose process lives and wakes the ones whose process ended (only those whose board row is `doing` or `review`), waiting for a free slot under a usage hold. |
| `f1rm status` | `f1rm status [--json]` lists this repo's hires and what each is really doing: the last write to its transcript, the last commit on its branch, whether it ended, when a usage-limit stop lifts, and what the office's recovery noted (NOTE). It never trusts `claude agents`' status text, and `f1rm status --watch <names>` is what the PM and leads run in the background to watch their hires. |
| `f1rm report` | `f1rm report <KIND> <slug> [--commit <sha>] [--note "<one line>"]` is how a hire reports besides its message (`SendMessage` can return success and never arrive): it writes `~/.f1rm/evidence/<repo>/<slug>/report.json` with a rising `seq`, `f1rm status --watch` wakes the lead once per new `seq`, `f1rm status` shows it in its REPORT column, and the office counts it as a delivered report. KIND is DONE, APPROVED, CHANGES, NEEDS (for NEEDS YOU), BLOCKED or ESCALATE. |
| `f1rm demo` | Opens the recorded demo, with no server and no Claude Code. Needs `bun run build` first. |
| `f1rm serve` | Runs the office server in the foreground. This is what `service` runs. |

**Stop all and resume all.** You stop or resume every project at once in three places: the shell (`f1rm pause --all`, `f1rm resume --all`), the slash commands you type in any Claude Code session (/f1rm:stop-all and /f1rm:resume-all; no agent can run them), and the Stop all / Resume all button in the office's top bar (it asks once, then shows "All N stopped" with the checkpoint ids; while any project is paused it shows Resume all). A project's PM still pauses and resumes only its own project. What keeps agents out is that the two commands are skills only you can invoke (`disable-model-invocation`) and that `f1rm wake` refuses a message starting with a slash; the office's gate also refuses an agent's `--all` and a `claude` start whose prompt matches the commands, but that is best-effort text matching, like its other limits.

## Sleep

After the Mac sleeps (a gap of more than 2 minutes between the office's ticks) nobody is judged stalled, woken or nudged for 5 minutes. f1rm never keeps the Mac awake, and the office never pauses or resumes a project by itself.

## The company

Start a PM in the repo you want to work on: run `f1rm pm` in a terminal in that folder.

The PM does ops (no file changes) at once. Any other work you ask it for becomes a topic: the PM starts the topic's team lead at once with `f1rm hire --topic`, and the lead interviews you in its own session (Jump) on what your words leave open; you can also start a topic yourself with the office's New topic button. Every topic runs through its own team, even a one-task topic, and no cap counts teams. Each lead plans once and approves its own plan, runs its tasks with implementer subagents, asks you only the decisions that are yours (a product, design or business choice) as a numbered round with a recommended answer, checks their work, lands it with `f1rm merge` and sends the PM only `NEEDS YOU` and `DONE`. Each hire runs as a background session in its own git worktree. No cap counts sessions, teams or interns; under a usage hold a hire waits for a free slot and asks nobody. From a lead's start on, the PM tells you only when that lead needs you; otherwise it speaks up only for a big decision (business, product scope, design direction, strategy, spend, messaging or publishing to people, deleting data outside the repo), a Claude Code permission outside the approved command list, and one report at the end of the milestone; ask "status?" for more. Everything else is the company's call and is logged: technical choices, the plan, the milestone cleanup, a second blocking review round, a test-only branch and a merge conflict (`~/.f1rm/kept/<repo>/calls.md`), all listed in the report under "Decisions taken without you". Each lead asks at most three open scope questions per topic and writes every other gap as an assumption. A dev reviews its own branch inside its session (one review, one fix pass for the blocking findings; a second blocking round is the lead's call), and the rest of the findings are fixed in one batch task at the end of the milestone. Only `f1rm merge` lands a branch on main, locally; a Reviewer exists only for a branch with no code and does not merge. At the end of the milestone the PM cleans up, runs `f1rm push` and sends one report that says "pushed" or "not pushed: <reason>" and asks you for nothing. No session hands you a command to run. [`plugin/README.md`](plugin/README.md) has the details, and the `f1rm-guidelines` skill holds the rules the roles follow, including each role's [Workflows](plugin/skills/f1rm-guidelines/SKILL.md#workflows).

You can also hire from the office: the Hire button in a project, or a click on an empty desk, opens a dialog with the plugin's roles. Pick one, write a brief, and it starts the same way `f1rm hire` does. In a project with a PM, "Let the PM decide" sends your brief to them as a message instead. In one without, "Start PM" opens an iTerm tab in the repo running `f1rm pm`.

## Demo

`bun run build` builds a demo into `office/demo/dist`. It is plain static files: a recorded office session replayed in the browser, with no f1rm server and no Claude Code.

- Try it locally: `bun office/cli/f1rm.ts demo`, or serve the folder with any static file server, for example `python3 -m http.server -d office/demo/dist`.
- Deploy it: upload the contents of `office/demo/dist` to any static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel as a static site). Its assets use relative paths, so it works from a sub-path. Nothing is deployed from this repo for you.
- Re-record it: `bun run record-demo` runs the real server against a temporary HOME, plays `office/demo/scenario.ts` into it and writes the scrubbed log to `office/demo/fixture.json`. The scrub step (`office/demo/scrub.ts`) removes prompts, command and search arguments, absolute paths, private titles and secret-shaped strings, and refuses to write a fixture that still looks private. Read the fixture before you commit a new one.

## Security

The office can steer your sessions, so it is locked to you.

- The server listens on `127.0.0.1` only.
- The browser needs a fresh token on every launch. `start` prints the URL that carries it.
- Hooks need a separate secret written at install time. Every hook reads it from a file only you can read, so it never shows up in the process list. The hooks are quiet `curl` calls: with the office stopped they do nothing, and your sessions show no errors.
- Every request has its `Host` and `Origin` checked, and the server sends no CORS headers.
- Approvals show the full command before the Approve button, and each approval answers exactly one request. Only your browser answers: a session's call to the approve, deny or always routes is refused.

## Development

`bun run check` runs the tests, the typecheck and both builds, behind a per-repo lock (`scripts/check-lock.ts`): only one suite runs per repo at a time, a second caller waits and prints who holds it, and a lock whose holder died is taken over. `bun test <file>` stays unlocked. The `scripts/` folder holds the browser proofs (`lobby-proof.mjs`, `office-proof.mjs`, `jump-proof.mjs` and others) and `smoke.ts`, which re-checks the Claude Code behaviour f1rm relies on after an upgrade. `record-gif.mjs` re-records `docs/f1rm.gif` from the demo build.

## Credits

The office art is CC0 from Kenney, plus pixels drawn in code. See [CREDITS.md](CREDITS.md). f1rm is MIT licensed.
