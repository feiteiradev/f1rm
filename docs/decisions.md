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

## 2026-10-20 The bare address never shows or redirects to the key

- Decision: the office's bare address `http://127.0.0.1:<port>/`, and any path without the right key, answers 401 with a short page saying "Open the office with `f1rm`". It never contains the key and never redirects to it.
- Why: the key is permanent, so an address anyone on the machine can fetch must not hand it out; `f1rm` already opens the right link.
- Rejected: redirecting the bare address to the key link (it gives the key to every local process), and the plain text "unauthorized" (it tells a person nothing).
- Where: G1c

## 2026-10-20 Doors only for projects

- Decision: the lobby gets a door only for a git repo's main working directory (its worktrees roll up) or a folder with ~/.f1rm/projects/<enc>.json, and never for anything under ~/.f1rm, ~/.claude, /tmp, /private/tmp or $TMPDIR, symlinks resolved. Sessions in any other folder sit behind one "Elsewhere" door (room id `elsewhere`) that exists only while one of them is alive; they keep their own cwd and terminal, so Jump works. The rule is applied when the office builds its rooms, replaying events.db again each start.
- Why: the lobby filled with junk doors from scratch folders and the user's own tooling; a door should mean a project.
- Rejected: editing or pruning events.db; a manual allowlist; showing strays as separate doors.
- Where: G4a

## 2026-10-20 Remove a door

- Decision: an empty door has a Remove action, POST /<token>/remove/<encoded room id>, which forgets the door and deletes its ~/.f1rm/projects/<enc>.json, never boards, evidence or the repo. The time is kept per room in ~/.f1rm/forgotten-doors.json (0600, written atomically); events older than it build no room. For a git repo a new event there brings the door back. A folder with no git repo has a door only because of its projects json, which Remove deletes, so a new plain session there goes behind Elsewhere until `f1rm pm` or `f1rm edition` writes the json again. The Elsewhere door cannot be removed.
- Why: a project the user no longer works on would keep its door for good, because the log replays on every start and a room never leaves it by itself.
- Rejected: pruning the room's rows out of events.db (the forget time hides them and leaves the log append-only); deleting its boards or evidence, or any file of the repo (Remove only forgets the door and its edition); removing a door that has someone in it.
- Where: G4a

## 2026-10-20 events.db tolerates concurrent readers

- Decision: the office sets `PRAGMA busy_timeout = 2000` on its events.db connection, so an insert waits up to 2 s, inside the hook's 5 s limit, for another process's read lock instead of failing.
- Why: with another process reading events.db, the insert hit SQLITE_BUSY, POST /ingest failed and the event was lost (4 times in ~/.f1rm/office.log in one day).
- Rejected: WAL (it adds -wal and -shm files beside ~/.f1rm/events.db that would need the same private mode, and a bounded wait already stops the loss); a 5 s wait, as long as the hook's curl -m 5, because the reply would land too late.
- Where: G4a

## 2026-10-20 claude agents status decides working vs idle

- Decision: on the office's ~5 s liveness check, each session `claude agents --json` lists is drawn by its status: busy is working, never on a coffee break; idle is idle unless a permission is pending, and a raised hand stays waiting. A session `claude agents` does not list, or lists with another status, keeps what its hooks said. Hooks still choose the pose detail (typing, reading, running from the last tool, waiting for a permission). A Stop or Notification event carrying `agent_id` (a sub-agent's) never changes the parent's status or activity. The check now runs `claude agents --json` on every tick while anyone is in the office (about 0.25 s per spawn under a load average near 400), with the existing no-overlap guard.
- Why: hooks alone mis-draw sessions: a sub-agent's Stop flipped its parent to idle, and a lost event left a stale status (feit's 7 busy hires all sat on coffee). The listing is Claude Code's own truth.
- Rejected: hooks as the only source; a greyed state for sessions the listing cannot place; keeping the listing to every 30 s (a busy session would sit on coffee for up to 30 s).
- Where: G5a

