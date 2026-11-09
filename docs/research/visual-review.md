# Visual review of agent work (diagrams, visual diffs, drawings instead of prose)

researched_on: 2026-11-09 · horizon: 90 days (tooling moves fast) · tier: standard · query type: adoption

Search engine: **Exa was not available in this session** (no Exa tool). All web searches used WebSearch, which returns summaries, not page text. So most web claims are second-hand: marked **unverified** unless I read the source. Budget used: 8 of 8 (6 searches, 1 WebFetch of the Claude Code commands page, 1 search on GitHub uploads) plus free OpenAlex/arXiv lookups. Prior notes not repeated: `intent-alignment.md`, `fresh-eyes-review.md`.

## 1. Rendered diffs: what works with least setup

| Option | Where it renders | Setup | Works from Claude Code? | Verdict |
|---|---|---|---|---|
| Claude Code `/diff` | In the session, interactive (per-turn + working tree) | none | Yes, built in: "Review the changes in your working tree, including the edits Claude has made so far" ([commands](https://code.claude.com/docs/en/commands)) | Use first. Text-only, no colours-by-structure beyond normal diff |
| IDE diff (`/ide`, `/config` auto diff tool) | VS Code / JetBrains diff window | install IDE extension | Yes: "Code changes can be displayed directly in the IDE diff viewer" ([mirror of docs, **unverified**](https://docshtbprolclaudehtbprolcom-s.evpn.library.nenu.edu.cn/en/docs/claude-code/ide-integrations)) | Good if the user already has VS Code; extra app |
| delta (git pager) | iTerm2 terminal, side-by-side, 24-bit colour | `brew install git-delta` + 4 lines in `~/.gitconfig` (`core.pager = delta`, `side-by-side = true`) ([delta docs](https://dandavison.github.io/delta/print.html)) | Only for `git diff` you run yourself. Claude Code's own `/diff` does not use your pager (**inference**, not verified) | Cheap, but benefits the user's terminal, not agent comments |
| difftastic | Terminal, syntax-aware (ignores formatting noise) | `brew install difftastic`, `git config diff.external difft` | Same limit as delta | Best for "what really changed"; no delta+difftastic integration found ([search summary, weak](https://dandavison.github.io/delta/print.html)) |
| diff2html | Self-contained HTML page of a diff | `npx diff2html-cli` (**not searched**, from memory: unverified) | Agent could write an HTML file, user opens it | Works, but a file the user must open |
| GitHub PR "Files changed" + rich diff for images | Browser | none | Needs a PR | Already there; images in PRs show before/after (**unverified**, my search returned nothing on it) |

**Local state:** `delta`, `difft`, `mmdc` (Mermaid CLI) and `d2` are **not installed** on this Mac (checked with `which`); only `gh` is. So "prefer what's installed" means: `/diff`, GitHub rendering, the Excalidraw MCP.

## 2. Before/after screenshots and GIFs

| Need | Tool | Detail | Source |
|---|---|---|---|
| Screenshot compare | Playwright `toHaveScreenshot` | On failure writes actual, expected and diff images (changed pixels marked). Options `maxDiffPixels`, `maxDiffPixelRatio`, `threshold` | [Playwright snapshot assertions](https://playwright.dev/docs/api/class-snapshotassertions) (search fragments only, **partly unverified**) |
| pixelmatch | Library behind many diff tools | Whether Playwright uses it internally: **unverified** | n/a |
| Post image or video to an issue | **`gh issue comment --attach ./shot.png`** (gh v2.99.0+); repeatable; also `issue create/edit`, `pr create/edit/comment`. Video: markdown reference must be alone in its paragraph, no alt text. Needs push access | [GitHub changelog 2026-09-01](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments), [docs](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) |
| Older workaround | `gh-attach`, `gh-image` use an internal endpoint or session cookie; no public REST/GraphQL for uploads | Risky (terms, breakage); skip now that `--attach` exists ([overview](https://braindetox.kr/en/posts/gh_attach_cli_2026.html), **unverified**) |
| GIF | Playwright video (`.webm`/`.mp4`) is the easier path than GIF; attach it as video | **Inference**; I did not verify GIF tooling |

Check `gh --version` on this Mac before relying on `--attach` (not checked).

## 3. Diagrams of what a change does

| Format | Renders where, with no extra tool | Agent writes it how | Caveat |
|---|---|---|---|
| **Mermaid** | GitHub issues, PRs, discussions, wikis, markdown files, in a ```` ```mermaid ```` block ([GitHub docs](https://docs.github.com/en/enterprise-server@3.16/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams), [roadmap](https://github.com/github/roadmap/issues/372)). Not in the terminal | plain text, zero setup | see "Adversarial" below |
| SVG | GitHub comments accept `.svg` (2022 note, [unverified](https://gigazine.net/gsc_news/en/20220216-github-mermaid) summary) | agent writes SVG | harder for an LLM to lay out |
| Excalidraw (connected here) | Not in GitHub. Needs export to PNG, then `--attach` | MCP tools; several servers can render to PNG/SVG on disk (e.g. [excalidraw-render](https://lobehub.com/de/mcp/bassimeledath-excalidraw-render), [yctimlin](https://mcpservers.org/servers/yctimlin/mcp_excalidraw)). Whether **your** connected server can export PNG: **not checked**, check its tool list | Hand-drawn look; good for sketches/prototypes |
| D2 | Needs `d2` binary (not installed) and an export | n/a | Skip: one more tool for no gain over Mermaid |
| ASCII/Unicode tables | Everywhere, including the terminal | free | fine for the Preview and pass/fail tables |

### Adversarial: AI diagrams can be wrong or unreadable
- Syntax failures are common but fixable: one audit found 9% of AI-written Mermaid diagrams broken (missing arrows, bad node IDs, quotes); LLMs "often" fix them given the error ([GenAIScript](https://microsoft.github.io/genaiscript/blog/mermaids), [dev.to audit](https://dev.to/geanruca/improving-code-quality-with-consistent-mermaid-diagram-generation-2epm)). Putting the syntax reference in the prompt took reliability from ~70% to ~95% ([HU Berlin experiment](https://llm-enabled-development-41d6d8.pages.cms.hu-berlin.de/en/experiments/diagram/diagram-long)).
- **A diagram can render and still be wrong**: a 2026 paper shows generated sequence diagrams with inconsistent activations and missing actors ([arXiv 2604.23027](https://arxiv.org/pdf/2604.23027)). Syntax checkers "tell you if your diagram will render, but not whether humans can understand it" ([mermaid-sonar post](https://dev.to/entropicdrift/mermaid-sonar-detecting-hidden-complexity-in-diagram-documentation-3461)).
- Consequence for f1rm: a diagram from the agent is a *claim*, same as prose. It must be derived from the actual diff or the test run, not from the agent's memory.

## 4. Claude Code features for visual output (from the official commands page, read directly)

| Feature | What it is | Subscription / CLI? |
|---|---|---|
| `/diff` | Interactive diff of the working tree and Claude's edits | Yes, CLI built in ([commands](https://code.claude.com/docs/en/commands)) |
| `/artifacts`, `/artifact-diagramming`, `/design`, `/slides` | Published artifacts: diagrams as inline SVG (needs v2.1.221+), design canvases, slide decks | Page says "available where artifacts are available"; I did **not** read the availability section, so whether your plan/CLI session qualifies is **unverified**. Check with `/artifacts` |
| `/output-style` | Switch response style (v2.1.269+) | CLI yes. Can push replies toward tables/short bullets. Does not draw |
| `/statusline` | Configure the status line | CLI yes. Good for a one-glance "step 3/5, 2 failing" signal, not for diagrams |
| Hooks | Run commands on events (e.g. after an edit, take a screenshot) | CLI yes (existing feature; details not re-fetched, **unverified**) |
| `/insights` | HTML report on your sessions | CLI yes; not about reviewing changes |
| `/ide` | Connect to the IDE for diff view | needs IDE |

Hooks and screenshot tooling are cost-free in tokens; they run as shell commands.

## 5. Evidence: visual vs prose, and ADHD

| Question | What I found | Strength |
|---|---|---|
| Do pictures plus text beat text alone for learning? | The "multimedia principle" has a large literature; a meta-analysis exists on signaling text-picture relations ([Richter et al. 2016](https://doi.org/10.1016/j.edurev.2015.12.003)), and one on split-attention ([Ouwehand et al. 2018](https://doi.org/10.1007/s10648-018-9435-9)). Takeaway: pictures help **when placed next to the related text and not decorative**. I read titles only, not results | Moderate, **learning of educational material, not code review** |
| Visual load can hurt | "Understanding the cognitive cost of multimedia learning: effects of visual load" ([2026](https://doi.org/10.1186/s41235-025-00699-2)). Title only read | Weak-moderate |
| ADHD and multimedia | "Cognitive load and recall in ADHD and non-ADHD populations when viewing educational multimedia messages" (thesis, 2016; found by OpenAlex, no DOI). Title only read; I could not read the result | Weak. Small, old, unread |
| ADHD and reading | "Nonlinear text on engagement and comprehension of students with ADHD" (2010, no DOI). Title only | Weak, old, children |
| Diagrams improve **code-change** comprehension | **I found no study.** OpenAlex returned only 40-year code-comprehension mapping ([ACM 2023](https://doi.org/10.1145/3626522)) and software-visualization papers (ExplorViz 2016). arXiv returned nothing relevant | **Missing** |
| ADHD adult developers and visual review | **No evidence found** | **Missing** |

Plain reading: general learning research supports "picture next to a short label, not a wall of pictures". Nothing proves diagrams beat prose for reviewing code, or helps ADHD developers in particular. Treat the whole approach as an experiment on one user (the user is the test), and keep a prose fallback.

## Ranked recommendations for f1rm (max 5)

| # | Do | Why | Setup | Token cost |
|---|---|---|---|---|
| 1 | **Preview and close tables stay as markdown tables with a status column (pass/fail icons), one row per example; one Mermaid block per Preview** (before = main now, after = proposed flow). Agent builds the Mermaid from the diff or spec, and re-renders on a parse error | Renders in GitHub issues/PRs with no tool; zero install; tables are visual enough | ~30 min to add to the skill templates | Low: ~200-500 output tokens per diagram, plus one retry sometimes |
| 2 | **Screenshots for UI changes: attach with `gh issue comment --attach`** (before from main, after from branch). Prefer a side-by-side image; the Playwright diff image is optional | Official, no hacks, appears inline in the issue the user already reads | ~1 h (check gh >= 2.99.0, add Playwright capture step where a UI exists) | Low in tokens; image reads cost some if the agent checks them; mostly CPU time |
| 3 | **Prototype the user accepts = Excalidraw sketch exported to PNG, attached to the issue** (or an artifact if `/artifacts` works on the plan) | Drawing matches the user's wish; already connected | ~30 min: check that the connected server exports PNG; if not, use Mermaid | Medium: JSON element lists are verbose (several thousand tokens per drawing, **estimate**) |
| 4 | **Use `/diff` for code review in-session; tell the user once.** No delta/difftastic installs unless the user wants a terminal pager | Already installed; nothing to maintain | 0 | 0 |
| 5 | **Statusline + output style `concise`** showing step and pass/fail counts | Cheap attention anchor for ADHD; cannot be wrong like a diagram | ~15 min via `/statusline` and `/output-style` | 0 (a shell script) |

Not recommended now: D2 (extra binary), diff2html (a file to open), GIFs (video attach works but is unverified), third-party upload hacks.

## Why I'm concluding this

- GitHub renders Mermaid and now takes `--attach` natively, so the whole chain (agent draws, posts, user views in the issue) needs no new tool. That is the deciding fact (GitHub docs and changelog, both from search summaries, plausible but not read in full).
- `delta`, `difft`, `d2`, `mmdc` are absent here, so anything needing them has a setup cost; `/diff` has none.
- Evidence for visual over prose in this exact setting is **absent**. I ranked by cost and render path, not by proven benefit. The adversarial results say agent-made diagrams can look right and be wrong, so every diagram must come from real data (diff, test output), and the table/prose fallback stays.
- Rejected: building a custom review UI (high cost, no evidence), artifact-first (availability on the subscription unverified).

## Limits of this research
- Exa unavailable; WebSearch summaries only; several sources not opened.
- Not checked: `gh --version`, whether the connected Excalidraw server exports PNG, `/artifacts` availability, hook details, GitHub image-diff behaviour.
- Academic items: titles and dates only; results not read.
- Confidence: medium on tooling paths, low on the comprehension/ADHD benefit.
