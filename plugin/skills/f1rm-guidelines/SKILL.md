---
name: f1rm-guidelines
description: How the f1rm company works. The spec flow on GitHub Issues (PM, tickets, implement, close), the office's steps and retries, decision tickets, role labels, cost units and budgets, what the gates enforce, editions and drafts, the decisions log and the living spec. Load before changing how f1rm works.
---

# f1rm rules

The office runs the company. A session needs none of this to do its step: its prompt says what to do. This file says what holds across steps, so a change to f1rm keeps it whole.

## The flow

1. **The ask.** The user asks the PM for work (`f1rm pm`, or New spec in the office). The PM checks the repo's issue tracker is set up for the spec skills, interviews the user on what their words leave open, and ends on 3 to 5 **examples** of what the user will see when it is done, which the user confirms. Work with something to see or use gets a **prototype** of the target (the `prototype` skill, with `design-pipeline` for UI, design or branding when installed) next to a screenshot of main now; nothing is published until the user accepts it. The spec starts with the **ask** in the user's own words and its `## Examples`, with the screenshots in a comment, is labelled `ready-for-agent`, and the PM stops. A small ask (one ticket, about 3 files, no product, design or business choice) gets "I'll do X. Done = you see Y." as its one example instead, and goes on at the user's "go".
2. **Tickets.** The office starts `tickets-<n>`, whose first command is `/mattpocock-skills:to-tickets`. It publishes the spec's tickets as sub-issues with native blocking edges, each with a `Boundary:` line (the files it owns, so parallel interns never collide), a `Depends:` line (the tickets it waits for) and a `Serves:` line (the examples it serves; work that serves none is Out of scope, not a ticket). With 3 or more tickets the first is the thinnest end-to-end slice of example 1. It labels each ticket that is not code with its role, comments the breakdown on the spec, and ends. The breakdown is the company's call. A spec of more than one ticket gets a **fresh-eyes review** first: one intern whose whole prompt is to follow `agents/fresh-eyes.md`, knowing nothing but the ask, the examples, the tickets and their `Boundary:` files on main, writes the **preview** (a diagram and a table: on main now with `path:line`, after, the example that asks for it), posted on the spec word for word. With no row marked unasked or contradicting an example, the tickets are labelled `ready-for-agent`; otherwise a high-risk decision ticket asks Go as planned, I'll re-scope it, or Drop the spec, and nothing is built before Go.
3. **Implement.** Once a ticket is unblocked, the office starts `implement-<n>`, whose first command is `/mattpocock-skills:implement-spec`. The slice of example 1, once merged, is posted on the spec (the command and its output, a screenshot for something visible), and work goes on. Interns build each ticket test-first in their own worktree on `ticket-<number>`, mergers bring them one at a time onto the integration branch `spec-<n>`, one code review and one fix pass run at the end, and each ticket is closed with a comment naming its merge commit. Main is not touched.
4. **Close.** Once every ticket is closed, the office starts `close-<n>`. It checks each example of the spec once on `spec-<n>`; at the first close a failing one becomes one more ticket, and the spec gets one more implement and close round (`-2`), the last. It lands `spec-<n>` with one `f1rm merge spec-<n>`, runs `f1rm push`, deletes the spec's branches, and closes the spec with a Mermaid diagram built from the real diff, a ✅/❌ table per example with its evidence (screenshots of main before and after for what can be seen), at most 3 lines, and an `Intent:` line (examples passed at the first close, the user's comments, whether the preview led to a correction). Then it runs the retro.
5. **Retro.** The close step follows the retro skill with nobody to ask, on measured evidence (`f1rm cost`, the gate's refusals of its steps, the review comments). Each review finding left unfixed becomes a `needs-triage` issue. When the last 5 closed specs' `Intent:` lines show no preview correction, one change it proposes is dropping the fresh-eyes review. It proposes at most three changes (a role prompt, a rule, a ticket template or a check), each a draft spec with no label and a high-risk decision ticket: Build it has the office label the draft `ready-for-agent`, Drop it closes it. It changes no file itself.

## Steps

- **The user steers by comment.** Each step first reads the user's comments on the spec since it last started: a small change becomes one more ticket, a change of scope a high-risk decision ticket. A comment takes effect at the next step, never mid-step.
- **One session per step.** A step is a background session named `tickets-<n>`, `implement-<n>` or `close-<n>` (a second round adds `-2`), with agent `f1rm:step`, started in the repo's main folder. It ends with its step; nothing waits in a live session for a human or another session.
- **Who starts them.** Only the office, about once a minute, from the issues. Only issues, labels and comments by the user's own GitHub account count. A spec whose tickets the office did not publish is the user's to drive. One step of a spec runs at a time.
- **Retries.** A step that is no longer running while what started it is still there (a spec with no tickets, an unblocked ticket left, a spec still open with every ticket closed) failed, unless it waits on a decision ticket it opened. It is judged only 3 minutes after it started. It starts once more (a ticket closed since its last start is progress, not a failure); a second failure opens a decision ticket: Retry it, Drop the spec, or Leave it to me.
- **Pause.** A paused project's sessions stop at their next step, and the office starts nothing in it until `f1rm resume`. A usage hold (5-hour window at 90%, weekly at 95%) stops every new step until the window resets; nothing running is stopped for it.

## Decision tickets

What only the user can decide becomes a GitHub issue labelled `needs-decision`, and the step that asked ends.

- **Format.** The body starts with `<!-- f1rm:decision risk=<low|high> step=<step name> spec=<spec number> recommended=<option number> -->`, then the question, then the options as a numbered list. Optional fields name options by number: `restart=` (the options that start the asking step again; all of them when absent), `drop=` (close the spec as not planned), `ready=` (label the spec `ready-for-agent`).
- **Risk.** High is business, product scope, design direction, strategy, spend, publishing to people, deleting data outside the repo, authentication, secrets, user data or money. Anything else is low. A risk that is not `low` is high.
- **Answering.** The office shows every open one in its tray with a macOS notification, and only the user's browser answers it; a session's command that names the answer route is refused. The office closes the ticket with the answer as its comment, writes it on the spec, and starts the asking step again (a tickets step too, though its tickets exist). A low-risk ticket nobody answers takes its recommendation 4 hours after it opened, never while the project is paused; a high-risk one waits while other tickets go on.
- **Advisor.** Before a step opens a high-risk decision ticket on a product, design or business choice, it starts one intern that reads `agents/advisor.md` in this plugin and runs its `test` task on the decision, then pastes the advisor's verdict line under the question, word for word. A STRAINS or BREAKS verdict makes the recommendation the user's to confirm, never a default.

## Roles

Nobody hires. A ticket's `role:<name>` label picks the skills its intern loads in place of `tdd`, read from that role's file:

- `role:designer` and `role:researcher` in every project;
- `role:marketer`, `role:seo-specialist`, `role:social-media`, `role:sales` and `role:strategist` in a Founder project only;
- no role label: code, built test-first.

A ticket whose role label is none of these is left open with a comment naming it. The PM (`f1rm:pm`) and the steps (`f1rm:step`) are the only sessions the office or the user starts; the advisor's and fresh-eyes' instructions are read by a step's intern.

## Cost and budgets

- **Cost units** weigh tokens by API price relative to input: input 1, cache write 1.25, cache read 0.1, output 5, each message counted once. Anthropic does not publish how the subscription weighs tokens, so price is the proxy.
- **Attribution.** A step's own turns and the publishing PM's are its spec's coordination; an intern counts toward the ticket branch it starts; interns that start none (review, merges, the fix pass) are the spec's other work. `f1rm cost` prints it per spec, and the office's wall shows each ticket's cost and each spec's coordination share.
- **Budgets.** Each ticket size (`size:s`, `size:m`, `size:l`; none counts as medium) has a budget: 1.5 times its measured median cost (small and large are not measured yet, so theirs only mark the ticket). Past it the wall marks the ticket, and past a measured one while the implement step builds it the office stops that step and opens a high-risk decision ticket: Give it 50% more (the ticket's budget grows half again and the step starts again), I'll re-scope it, or Drop the spec.

## What the gates enforce

The office's hooks hold these for every company session; the user's own sessions are never held.

- Nobody hires: `f1rm hire` is refused to every company session.
- Sessions talk through issues and git: a session messages only its own interns, and an intern only its parent.
- Only `f1rm merge` lands on main, run by a step or the PM in the main folder; it refuses a branch that touches Claude Code settings, hooks, commands, agents, skills or `.mcp.json`, code without tests, and new tests that pass on the base.
- Only `f1rm push` reaches a remote, run by a close step or the PM: fast-forward, never force.
- An intern writes, commits and merges only inside its own worktree; the PM writes only scratch files and its repo's tracker setup (`CLAUDE.md`, `AGENTS.md`, `docs/agents/`); a step writes only scratch files.
- Claude Code's settings and hooks are closed to every session; a project's command list is approved once by the user, in the office.
- A permission request and a decision ticket are answered only in the office.
- The PM pauses and resumes its own project and prunes the archives; a step lets go of the sessions and worktrees it started (`f1rm letgo`); `--all` on pause and resume is the user's alone; a session starts no `claude --bg` or `claude -p` of its own.

## Editions and drafts

- **Work or Founder.** The user chooses each project's edition (the office asks on the first entry; `f1rm edition work|founder` changes it). A Founder project's tickets may take the Founder roles.
- **Drafts only.** Founder work is drafted under `growth/` and lands like code. Nothing is posted, published, sent, scheduled or paid for by a session: publishing is a high-risk decision ticket, and the user puts it out.

## Docs in each repo

- **The decisions log.** `docs/decisions.md`, append-only, oldest first: `## <YYYY-MM-DD> <title>` then `- Decision:`, `- Why:`, `- Rejected:` and `- Where:`. A core decision (a feature or behaviour the user chose, a refactor or architecture choice, a cap, limit, dependency or version change, anything rejected for a reason) gets an entry in the commit that makes it; bug fixes and wording get none. The file is `merge=union` in `.gitattributes`. A repo with `docs/adr/` links to its ADRs.
- **The living spec.** `docs/spec.md` says what the software does now, one short present-tense section per capability. A ticket that changes a behaviour edits its section in the same commit; existing behaviour is never backfilled. A repo whose `CLAUDE.md` names other living-spec files uses those.
- **The glossary.** A repo's `GLOSSARY.md`, when it has one, holds its domain words; specs and tickets use them.

## Docker

A ticket that starts containers, networks or volumes runs `f1rm docker-tag <task>` first and uses the compose project name and labels it prints, and removes what it started. Nobody prunes, and nobody touches an untagged resource or an image.