## 2026-10-20 Reviewer sends back every finding

- Decision: the Reviewer sends CHANGES REQUESTED for every /code-review finding, blocking or not, and merges only when none is left. The ponytail-review findings still never block and go in the report. Only a round that holds a blocking finding counts toward ESCALATE after 2 rounds, so rounds of minor findings alone never escalate.
- Why: the user wants minor findings fixed before the merge, not in follow-up branches (the G1 then G1b pattern).
- Rejected: merging on APPROVED and filing follow-ups.
- Where: reviewer-every-finding, e8ed02b

## 2026-10-21 Idle members free their team slot

- Decision: a team member that has sent its DONE and gone idle does not count toward the 2-working-per-team cap of `f1rm hire`. It is idle when its entry in `claude agents --json` has state "working" and `status` "idle" (the state alone stays "working" after DONE); a blocked member, and one with a missing or unreadable status, always counts as working. The machine-wide cap of 30 (which still counts it) and one specialist per task stay as they are.
- Why: in the ghosts team two devs sent DONE and went idle, but `claude agents --json` kept their state "working", so `f1rm hire --team` counted them and refused their Reviewers.
- Rejected: asking the user to raise or override the cap for each Reviewer; letting the lead let the devs go before the review (the dev must stay to take CHANGES REQUESTED).
- Where: idle-frees-slot, 3434935 and 3117ce9 (lead-ghosts agreed 2026-10-21 to the one-line status change in machine.ts backgroundSessions)

## 2026-10-21 Projects are isolated

- Decision: (a) the gate refuses a SendMessage from any f1rm role to a session whose project (room) differs from the sender's, with a message naming the rule; a target name that resolves to no session, or to sessions in more than one room, counts as unknown and is refused; "main" and the sender's own sub-agents stay allowed. (b) PMs and leads filter `claude agents --json` to their own repo (a cwd under the main working directory) at pickup and every time after, and never name, address or rely on another project's sessions, boards, milestones or evidence. (c) A problem with f1rm itself goes to the user as `f1rm feedback: <problem> -> <suggestion>`, addressed to no session. (d) Memory (every role keeps `memory: user`) holds only facts about the user and how they like to work, never project facts; project facts go in that project's milestones file or board.
- Why: one project's PM must not steer or learn from another's: a PM learned of another project's PM from `claude agents --json` and the shared memory folder, and asked the user to relay a message to it.
- Rejected: relying on prompt rules alone (the gate holds only while the office runs, so the prose stays as the fallback); removing `memory: user` from the roles.
- Where: projects-isolated

## 2026-10-21 Decisions log merges by union

- Decision: when a hire creates the decisions log file, whatever its path (`docs/decisions.md` here; some repos keep `docs/decisions.html`), it also adds the line `<that path> merge=union` to the repo's `.gitattributes`; this repo's `.gitattributes` has `docs/decisions.md merge=union`. Reviewers still never resolve a conflict by hand. Union folds the identical first and last lines of two new entries into one, so each entry starts and ends with a line of its own (an HTML entry needs an opening tag with an id and a closing comment after its closing tag); `office/gitattributes.test.ts` shows both.
- Why: two branches that append different entries to the append-only log no longer conflict, so a Reviewer no longer sends a task back for it.
- Rejected: letting Reviewers resolve conflicts in the log.
- Where: projects-isolated

## 2026-10-21 Project notes live outside memory

- Decision: every role keeps project learnings in `~/.f1rm/kept/<repo>/notes/<role>.md`, where `<repo>` is the repo folder's basename, as in `~/.f1rm/evidence/<repo>/`. Agent memory (`memory: user`, shared across projects) keeps only lessons that hold in any project. A brief's Context names the notes file for its role, and the milestone cleanup never deletes `notes/` (it is in neither the Persist nor the Delete group).
- Why: the specialists' shared memories were full of project knowledge, which leaked one project's existence into another.
- Rejected: Claude Code's project and local memory scopes: the committed variant would put notes into the repo, and the uncommitted variant does not carry across hires' separate worktrees.
- Where: projects-isolated

