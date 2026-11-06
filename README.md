# f1rm

A pixel-art office for your Claude Code sessions. Every session on your Mac is an employee at a desk, in the office of the project it works on. You see who is working, reading, running a command, waiting for permission or on a coffee break. Someone shows as working only while their process is live and `claude agents` calls them busy or one of their hook events came in the last 90 seconds; otherwise they are idle, or offline once their process is gone. Click someone to jump to their terminal, ask them a question without interrupting them, or tell them something they read at their next step.

f1rm also ships a company: a Claude Code plugin with a PM, the office's steps (tickets, implement, close), the roles a ticket's label picks (Designer, Researcher and five Founder roles), an advisor, and the rules they keep. You ask the PM for work; the office builds it, and asks you only what is yours to decide.

![The f1rm lobby, a Work project with its PM waiting for you at the table, the PM's panel, and a Founder project's launch team](docs/f1rm.gif)

## What you get

- **A lobby with a door per project.** Each door shows how many people are inside and whether someone is waiting for you. A door appears when you run `f1rm pm` in a project, and not before; sessions in folders without one wait under Elsewhere. Enter a door to see that project's office full screen.
- **Live employees.** Sessions you start in any terminal arrive as freelancers. Sessions started as a role, such as `claude --agent f1rm:designer`, take that role's desk and shirt. Everyone gets a name of their own. Sub-agents walk out as interns and leave when they finish.
- **The PM's table.** The PM, the one you talk to, sits at its own table in a glass corner, with a chair for you. When its turn ends, a "?" over your chair says it is waiting for your answer, and its panel's Talk button takes you to its terminal. A tap on the empty table starts a PM.
- **Work or Founder.** Each project is a Work project (the engineering company) or a Founder project, which adds a Marketer, an SEO specialist, Social media, Sales and a Strategist for your own products. You choose the first time you open a project; they draft, and you publish.
- **Specs.** Ask the PM for work, or press New spec: it interviews you on what your words leave open and publishes a spec on GitHub Issues. From there the office starts each step by itself: the tickets, then the build (test-first, on one integration branch per spec), then the close, which lands it on main with `f1rm merge`, pushes it and runs a retro. Each step sits at a desk while it works, its interns walking beside it, and ends with its work.
- **Jump.** Click an employee and press Jump to bring their exact iTerm2 tab to the front. `⌘K` searches everyone by name, role, project or task.
- **Ask.** A side question is answered by a read-only copy of the employee's session. Their work is never touched.
- **Tell.** A message the employee reads at their next step, without stopping a running tool.
- **Approvals.** You approve a project's command list once, on its "Commands for <project>" card: the office derives the commands the project needs (git, the test runner, the package manager), you tick them, and the office alone writes them into the repo's `.claude/settings.local.json`. After that a card reaches you only for a command outside the list, and no session approves, edits or widens it. That card waits for you in the office for 30 minutes, in a tray in the top bar and on the asking session's desk, with the full command, who asks and why (the session's last words). Approve once, Deny, or Always for this project, which adds exactly the allow rule Claude Code suggested for that request (the card shows it) to the repo's `.claude/settings.local.json`; with no suggestion there is no such button. A request nobody answers falls back to the session's own prompt. A step that waits on your answer to a permission request is tagged "needs you".
- **Decisions.** A question only you can answer becomes a GitHub issue labelled `needs-decision`, with its options and a recommended answer. It waits in the Approvals tray, with a macOS notification when it opens; you answer there, and the office writes the answer onto the issue and starts the step that asked again. A low-risk one takes its recommendation after 4 hours with no answer; a high-risk one waits for you. When a spec closes, a retro reads what it cost and where its steps stumbled, opens each unfixed review finding as a `needs-triage` issue and proposes at most three changes, each a draft spec with a decision ticket: Build it has the office build it, Drop it closes it. A step that ends without moving its spec on is started once more; if it ends that way again, a decision ticket asks you to retry it, drop the spec or leave it to you.
- **Whiteboards.** Each project's wall shows its live specs and their tickets, read from GitHub: the step at work on a spec, its cost in cost units and its coordination share, and each ticket's state, role and cost, marked when it is over its size's budget. A ticket past its budget while it is being built stops its step and asks you: give it 50% more, re-scope it yourself, or drop the spec.
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

The office keeps running after you close Claude Code and starts again at login, so the hooks always reach it. After a `git pull`, run `f1rm service` to restart it on the new code. Its log is `~/.f1rm/office.log`. The office keeps the same link across restarts, in `~/.f1rm/link-key`; if the link leaks, `rm ~/.f1rm/link-key` and run `f1rm service`, and the next `f1rm` opens a new link. `f1rm uninstall` removes exactly what `install` added, and keeps your event log and editions.

## Commands

`f1rm install` puts the `f1rm` command in `~/.local/bin`; if that folder isn't on your PATH, add it, or use `bun office/cli/f1rm.ts` in its place.

