# Fresh-eyes pre-implementation review (impact preview)

researched_on: 2026-11-09. Horizon: 180 days (patterns, not versions). Builds on `docs/research/intent-alignment.md` (plan-preview and gates are not re-argued there; see its item 5).

Question: should f1rm add a step where an agent with no project context reads the planned tickets and the current `main`, and writes "these tickets change X; on main X does Y; is that what you want?" before any code?

Method and limits. The Exa search tool was unavailable, so I used WebSearch (disclosed fallback) plus WebFetch of primary pages and the arXiv API; 8 web calls in total. **Unverified** marks claims I did not see at the source. I found **no public source** for a "current behaviour vs proposed behaviour" preview in Kiro, Devin, Copilot or Codex, and I did not research them again beyond the prior file. That part is a gap, not a negative finding.

## Answers to the five sub-questions

### 1. Does a fresh-context reviewer catch more than one sharing the author's context?

Short answer: weak-to-mixed evidence for "fresh beats same-context" on judgement; stronger evidence for it on *error blindness*. No study measures plan or ticket review.

- Against fresh-eyes (it may not matter much for verifiable fixes): authors rejected checker-verified good fixes to their own drafts about as often as fresh models did (gap -5.1 pp, 95% CI [-12.9, +2.7]), four mid-tier models, 85 comparisons. A self-skepticism prompt did not replicate ([arXiv 2606.20093](https://arxiv.org/abs/2606.20093), Jun 2026, preprint). Under blind evaluation self-preference "disappears", but labels alone ("self" vs "other") shift scores both ways ([arXiv 2608.18091](https://arxiv.org/abs/2608.18091), 2026).
- For fresh-eyes: GPT-4 shows significant self-preference, tied to low-perplexity (familiar) text ([arXiv 2410.21819](https://arxiv.org/abs/2410.21819), Oct 2024). Models fix an injected error when it is attributed to the user but not when it is attributed to themselves: a "64.5% Self-Correction Blind Spot" across 14 open non-reasoning models ([arXiv 2507.02778](https://arxiv.org/abs/2507.02778), Jul 2025). Without external feedback, self-correction in reasoning often fails or degrades ([arXiv 2310.01798](https://arxiv.org/abs/2310.01798), Oct 2023, older, weak signal for current models).
- Vendor guidance, not measurement: Claude Code's `/code-review` runs "in a fresh subagent that never saw your conversation. It isn't swayed by the reasoning that produced the code." A fresh reviewer "does help, because it hasn't seen your reasoning", but delegating the same task to a subagent does not make the answer better ([best practices](https://code.claude.com/docs/en/best-practices)). Anthropic's auto-mode classifier "sees only user messages and the agent's tool calls" and strips the agent's own text "so the agent can't talk the classifier into making a bad call" ([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)). That is the strongest first-party design evidence that reviewers should be reasoning-blind.
- Inference: for f1rm the point of fresh context is less bias and more *no shared assumptions*. A reviewer that never heard the interview cannot silently fill gaps in the tickets. That is the value of the preview, and the papers above neither prove nor disprove it.

### 2. What does a good current-vs-proposed preview look like; who ships one?

- **Nobody I could find ships it as such.** Kiro has requirements/design/tasks files and "Analyze Requirements" for ambiguities and conflicts, nothing about current-code behaviour ([Kiro specs](https://kiro.dev/docs/specs/)). Spec Kit `/analyze` is the closest relative: read-only, checks spec/plan/tasks consistency, outputs a table (ID, Category, Severity, Location, Summary, Recommendation) with coverage counts, capped at "50 findings total" ([analyze.md](https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md)). It reads *artifacts*, not the code on main. Devin/Copilot/Codex plans: see the prior file; no impact-vs-main view documented there.
- Proposed format (my design, **unverified by any source**): one row per behaviour touched, four cells: `Behaviour` | `On main today (file:line)` | `After the tickets` | `Ticket / Example`. Rows ordered by example; a final line for "behaviour on main that a ticket changes but no example mentions" (the unrequested-change check, the real value). Limit: about 8 rows and 1 screen. The human question per row is a yes/no, not prose. The 2-minute budget is my target; no source tests it.
- Rationale from prior evidence: the only measured gains come from humans answering small concrete questions or approving tests (TiCoder, ClarifyGPT, in `intent-alignment.md`). A row table keeps to that shape. Böckeler's complaint was long markdown to review ([martinfowler.com](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html), quoted in the prior file).

### 3. How should the reviewer ground "on main X does Y"?

- No study I found measures whether file:line citations reduce hallucinated current-behaviour claims. Closest: reviewer comments can be "ungrounded, irrelevant, or misaligned with the actual code" (Atlassian HalluJudge, FSE Companion 2026, via secondary summary: **unverified**). A vendor blog reports a second agent that tries to *disprove* each finding by reading files: recall 72% to 65.7%, precision nearly doubled on a 50-PR benchmark (**vendor claim, unverified**). A CodeRabbit field study attributes 10.3% of false positives to missing visibility into other files (**unverified**, secondary summary).
- LLMs also misjudge code against natural-language specs: they "frequently misclassify correct code implementations as either 'not satisfying requirements' or containing potential defects", and more elaborate prompts can make it worse ([arXiv 2508.12358](https://arxiv.org/abs/2508.12358), Aug 2025). Expect false alarms in the "is that what you want?" direction.
- Practical rule (inference, consistent with the above): every "on main" cell must carry a `path:line` the reviewer actually opened, and a claim that cannot be cited is printed as "could not find". Prefer reading and grep over running tests: running builds is slow, may fail on environment, and is not needed to state current behaviour. Claude Code lets a custom subagent be read-only by `tools: Read, Grep, Glob`, "enforced by Claude Code rather than requested in a prompt" ([best practices](https://code.claude.com/docs/en/best-practices)).
- Add a cheap check: the orchestrator (or a script) verifies each cited `path:line` exists and that the quoted text is on that line. That makes fabricated citations visible without a second model. Not found as a published pattern; my suggestion.

### 4. Block for confirmation or post-and-continue?

- Approval fatigue is real in first-party data: users accept 93% of manual permission prompts "anyway", which "leads to approval fatigue, where people stop paying close attention" ([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)). A 2026 preprint models reviewer capacity and drift to rubber-stamping (["Oversight Has a Capacity", arXiv 2606.08919](https://arxiv.org/pdf/2606.08919); I read only the search summary, **unverified**). Blog claims of specific rubber-stamp rates from other sources could not be traced to primaries; I do not use them.
- Anthropic's autonomy data, already in the prior file, favours being able to intervene over approving each action.
- Kiro's own guidance: gates for unfamiliar ground or when the team wants checkpoints; skip them for well-understood work ([best practices](https://kiro.dev/docs/specs/best-practices/)).
- Rule I recommend: **block only when the preview shows a change nobody asked for** (a behaviour row with no example, or a row whose "after" contradicts an example). Otherwise post the table on the spec and continue. A gate that blocks only on a real anomaly stays rare, so it does not train rubber-stamping. A reviewer "that's asked to find problems will always find *something*" ([best practices](https://code.claude.com/docs/en/best-practices)), so the block condition must be structural (unmapped row), never "reviewer is worried".

### 5. Keeping it cheap

- A fresh subagent "first has to gather context your conversation already had, so it can end up slower"; tokens count against the same usage; it is "the same model (or a smaller one)" so you get fresh eyes, not a smarter answer ([best practices](https://code.claude.com/docs/en/best-practices)). Subagents take `model: sonnet|opus|haiku|inherit` ([subagents](https://code.claude.com/docs/en/sub-agents)). A third-party claim of 20-30% more tokens for subagents is **unverified**.
- Auto mode's pattern is the template: a fast first stage, and reasoning "only where needed" ([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).
- Levers (design, mostly inference): (a) scope the read to what the tickets name: the files in each ticket's `Boundary:` plus their direct callers; never whole-repo; (b) hand the reviewer only the tickets and examples, not the interview or PM reasoning; (c) cap output at the table plus at most 3 flagged rows (Spec Kit caps at 50, f1rm needs far fewer); (d) skip the review for tickets that touch only new files, docs, or tests, since there is no "on main today" to compare; (e) Sonnet-class model, no extended reasoning, read-only tools.

## Adversarial view

- Reviewers invent problems when asked to find them, and over-reject correct work (sources above). The gate can cost more attention than it saves if it cries wolf.
- Fresh context also means *missing* context: it will flag conventions it cannot know. Mitigation: it still loads CLAUDE.md/AGENTS.md (subagents inherit them; built-in Explore/Plan skip them, per [subagents](https://code.claude.com/docs/en/sub-agents)), which is the right amount of project context.
- No evidence that a pre-implementation preview improves outcomes in agentic coding. The Böckeler anecdote says spec-gating small work is a sledgehammer. Treat this as a hypothesis to test on a few real specs.

## Why I'm concluding this

- The decisive first-party sources are Anthropic's two: fresh-subagent review "isn't swayed by the reasoning that produced the code", and the auto-mode classifier is reasoning-blind and two-stage for cost. They agree with the self-correction blind-spot paper, and the one contrary paper (2606.20093) tests simple verifiable fixes, not intent or plan review, so it does not overturn the design.
- The approval-fatigue figure (93%) is the main reason to keep the gate non-blocking by default.
- Rejected: running tests to ground current behaviour (cost, flakiness, no evidence of benefit); a full multi-agent debate (cost, no evidence); a blocking gate on every spec (fatigue; contradicts the prior file's item 5).
- Weakest link: nothing measures plan-impact preview itself. Recommendations below are design bets with cheap exits.

## Recommendations for f1rm (ranked, max 5)

1. **Add one read-only "impact" subagent after the tickets step, Sonnet, tools `Read, Grep, Glob`, input = tickets + examples only.** It writes the four-column table (Behaviour | On main today `path:line` | After | Serves example N) and a last line "changes no example mentions". Posts as a comment on the spec. *User attention: about 1-2 minutes per spec if they read it; zero if nothing is flagged. Tokens: one fresh run reading only the ticket-named files, roughly a small review's worth (no measured number).*
2. **Block only on a structural anomaly**: a row with no `Serves:` example, or an "after" that contradicts a confirmed example. Otherwise post and continue. *Attention: a pause only on anomalies, expected rare; no extra cost when clean.*
3. **Verify citations in the orchestrator**, not by another model: each `path:line` must exist, and the quoted text must be there; uncited rows print "could not find". *Attention: none. Tokens: none beyond a shell check.*
4. **Skip the step for small or additive specs** (1-2 tickets, only new files/docs/tests, or the user said small). *Attention: saves it; tokens: saves a whole run. Risk: misclassifying a small change that hits existing behaviour; mitigate by checking `Boundary:` for existing files.*
5. **Measure before keeping it**: for the next 5 specs, record how many flagged rows the user changed the plan for versus dismissed. If under 1 in 5 specs produces a real correction, drop it or demote it to "only on large specs". *Attention: one yes/no per spec. Tokens: none.*

Not checked: how the tickets step lists `Boundary:` today (I did not read the plugin skills), and whether `.claude/agents/` subagents run under the user's subscription in f1rm's office setup; both are needed before building item 1.

## Sources

- [Claude Code best practices](https://code.claude.com/docs/en/best-practices), fetched 2026-11-09: fresh-subagent review, read-only reviewer, cost, "always find something".
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), 2026-11-09: fresh context, inheritance, model field.
- [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode): 93% accept, reasoning-blind, two-stage.
- [Spec Kit analyze.md](https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md): read-only table report, 50-finding cap.
- [Kiro specs](https://kiro.dev/docs/specs/) and [best practices](https://kiro.dev/docs/specs/best-practices/): gate guidance.
- arXiv: [2606.20093](https://arxiv.org/abs/2606.20093), [2608.18091](https://arxiv.org/abs/2608.18091), [2410.21819](https://arxiv.org/abs/2410.21819), [2507.02778](https://arxiv.org/abs/2507.02778), [2310.01798](https://arxiv.org/abs/2310.01798), [2508.12358](https://arxiv.org/abs/2508.12358), [2606.08919](https://arxiv.org/pdf/2606.08919). I read abstracts via the arXiv API except 2606.08919.