## 2026-10-21 Doors only by f1rm pm

- Decision: a lobby door exists only for a folder registered in `~/.f1rm/projects/<enc>.json`, and only `f1rm pm` creates that file. A session belongs to the registered folder that contains its cwd, by the longest path prefix: the cwd itself, then its parents, longest first. So a subfolder, a `.claude/worktrees/<name>` and a worktree removed since all roll up to their project's door, nested registered folders go to the inner one, and the parent of registered projects gets none. Git is not asked about the cwd. A worktree made outside the registered folder (`git worktree add ../shop-hotfix`) is not inside it, so it shows under Elsewhere. The room id stays the key boards, editions and forgotten doors use: the folder's git common dir for a repo, the folder itself otherwise. The office never writes a registration: its edition dialog only changes an existing one and answers 404 for a door whose file is gone. Sessions under no registered folder show behind the Elsewhere door while alive. The registration is looked up on every event, so a folder registered while the office runs gets its door on its next event. A door whose registration is removed outside the office goes once it is empty. The exclusions (~/.f1rm, ~/.claude, temp folders) still win, even over a registered folder that contains them. Remove deletes the registration, so a new session there goes to the registered folder around it, or to Elsewhere, until `f1rm pm` registers the folder again, and a restart does not bring back the sessions of events older than the Remove.
- Why: the user got doors and offices he never asked for, and does not want new doors for the same project (his lobby showed one per hire worktree and subfolder). Worktrees vanish after letgo, so git cannot decide where an old event belongs; the registered folders can.
- Rejected: automatic doors for git repos; one door per cwd, subfolder or worktree; resolving the door through git. This supersedes "Doors only for projects" (G4), whose any-git-repo rule and "a new event brings the door back" after Remove no longer hold.
- Where: doors-server (the `f1rm pm` side lands in doors-cli)

## 2026-10-21 f1rm edition changes, never creates

- Decision: `f1rm pm` registers its repo (the same file `editionFile` gives: the git common dir for a repo, so a subfolder or worktree registers the main working directory; the folder itself otherwise) by creating `{}` when missing, even when no edition is chosen, and never overwrites an existing registration or its edition. `f1rm edition work|founder` only changes an existing registration and exits non-zero with "run f1rm pm here first" in an unregistered folder; bare `f1rm edition` there prints "unregistered (run f1rm pm here first)".
- Why: `f1rm edition` used to create the file in any folder, which gave a subfolder its own door, against "Doors only by f1rm pm".
- Rejected: letting `f1rm edition` register as a convenience; `f1rm pm` registering only once an edition is chosen (a PM with no terminal would then have no door).
- Where: doors-cli
## 2026-10-21 f1rm status