| Command | What it does |
| :- | :- |
| `f1rm` | Opens the office on this project: installs or updates the hooks if needed, starts the background office if it isn't running, and shows the project in your office tab, or opens one. Prints one line. |
| `f1rm install` | Adds f1rm's hooks to `~/.claude/settings.json`, after backing it up, and the `f1rm` command to `~/.local/bin`. |
| `f1rm uninstall` | Removes exactly what `install` added, the `f1rm` command included. Keeps your event log and editions in `~/.f1rm/`. |
| `f1rm start` | Opens the office in your browser and exits. If the office isn't running, starts the background office first, as `f1rm service` does. `f1rm serve` runs one in this terminal instead, until you stop it. |
| `f1rm service` | Runs the office in the background and at login. Run it again to restart it on new code. |
| `f1rm service off` | Stops the background office and removes it from login. Your sessions keep working; the hooks just go quiet. |
| `f1rm edition` | Prints this repo's edition. `f1rm edition work` or `f1rm edition founder` changes it, once `f1rm pm` has been run in the repo (it never creates a door). |
| `f1rm pm` | Registers this repo, which gives it a door in the lobby, and starts its PM in this terminal. Extra flags go to `claude`, for example `f1rm pm --model sonnet`. |
| `f1rm hire` | `f1rm hire <role> <name> <task> "<brief>"` starts a Designer, a Researcher, the advisor or a Founder role in the background, in its own worktree, from your own terminal. No session can run it: nobody in the company hires, the office starts the steps. Under a usage hold it waits for a free slot; `--override` goes past it. |
| `f1rm merge` | `f1rm merge spec-<n> [--check "<cmd>"] [--no-red "<reason>"]` lands a spec's integration branch on main: the close step runs it. It refuses a conflict, code without tests and a main with uncommitted changes in a file the merge changes, runs the new tests on the base (they must fail) and the suite once on the merge, then fast-forwards, and says on its output each call it made on its runner's word (`--no-red`, a suite change). A branch that touches `.claude/settings*.json`, `.claude/hooks/`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/` or `.mcp.json` is refused for everyone. It never pushes, and nothing else lands on main. |
| `f1rm push` | `f1rm push [--check "<cmd>"]` pushes the base branch to origin after a spec landed and the full suite is green: the close step runs it. Fast-forward only, never force, never another branch; when origin has commits main lacks it pushes nothing and says "not pushed: origin moved". A raw `git push` is refused for every session. |
| `f1rm letgo` | `f1rm letgo <name>...` stops background sessions and removes their worktree and branch, archiving what they left unfinished (uncommitted and untracked files, unmerged commits) under `refs/f1rm/archive/<task>` first. `f1rm letgo --leftovers` does that for every worktree and `worktree-*` branch no live session works in. |
| `f1rm archives` | `f1rm archives` lists the archives with task, date and size; `f1rm archives --prune` deletes those older than 30 days and prints them. |
| `f1rm pause` | `f1rm pause [reason...]` pauses this project: the office answers every hook of its sessions with `continue:false`, so each stops at its next step, and 30 s later `claude stop` ends any still busy (conversation and worktree kept, never removed). While paused the office starts no step in it, and `f1rm status` says `PAUSED`. `--all` pauses every project and is yours, not a session's (see Stop all and resume all). The flag lives in `~/.f1rm/paused/`, so a restart keeps it. |
| `f1rm resume` | `f1rm resume [--all]` clears the pause; the office starts again each step that the pause stopped, waiting for a free slot under a usage hold. |
| `f1rm status` | `f1rm status [--json]` lists this repo's background sessions and what each is really doing: the last write to its transcript, the last commit on its branch, whether it ended, and when a usage-limit stop lifts. It never trusts `claude agents`' status text. |
| `f1rm cost` | Prints each spec of this repo in cost units: its coordination, each ticket, the rest, the total, the coordination share, and the tickets over their size's warning. The close step's retro reads it. |
| `f1rm demo` | Opens the recorded demo, with no server and no Claude Code. Needs `bun run build` first. |
| `f1rm serve` | Runs the office server in the foreground. This is what `service` runs. |

**Stop all and resume all.** You stop or resume every project at once in three places: the shell (`f1rm pause --all`, `f1rm resume --all`), the slash commands you type in any Claude Code session (/f1rm:stop-all and /f1rm:resume-all; no agent can run them), and the Stop all / Resume all button in the office's top bar (it asks once, then shows "All N stopped" with the checkpoint ids; while any project is paused it shows Resume all). A project's PM still pauses and resumes only its own project. What keeps agents out is that the two commands are skills only you can invoke (`disable-model-invocation`) and that `f1rm wake` refuses a message starting with a slash; the office's gate also refuses an agent's `--all` and a `claude` start whose prompt matches the commands, but that is best-effort text matching, like its other limits.

## Sleep

After the Mac sleeps (a gap of more than 2 minutes between the office's ticks) the office judges no step failed for 5 minutes. f1rm never keeps the Mac awake, and the office never pauses or resumes a project by itself.

## The company

Start a PM in the repo you want to work on: run `f1rm pm` in a terminal in that folder.

The PM does ops (no file changes) at once. Any other work you ask it for becomes a spec: it asks only what your words leave open (a small ask gets a one-line understanding instead), publishes the spec on GitHub Issues labelled `ready-for-agent`, and stops. The office does the rest from the issues: `tickets-<n>` publishes the tickets, `implement-<n>` builds them test-first on `spec-<n>`, `close-<n>` checks the spec's acceptance criteria, lands it, pushes and runs a retro. You decide only what is yours (business, product scope, design direction, strategy, spend, publishing, deleting data outside the repo, authentication, secrets, user data, money), in the office's tray; everything else is the company's call, written on the spec and its tickets. Sessions don't message each other (a step talks only to its own interns): they read and write the issues and git. [`plugin/README.md`](plugin/README.md) has the details, and the `f1rm-guidelines` skill holds the rules.

You can also start from the office: the New spec button in a project, or a click on an empty desk, opens an iTerm tab in the repo running `f1rm pm`, which interviews you and publishes the spec.

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
