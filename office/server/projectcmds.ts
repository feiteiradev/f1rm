// A project's command list: derived by the office from package.json, the lockfile and CI, approved once by the user, and written by the office alone into the main checkout's `.claude/settings.local.json`.
// Plain functions over an injected fs; no session ever reaches this code (the routes answer the user's browser only, and the gates refuse a session that names them or the settings files).
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKey } from "./board.ts";

/** The disk the derivation and the approval touch. `write` replaces the file whole (atomic) and makes its folder. */
export type Fs = { read(path: string): string | null; list(dir: string): string[]; isDir(path: string): boolean; write(path: string, text: string): void };
export const nodeFs: Fs = {
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  list: (dir) => { try { return readdirSync(dir).sort(); } catch { return []; } },
  isDir: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, path);
  },
};

/** `~/.f1rm/projects/<repo>.commands.json`: `{approved: [...], at}`, written once the user approves the project's list. */
export const commandsFile = (projectsDir: string, roomId: string) => join(projectsDir, repoKey(roomId) + ".commands.json");

export type Group = "script" | "runner" | "install" | "workflow" | "git" | "gh" | "f1rm";
/** One line of the list. `id` is the exact allow rule, so a ticked id is the rule itself. `excluded` is why the line cannot be ticked. */
export type Cmd = { id: string; group: Group; checked: boolean; excluded?: string };

/** Written with the allow rules, always. Defence in depth only: the text-reading push gate is the guard (a `git -C . push -f` evades a rule). */
export const DENY = ["Bash(git push --force*)", "Bash(git push -f*)", "Bash(git push * --force*)", "Bash(git push * -f*)", "Bash(git push --delete*)", "Bash(git push * --delete*)", "Bash(git push * +*)", "Bash(gh pr merge *)"];

// Exact forms of fetch and rebase only: `git rebase --exec` and `git fetch --upload-pack` run arbitrary code, so no star after either.
const GIT = ["add *", "commit *", "switch -c *", "checkout -b *", "fetch", "fetch origin", "rebase --continue", "rebase --abort", "rebase origin/main", "rebase main", "worktree list"];
const GH = ["pr view *", "pr list *", "pr checks *", "run list *", "run view *", "issue view *", "issue list *"];
// `f1rm install` writes hooks only and no allow rule, so nothing allows the company's own commands yet; the f1rm gates still decide who may run which.
const F1RM = ["report", "merge", "push", "status", "hire", "wake", "letgo", "archives"];
const LOCKS: [string, string][] = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]];
const FROZEN: Record<string, string> = { bun: "bun install --frozen-lockfile", pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", npm: "npm ci" };
const STANDARD = /^(?:test|tests|typecheck|tsc|lint|format:check|check|suite|build|ci|verify|validate)$|^(?:test|lint|build|check):/;
const BAD_NAME = /deploy|publish|release|push|migrate|prod/i;
// `git` then `push` with anything but a command separator between (`git -C . push`, `git  push`), any `publish` (npm, pnpm, yarn, bun), and the rest of research A3's list with flexible spaces.
const BAD_BODY = /\bgit\b[^;&|]*\bpush\b|\bpublish\b|vercel|curl|ssh|rsync|docker\s+push|terraform|rm\s+-rf|sudo/i;
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];
// A script name goes into a rule: anything else could close the parenthesis or add a wildcard.
const SAFE_NAME = /^[\w:.@/-]+$/;
// A CI line becomes an exact rule: plain words only (no `*`, `$`, quotes, redirects, parentheses or backslashes), and no shell to run arbitrary text.
const SAFE_LINE = /^[\w@:./=,+~ -]+$/;
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|eval|source|exec|env|xargs|sudo|\.)(?:\s|$)/;

/** Why the screen drops a command: the name or the body, or null. */
const screened = (name: string, body: string) => {
  const n = BAD_NAME.exec(name), b = BAD_BODY.exec(body);
  return n ? `its name says "${n[0]}"` : b ? `its command has "${b[0]}"` : null;
};

/** The workflow files' `run:` lines, split into simple commands. */
function workflowLines(fs: Fs, main: string): string[] {
  const dir = join(main, ".github", "workflows");
  return fs.list(dir).filter((f) => /\.ya?ml$/.test(f)).flatMap((f) => {
    try {
      const doc = Bun.YAML.parse(fs.read(join(dir, f)) ?? "") as { jobs?: Record<string, { steps?: { run?: unknown }[] }> } | null;
      const steps = Object.values(doc?.jobs ?? {}).flatMap((j) => (Array.isArray(j?.steps) ? j.steps : []));
      return steps.flatMap((s) => (typeof s?.run === "string" ? s.run.split(/\n|&&|\|\||[;|&]/) : [])).map((l) => l.trim()).filter(Boolean);
    } catch {
      return []; // not YAML: no lines
    }
  });
}

