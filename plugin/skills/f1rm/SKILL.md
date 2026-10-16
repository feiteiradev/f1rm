---
name: f1rm
description: Open the f1rm office on this project, starting it if needed. "/f1rm off" stops the office, "/f1rm edition work|founder" sets this project's edition, "/f1rm pm" opens this project's PM in a new iTerm tab.
argument-hint: "[off | edition work|founder | pm]"
disable-model-invocation: true
allowed-tools: Bash(f1rm here:*)
---

!`f1rm here $ARGUMENTS`

Reply with exactly the line above and nothing else. If it says the `f1rm` command was not found, reply instead: "f1rm isn't set up on this machine: clone https://github.com/feiteiradev/f1rm, run `bun install && bun run build` and then `bun office/cli/f1rm.ts install` in it, then type /f1rm again."