- Decision: a CLI command `f1rm status [--json]`, run in a repo, lists only that repo's hires (the background sessions `claude agents --json` lists under its main working directory, plus unlisted ones whose transcript in this repo's folders carries a hire's name and was written in the last day; an ended hire is listed only when the folder its transcript records is this repo's folder or under it), judged by real activity: the mtime of the session's transcript, the last commit time of its `worktree-<task>` branch, `ended` when `claude agents` no longer lists it, and `limitUntil` (the text after "resets") only while the stop is the last line of the conversation (a limit stop of any kind), so a reply or a delivered message (an enqueue or a user line) clears it; the session's own task-notification does not. Never by status text. If `claude agents --json` cannot be read it says so on stderr and exits 1; it never guesses. `f1rm status --watch <names>` holds the stall rule (see Self-driving teams). Claude Code cuts a project folder name at 200 characters, so it refuses, in every form, a repo whose encoded project folder is over 150 characters (exit 1, the reason on stderr), so the `--claude-worktrees-` prefix of a worktree's folder stays whole (the filter matches a cut worktree name by that prefix; task slugs have no cap, and 150 leaves room with a margin); matching cut repo folders was dropped. The refusal happens at `f1rm pm`, `f1rm hire` and `f1rm status`, so a long-path repo never starts a milestone it cannot watch (the office's Hire endpoint refuses a long-path repo too, with the same message, which an office user will not have run `f1rm status` to see); `f1rm hire` starts hires at the git repo root, not in the subfolder it ran from (outside git, where it ran), which is where `f1rm status` looks for them; the PM starts where it ran, so a relative `--settings` or `--add-dir`, and `--continue`, work as before; a repo whose `.git` is not inside its working tree (a submodule or a separate git dir) is not supported; `f1rm pm` and `f1rm hire` check the root of a git repo, not the subfolder they ran from, and refuse nothing outside git (plain-folder doors still work, and `f1rm status` itself refuses a folder that is not a git repo).
- Why: `claude agents` status and `claude logs` looked alive for hours on sessions that had hit the subscription usage limit, and nobody woke them.
- Rejected: reading `~/.f1rm/events.db` (a second reader causes SQLITE_BUSY ingest losses, and it needs the office running); trusting `claude agents` status text.
- Where: self-driving, ba44481

## 2026-10-21 Self-driving teams

- Decision: the PM watches its leads and each lead watches its own hires with `f1rm status --watch <names>` in the background (`run_in_background`); its exit wakes them. The command sleeps a minute, then polls once a minute, and exits 0 naming each stalled session with its reason: idle for 20 minutes, ended, on a limit stop, missing from the list or without an activity time; with no name left it exits 0 at once, and it exits 1 when `claude agents --json` cannot be read. A lead counts as stalled only when it and every hire of its team have been quiet (a lead waiting on active hires writes nothing; a hire held by a limit stop counts as active for 6 hours). The watcher passes sessions waiting for an answer to their report (`DONE`, `BLOCKED`, `PLAN`, `CHANGES REQUESTED`, `ESCALATE`, `APPROVED`, or a lead's `DONE <team>`) as `name:waiting`, which is judged only for ended, missing or a limit stop, never for being quiet (the user answers a permission `BLOCKED` at the hire's desk, so no message ever puts the session back); the command notes a waiting name's activity at its first poll, a minute after the start, and watches it as a plain name from the first later write (a message sent to it counts as a write; a wrap-up it writes inside that first minute does not), so an approved hire that then stops idle wakes the watcher while a Reviewer waiting after CHANGES REQUESTED, which writes nothing, stays waiting. A hire waiting on a reset timer the lead holds is left out of the names. When a session sends its report the PM or lead restarts the watcher with it as `name:waiting` (the PM does the same for its leads: `PLAN`, `DONE <team>`); when it answers the report and the session works again, it restarts the watcher with it as a plain name. After `f1rm letgo` the names you let go are dropped. On wake a limit stop waits for the reset the stop names and then gets `resume` (a stop that names no time gets `resume` after a few minutes); the delivered `resume` clears the stop, so the old stop does not wake the watcher again; a hire that hits the limit again shows a new stop and wakes the watcher again, and a second `resume` in a row that brought no new commit, message or timed limit stop in between means the hire is ended. A missing session is kept in the names, and treated as ended if the next wake still finds it so; an ended session is let go with `f1rm letgo` and hired again with a resume brief before the original brief; every hire checkpoints (a wip commit and `resume.md`) before a long step and whenever it stops. The watcher is the lead's and the PM's own: no per-task reports are added. Known limit. If the PM and the leads are stopped by the same limit, nothing wakes them; the user restarts them after the reset. Nothing watches the PM; if it stops, the user restarts it.
- Why: a limit stop used to end the work silently, and every hire in the milestone sat idle for hours.
- Rejected: waiting for the user to notice; polling in the main conversation; a daemon that restarts sessions by itself.
- Where: self-driving, ba44481