/** Whether a rule already lets `line` run: its own text, or its prefix when it ends in ` *`. */
const covers = (rule: string, line: string) => {
  const content = rule.slice(5, -1);
  return content.endsWith(" *") ? line === content.slice(0, -2) || line.startsWith(content.slice(0, -1)) : line === content;
};

/**
 * The commands a project's hires need, per research A3: package.json scripts, the lockfile's runner and frozen install, CI `run:` lines and the fixed git, gh and f1rm groups.
 * Never in it: a raw `git push` (the PM pushes with `f1rm push`), `gh pr merge`, `gh api`, `curl`, `rm -r*`, `bun add`/`remove`.
 */
export function deriveCommands(main: string, fs: Fs = nodeFs): Cmd[] {
  const out: Cmd[] = [];
  const add = (group: Group, rule: string, checked: boolean, excluded?: string | null) => {
    const id = `Bash(${rule})`;
    if (!out.some((c) => c.id === id)) out.push({ id, group, checked: checked && !excluded, ...(excluded && { excluded }) });
  };
  let scripts: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(fs.read(join(main, "package.json")) ?? "");
    if (parsed && typeof parsed === "object") scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {} // no package.json, or one that is not JSON: only the fixed groups
  if (scripts) {
    const lock = LOCKS.find(([file]) => fs.read(join(main, file)) !== null)?.[1];
    const pm = lock ?? "npm";
    for (const [name, body] of Object.entries(scripts)) {
      const why = SAFE_NAME.test(name) ? screened(name, String(body)) : "its name is not a plain script name";
      add("script", `${pm} run ${name} *`, STANDARD.test(name), why);
    }
    if (pm === "bun") add("runner", "bun test *", true);
    if (lock) {
      const hit = LIFECYCLE.map((h) => [h, BAD_BODY.exec(String(scripts[h] ?? ""))] as const).find(([, m]) => m);
      add("install", FROZEN[lock], true, hit && `an install runs ${hit[0]}, which has "${hit[1]![0]}"`);
    }
    for (const line of workflowLines(fs, main)) {
      if (!SAFE_LINE.test(line) || SHELLS.test(line) || out.some((c) => !c.excluded && covers(c.id, line))) continue;
      add("workflow", line, false, screened(line, line));
    }
  }
  for (const g of GIT) add("git", `git ${g}`, true);
  for (const g of GH) add("gh", `gh ${g}`, true);
  for (const v of F1RM) add("f1rm", `f1rm ${v} *`, true);
  return out;
}

/** Puts one line at the end of a text that may lack its final newline. */
const withLine = (text: string, line: string) => (text && !text.endsWith("\n") ? text + "\n" : text) + line + "\n";
const union = (have: unknown[], more: string[]) => [...have, ...more.filter((m) => !have.includes(m))];

/**
 * The user's approval: merges the ticked allow rules and DENY into `<main>/.claude/settings.local.json` (nothing else in it changes; an entry already there stays), makes sure that file is in `.git/info/exclude`,
 * and records the ticked set in `record`. A tick that is not a derived, unexcluded line is ignored, so a request cannot add a rule the office did not derive. Returns the ticks it kept.
 * Throws, and writes nothing, when the settings file is not JSON or its `permissions` allow/deny are not lists.
 */
// ponytail: a main checkout whose `.git` is a file (a submodule, or main itself a worktree) gets no exclude line; Claude Code adds the file to the global excludes on its own first write.
export function applyApproval(main: string, ticked: unknown[], { record, now = Date.now(), fs = nodeFs }: { record: string; now?: number; fs?: Fs }): string[] {
  const derived = new Set(deriveCommands(main, fs).filter((c) => !c.excluded).map((c) => c.id));
  const kept = [...new Set(ticked)].filter((id): id is string => typeof id === "string" && derived.has(id));
  const file = join(main, ".claude", "settings.local.json");
  const text = fs.read(file);
  let settings: any = {};
  try {
    if (text !== null) settings = JSON.parse(text);
  } catch {
    throw new Error("settings.local.json is not JSON");
  }
  const permissions = settings?.permissions ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("settings.local.json is not a settings object");
  for (const key of ["allow", "deny"]) if (permissions[key] !== undefined && !Array.isArray(permissions[key])) throw new Error(`settings.local.json permissions.${key} is not a list`);
  fs.write(file, JSON.stringify({ ...settings, permissions: { ...permissions, allow: union(permissions.allow ?? [], kept), deny: union(permissions.deny ?? [], DENY) } }, null, 2) + "\n");
  if (fs.isDir(join(main, ".git"))) {
    const exclude = join(main, ".git", "info", "exclude");
    const have = fs.read(exclude) ?? "";
    if (!have.split("\n").some((l) => ["/.claude/settings.local.json", ".claude/settings.local.json"].includes(l.trim()))) fs.write(exclude, withLine(have, ".claude/settings.local.json"));
  }
  fs.write(record, JSON.stringify({ approved: kept, at: now }) + "\n");
  return kept;
}
