# Decisions

Core decisions, oldest first. The rules are in the f1rm guidelines, "Milestones and decisions".

## 2026-10-14 Founding decisions

- Decision: the 28 decisions of the f1rm spec.
- Why: settled in the first grilling.
- Rejected: copying them here.
- Where: https://github.com/feiteiradev/f1rm/issues/1

## 2026-10-19 Plugin 0.2.0 drops the /f1rm skill from cached installs

- Decision: bump to 0.2.0 when the /f1rm skill was removed.
- Why: a cached plugin install kept the deleted skill until the version changed.
- Rejected: none.
- Where: T2, ae73e09

## 2026-10-19 Machine cap on working background sessions is 30

- Decision: raise the machine-wide cap from 6 to 30. It stays one constant, CAP in office/cli/hire.ts, which the server imports.
- Why: the user runs several PMs across projects at once, and 7 were already working when a hire was refused.
- Rejected: a setting or env var (not needed yet); raising the team, per-team or per-task caps.
- Where: T3, a936f49

## 2026-10-19 A bare f1rm fails like f1rm start when the office doesn't start

- Decision: a bare f1rm exits 1 through the same startBackgroundOffice() as f1rm start, and prints the install notes to stderr before the error.
- Why: exit 0 hid the failure, and the user must still learn that settings.json was backed up and edited.
- Rejected: a second failure path in open().
- Where: T4, c65fb2e; T5, b3640ab

## 2026-10-19 Milestones outside the repo, decisions inside it

- Decision: ~/.f1rm/milestones/<repo>.md written by the PM and deleted when a milestone is reached; docs/decisions.md in the repo, written by hires in their commits.
- Why: hires see only the repo, git keeps the why with the code, the PM may only write outside the repo, and the Reviewer needs a clean main checkout.
- Rejected: both in the repo (every milestone status change would be a commit); both outside (hires couldn't read the decisions, and no history); one ADR file per decision (one log is simpler, and existing ADRs get linked).
- Where: T6

## 2026-10-19 Plugin 0.3.0

- Decision: bump to 0.3.0.
- Why: 0.2.0 was pushed before the cap and document rules changed, so cached installs would keep the old text.
- Rejected: none.
- Where: T6

## 2026-10-20 Stable office link key

- Decision: the office's URL token is kept in ~/.f1rm/link-key (mode 0600, like ingest-headers) and reused on every `serve` start, until the user deletes it. A missing or malformed file (not 43 base64url characters) gets a new key; a file others can read is made 0600 again. `f1rm uninstall` deletes it with the other install state (ingest-headers, office-url), so a reinstall starts a new link.
- Why: a restart made a new token, so an open tab got 401 on every POST until the user opened the new URL.
- Rejected: a new token on every start; keeping the key through uninstall (the office is gone then, so the tabs are dead anyway, and a leftover key would outlive the install).
- Where: G1, link-key commit (see `git log -- office/cli/f1rm.ts`)

## 2026-10-20 PM hires only leads

- Decision: every milestone runs through one or two Team leads, even a one-task milestone. The PM hires only leads; its own Haiku Explore interns are the one exception. This replaces "teams only for 2+ slices" and the PM-without-teams hiring form.
- Why: the PM's chat with the user stays free of hire traffic.
- Rejected: the PM hiring specialists directly for small work.
- Where: rules-prose (the gate that enforces it is gate-hire-push)

## 2026-10-20 Leads filter team traffic

- Decision: a lead receives all of its team's messages, checks each specialist's DONE against its brief, reruns the checks before it hires the Reviewer, and sends the PM only `PLAN <team>`, `BLOCKED` for what needs the user, and one `DONE <team>` (a 5-line summary and a link to `~/.f1rm/evidence/<repo>/findings.md`). The PM answers PLAN with GO without telling the user, unless the plan changes agreed scope or a decision. Unprompted, the PM tells the user only a decision it needs, something only the user can do (a permission, spend, credentials or inputs, a git push, a dirty main checkout), and one end-of-milestone report ending with the `git push` line. The Reviewer still signs off and is the only role that merges.
- Why: research, PRs and reports from hires arrived in the middle of the PM chat and made it confusing. The board and the findings file hold the rest, and the user asks "status?" for more.
- Rejected: per-task status reports from leads to the PM.
- Where: rules-prose

## 2026-10-20 Reviewer conflict and tip rules

- Decision: if the scratch merge conflicts, the Reviewer runs `git merge --abort`, removes the scratch worktree and sends `CHANGES REQUESTED <slug> conflict`; the dev rebases its unpushed branch onto the current main, resolves it, reruns its checks and sends a new DONE. The Reviewer never resolves conflicts and lands only when the branch tip equals the commit in the dev's DONE, else `BLOCKED <slug> tip moved`. On an `index.lock` error it retries after a few seconds. The merge flow is otherwise unchanged.
- Why: the Reviewer stays a checker, and what lands is what the dev reported.
- Rejected: a landing lock (`--ff-only` already refuses a base that moved); rebasing or squashing on landing; a new `f1rm land` command.
- Where: rules-prose

## 2026-10-20 Only the user pushes

- Decision: the gate refuses `git push` in any form and `gh pr merge` for every hire, and the Reviewer's `reset`, `rebase`, `cherry-pick`, `revert`, `am`, `pull`, `clean`, `branch -D`, `--force` and `-f`, except `git worktree remove --force .claude/worktrees/red-<task>`. The guidelines' Gates section and the Reviewer file say so.
- Why: the no-push rule was prompt-only, and a prompt can be got around.
- Rejected: `disallowedTools: Bash(git push *)`, which removes the whole Bash tool.
- Where: rules-prose (the gate is gate-hire-push)

## 2026-10-20 Milestone cleanup

- Decision: working files never enter the repo; research notes, plans, proofs and findings live in `~/.f1rm/evidence/<repo>/`. Hires add `keep: <path> — <why>` to their DONE for anything a later milestone needs, and leads pass those on. At milestone end the PM's report lists Persist (moves to `~/.f1rm/kept/<repo>/`, never deleted automatically) and Delete (the milestone's evidence folders, briefs, findings file, research, plans and done board rows). The user may move items between the groups, and the PM acts only after the user replies. The milestone's section in the milestones file becomes a 5-line record: what shipped (task ids and landing commits), how to try it, what is open. `docs/decisions.md` and git history stay. This replaces "Never delete rows" and "deletes the section when the milestone is reached".
- Why: boards, briefs and research pile up after a milestone, and the user decides what is worth keeping.
- Rejected: deleting on its own at the end of the milestone.
- Where: rules-prose

