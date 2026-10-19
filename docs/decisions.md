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
