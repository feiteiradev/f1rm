// The settings gate: no company session changes Claude Code's permissions. A rule in `settings.json`, `settings.local.json` or a hook applies to every later session of the repo,
// so only the user writes them (and the office, after the user's tick). The pieces here are pure; server.ts's `refusal` applies them.
import { basename } from "node:path";

export const SETTINGS_REFUSAL = "Only the user changes Claude Code permissions: `.claude/settings.json`, `.claude/settings.local.json` and `.claude/hooks/` are closed to every session. The user approves a project's commands once, in the office's \"Commands for <project>\" card; for any other command a request card reaches the user. Tell the session in your Report to what you need, and wait.";
export const WIDENING_REFUSAL = "A session never widens a hire's permissions; the user approves a project's commands once in the office.";

const SETTINGS_FILE = /(?:^|\/)\.claude\/(?:settings(?:\.local)?\.json$|hooks(?:\/|$))/;
const NAMES = /settings\.local\.json|\.claude\/settings|\.claude\/hooks/i;
// Commands that write the files they are given as arguments (`sed` and `perl` only with -i, `dd` as `of=`).
const WRITERS = new Set(["tee", "cp", "mv", "ln", "install", "truncate", "rm", "touch", "chmod", "chown", "rsync"]);
const GIT_WRITERS = new Set(["checkout", "restore", "apply", "mv", "rm"]);
// Programs that run the code in their next quoted word; one that names a settings file there is a writer we cannot read.
const INTERPRETERS = new Set(["bun", "node", "deno", "python", "python3", "ruby", "perl", "php", "bash", "sh", "zsh", "eval"]);
const INLINE_FLAG = /^(?:-[a-z]*[ecp]|--eval|--print)$/;
/** A path without `/./` and `//`, which name the same file. */
const plain = (text: string) => text.replace(/\/\.(?=\/)/g, "").replace(/\/{2,}/g, "/");
const bare = (w: string) => w.replace(/^(["'])(.*)\1$/, "$2");

/** Whether a Write, Edit or NotebookEdit target is one of those files: as resolved against the cwd, and with links resolved and case folded (`real`). */
export const isSettingsFile = (resolved: string, real: string) => [resolved, real].some((p) => SETTINGS_FILE.test(plain(p).toLowerCase()));

type GitCall = { sub: string; rest: string[]; options: string[] } | null;
type Simple = { prefix: string[]; words: string[] };

/**
 * Whether a Bash line writes a settings or hooks file. Only an actual write counts, so a message that names one (`git commit -m "docs: .claude/settings.json"`, a PR body, a report) passes:
 * a redirect (`>`, `>>`) whose target is such a path; a writer command (tee, cp, mv, ln, install, truncate, rm, touch, chmod, chown, rsync, `sed -i`, `perl -i`, `dd of=`, git checkout/restore/apply/mv/rm, `--output`)
 * with such a path as an argument word of its own; and a program that runs inline code (`bun -e`, `node -e`, `python -c`, `bash -c`) with the path anywhere in it. A word with spaces in it is a message, never a path
 * (except in inline code). `git add` and `git commit` of such a file are not writes: an implementer commits in its own worktree and `f1rm merge` stops the file reaching main.
 * `split` holds each simple command's prefix (wrappers such as `bun`) and words (heredoc bodies cut); `line` is the whole text.
 */
// ponytail: it reads command text like the push gate: a name built at run time (`bun -e` that joins the pieces, a glob such as `.cl*/settings*`, a variable, a script file) is not seen, and `settings.json` alone counts only on a line that also says `.claude`. The Write/Edit check resolves links; this one does not.
export function writesSettings(split: Simple[], line: string, git: (words: string[]) => GitCall): boolean {
  const claude = /\.claude\b/i.test(line);
  const names = (w: string) => NAMES.test(plain(w)) || (claude && /(?:^|[/'"=>])settings\.json/i.test(w));
  const path = (w: string) => !/\s/.test(bare(w)) && names(w);
  // A `>` or `>>` outside quotes, in this word or in the next, whose target is a path.
  const redirectsInto = (words: string[]) => words.some((w, i) => [...w.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|>>?/g)].some((m) => m[0][0] === ">" && path(w.slice(m.index + m[0].length) || words[i + 1] || "")));
  return split.some(({ prefix, words }) => {
    if (redirectsInto(words)) return true;
    if (!words.some(names)) return false;
    const all = [...prefix, ...words];
    if (all.some((w) => INTERPRETERS.has(basename(bare(w)))) && all.some((w) => INLINE_FLAG.test(w))) return true;
    const call = git(words);
    if (call) return (GIT_WRITERS.has(call.sub) || [...call.options, ...call.rest].some((a) => a.startsWith("--output"))) && [...call.options, ...call.rest].some(path);
    const program = basename(bare(words[0] ?? ""));
    const args = words.slice(1);
    if (WRITERS.has(program)) return args.some(path);
    if (program === "sed" || program === "perl") return args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)) && args.some(path);
    if (program === "dd") return args.some((a) => a.startsWith("of=") && path(a.slice(3)));
    return false;
  });
}

const WIDENING = /^--(?:settings|permission-mode|dangerously-skip-permissions|allow-dangerously-skip-permissions|allowedtools|allowed-tools)$/i;
/** A word of `f1rm hire` or `f1rm wake` that the shell reads as a flag that sets a hire's permissions, past quotes and backslashes (`--allowed""Tools`, `\--settings`) and with a `=value` or not. */
export const isWideningFlag = (word: string) => WIDENING.test(word.replace(/[\\"']/g, "").split("=")[0]);