## 2026-10-20 Plugin 0.4.0

- Decision: bump to 0.4.0.
- Why: the working rules changed, so cached installs would keep the old text.
- Rejected: none.
- Where: rules-prose

## 2026-10-20 The page reconnects forever, backing off to every 5 s

- Decision: the page's live connection retries after 1 s, 2 s, 4 s, then every 5 s with no limit, and shows "Office is down — run `f1rm`" while it is down; the office's first message on each connection replaces the state, and the back-off starts over only on that first message. When the socket drops, one GET of the page's own address tells the two causes apart: a 401 shows "This link is out of date — open the office with `f1rm`" in the banner, anything else keeps "Office is down". A 401 from any action says "This link is out of date — open the office with `f1rm`".
- Why: an office restart left the page frozen with its ghosts; a cap would leave a long-open tab frozen again, and 5 s is cheap against a local server.
- Rejected: a retry limit (the tab freezes after a long outage); a page reload on reconnect (loses the open panel and half-typed text); reading the socket's close for the cause (the browser hides why an upgrade failed, so the page asks with a GET instead); a limit on the probe (it runs once per drop, so at most every 5 s).
- Where: office-reconnect

## 2026-10-20 Ended sessions leave within seconds

- Decision: an ended session, interactive or background, whether it ended by a closed terminal, stop, letgo or a crash, leaves the office within ~5 s. When its SessionEnd is missed, a process check every 5 s removes it: the pids come from `claude agents --json` (kept in a map, refreshed when an employee has no known pid and on the slower sweep) and are tried with `process.kill(pid, 0)` (ESRCH is dead, EPERM is alive). A session `claude agents` never listed keeps the 15-minute quiet path. A session `claude agents` lists that goes quiet keeps its status, as before (a long tool call is quiet but working); "offline" only appears on the unlisted quiet path. Jump on a session that just ended replies HTTP 410 `{ok:false, ended:true, error:"This session has ended"}`, removes the employee at once through the same departure event as the sweep, and opens nothing.
- Why: closing an iTerm2 terminal left its employee in the office for 15 minutes, and Jump on it said only "Its terminal tab is closed."
- Rejected: a greyed "off shift" state for ended sessions; spawning `claude agents` every 5 s.
- Where: G2

## 2026-10-20 Serve prints the link only to a terminal

- Decision: `f1rm serve` prints the full office URL only when stdout is a terminal; otherwise it prints `f1rm office: running on port <port>`. The link is always written to ~/.f1rm/office-url (0600), which `f1rm` reads. `f1rm start` does the same, and still opens the link. The seven proof scripts and the CLI tests read the link from that file.
- Why: under launchd stdout is ~/.f1rm/office.log, created 0644, and the link key is now permanent, so printing it put a lasting secret in a file that is not private.
- Rejected: making office.log 0600 (launchd creates the file, so f1rm would have to pre-create and chmod it, and no test can run launchd without touching the user's live service; the key would still sit in a log meant to be read and shared).
- Where: link-key-followups
