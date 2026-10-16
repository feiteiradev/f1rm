# f1rm

A pixel-art office for your Claude Code sessions. Every session on your Mac is an employee at a desk, in the office of the project it works on. You see who is working, reading, running a command, waiting for permission or on a coffee break. Click someone to jump to their terminal, ask them a question without interrupting them, or tell them something they read at their next step.

f1rm also ships a company: a Claude Code plugin with six roles (PM, Designer, Frontend dev, Backend dev, Reviewer, Researcher) and the guidelines they work by. You talk to the PM. The PM hires the rest.

![The f1rm lobby, a project office with its PM waiting for you at the table, and the PM's panel](docs/f1rm.gif)

## What you get

- **A lobby with a door per project.** Each door shows how many people are inside and whether someone is waiting for you. Enter a door to see that project's office full screen.
- **Live employees.** Sessions you start in any terminal arrive as freelancers. Sessions started as a role, such as `claude --agent f1rm:designer`, take that role's desk and name. Sub-agents walk out as interns and leave when they finish.
- **The PM's table.** The PM, the one you talk to, sits at its own table in a glass corner, with a chair for you. When its turn ends, a "?" over your chair says it is waiting for your answer, and its panel's Talk button takes you to its terminal. A tap on the empty table starts a PM.
- **Jump.** Click an employee and press Jump to bring their exact iTerm2 tab to the front. `⌘K` searches everyone by name, role, project or task.
- **Ask.** A side question is answered by a read-only copy of the employee's session. Their work is never touched.
- **Tell.** A message the employee reads at their next step, without stopping a running tool.
- **Approvals.** Permission prompts collect in a tray in the top bar, with the full command, so you can approve or deny from anywhere. Unanswered prompts fall back to the terminal.
- **Whiteboards.** Each project shows the PM's task board on the wall.

## Quick start

You need macOS, [Bun](https://bun.sh) 1.3 or later, and Claude Code 2.1.300 or later. iTerm2 is the terminal Jump knows best. A session in a VS Code terminal brings its VS Code window forward.

```sh
git clone https://github.com/feiteiradev/f1rm && cd f1rm
bun install && bun run build
bun office/cli/f1rm.ts install   # adds f1rm's hooks to ~/.claude/settings.json, after backing it up
bun office/cli/f1rm.ts start     # opens the office in your browser
```

Sessions you start after `install` appear in the office. `bun office/cli/f1rm.ts uninstall` removes exactly what `install` added, and keeps your event log and boards.

To keep the office running in the background and at login, so the hooks always reach it, run `f1rm service` once. Run it again after a `git pull` to restart the office on the new code. `f1rm start` then just opens the page, and `f1rm service off` removes the background office. Its log is `~/.f1rm/office.log`.

## The company

Install the plugin, then start a PM in the repo you want to work on:

```sh
claude plugin marketplace add feiteiradev/f1rm
claude plugin install f1rm@f1rm
bun /path/to/f1rm/office/cli/f1rm.ts pm
```

The PM interviews you, writes the task board, and hires specialists with `f1rm hire`. Each hire runs as a background session in its own git worktree. At most four hires work at once unless you approve more. The Reviewer checks every change and is the only one who merges, locally, never pushing. [`plugin/README.md`](plugin/README.md) has the details, and the `f1rm-guidelines` skill holds the rules the roles follow.

You can also hire from the office: the Hire button in a project, or a click on an empty desk, opens a dialog with the plugin's roles. Pick one, write a brief, and it starts the same way `f1rm hire` does. In a project with a PM, "Let the PM decide" sends your brief to them as a message instead. In one without, "Start PM" opens an iTerm tab in the repo running `f1rm pm` (`f1rm` must be on the PATH of your iTerm shell).

## Demo

`bun run build` builds a demo into `office/demo/dist`. It is plain static files: a recorded office session replayed in the browser, with no f1rm server and no Claude Code.

- Try it locally: `bun office/cli/f1rm.ts demo`, or serve the folder with any static file server, for example `python3 -m http.server -d office/demo/dist`.
- Deploy it: upload the contents of `office/demo/dist` to any static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel as a static site). Its assets use relative paths, so it works from a sub-path. Nothing is deployed from this repo for you.
- Re-record it: `bun run record-demo` runs the real server against a temporary HOME, plays `office/demo/scenario.ts` into it and writes the scrubbed log to `office/demo/fixture.json`. The scrub step (`office/demo/scrub.ts`) removes prompts, command and search arguments, absolute paths, private titles and secret-shaped strings, and refuses to write a fixture that still looks private. Read the fixture before you commit a new one.

## Security

The office can steer your sessions, so it is locked to you.

- The server listens on `127.0.0.1` only.
- The browser needs a fresh token on every launch. `start` prints the URL that carries it.
- Hooks need a separate secret written at install time. The SessionStart hook reads it from a file only you can read, so it never shows up in the process list.
- Every request has its `Host` and `Origin` checked, and the server sends no CORS headers.
- Approvals show the full command before the Approve button, and each approval answers exactly one request.

## Development

`bun run check` runs the tests, the typecheck and both builds. The `scripts/` folder holds the browser proofs (`lobby-proof.mjs`, `office-proof.mjs`, `jump-proof.mjs` and others) and `smoke.ts`, which re-checks the Claude Code behaviour f1rm relies on after an upgrade. `record-gif.mjs` re-records `docs/f1rm.gif` from the demo build.

## Credits

The office art is CC0 from Kenney, plus pixels drawn in code. See [CREDITS.md](CREDITS.md). f1rm is MIT licensed.
