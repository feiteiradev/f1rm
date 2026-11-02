// A project's command list: what the office derives from package.json, the lockfile and CI, and what an approval writes.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyApproval, DENY, deriveCommands, type Cmd } from "./projectcmds.ts";

/** A main checkout with the given files (`path -> text`) and a `.git` folder. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-cmds-"));
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });
/** This repo's own scripts (research A4). */
const THIS_REPO = { build: "vite build office/client --base ./ && vite build office/demo --base ./ --mode demo", "record-demo": "bun scripts/record-demo.ts", start: "bun office/cli/f1rm.ts start", smoke: "bun scripts/smoke.ts", typecheck: "tsc --noEmit", check: "bun scripts/check-lock.ts bun run suite", suite: "bun test && bun run typecheck && bun run build" };
const rules = (cmds: Cmd[], pick: (c: Cmd) => boolean = () => true) => cmds.filter(pick).map((c) => c.id);
const byId = (cmds: Cmd[], id: string) => cmds.find((c) => c.id === id);

test("a Bun repo like this one: the standard scripts are pre-checked, the others listed unchecked, the runner and the frozen install pre-checked", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg(THIS_REPO), "bun.lock": "" }));
  expect(rules(cmds, (c) => c.group === "script")).toEqual(["Bash(bun run build *)", "Bash(bun run record-demo *)", "Bash(bun run start *)", "Bash(bun run smoke *)", "Bash(bun run typecheck *)", "Bash(bun run check *)", "Bash(bun run suite *)"]);
  for (const id of ["Bash(bun run build *)", "Bash(bun run typecheck *)", "Bash(bun run check *)", "Bash(bun run suite *)"]) expect(byId(cmds, id)).toMatchObject({ checked: true });
  for (const id of ["Bash(bun run record-demo *)", "Bash(bun run start *)", "Bash(bun run smoke *)"]) expect(byId(cmds, id)).toMatchObject({ checked: false });
  expect(byId(cmds, "Bash(bun test *)")).toMatchObject({ group: "runner", checked: true });
  expect(byId(cmds, "Bash(bun install --frozen-lockfile)")).toMatchObject({ group: "install", checked: true });
  expect(cmds.some((c) => c.excluded)).toBe(false);
});

test("the fixed groups: git in a worktree, gh reads and the company's own CLI; never a push, a PR merge, gh api, curl, rm -r or bun add", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg({ test: "bun test" }), "bun.lock": "" }));
  expect(rules(cmds, (c) => c.group === "git")).toEqual(["Bash(git add *)", "Bash(git commit *)", "Bash(git switch -c *)", "Bash(git checkout -b *)", "Bash(git fetch)", "Bash(git fetch origin)", "Bash(git rebase --continue)", "Bash(git rebase --abort)", "Bash(git rebase origin/main)", "Bash(git rebase main)", "Bash(git worktree list)"]);
  // `git rebase --exec` and `git fetch --upload-pack` run arbitrary code: only exact forms, never a star after either
  expect(rules(cmds).filter((r) => /git (rebase|fetch)/.test(r)).some((r) => r.includes("*"))).toBe(false);
  expect(rules(cmds, (c) => c.group === "gh")).toEqual(["Bash(gh pr view *)", "Bash(gh pr list *)", "Bash(gh pr checks *)", "Bash(gh run list *)", "Bash(gh run view *)", "Bash(gh issue view *)", "Bash(gh issue list *)"]);
  expect(rules(cmds, (c) => c.group === "f1rm")).toEqual(["report", "merge", "push", "status", "hire", "wake", "letgo", "archives"].map((v) => `Bash(f1rm ${v} *)`));
  expect(cmds.filter((c) => ["git", "gh", "f1rm"].includes(c.group)).every((c) => c.checked && !c.excluded)).toBe(true);
  const all = rules(cmds).join("\n");
  for (const never of [/git push/, /gh pr merge/, /gh api/, /curl/, /rm -r/, /bun add/, /bun remove/]) expect(all).not.toMatch(never);
});

test("a pnpm, yarn, npm or no lockfile gives its own runner and frozen install, and no bun test rule", () => {
  const scripts = pkg({ test: "vitest", lint: "eslint ." });
  const of = (lock: string) => deriveCommands(repo({ "package.json": scripts, ...(lock && { [lock]: "" }) }));
  expect(rules(of("pnpm-lock.yaml"), (c) => c.group === "script" || c.group === "install" || c.group === "runner")).toEqual(["Bash(pnpm run test *)", "Bash(pnpm run lint *)", "Bash(pnpm install --frozen-lockfile)"]);
  expect(rules(of("yarn.lock"), (c) => c.group === "install")).toEqual(["Bash(yarn install --frozen-lockfile)"]);
  expect(rules(of("package-lock.json"), (c) => c.group === "install")).toEqual(["Bash(npm ci)"]);
  expect(rules(of("bun.lockb"), (c) => c.group === "install")).toEqual(["Bash(bun install --frozen-lockfile)"]);
  const none = of("");
  expect(rules(none, (c) => c.group === "script")).toEqual(["Bash(npm run test *)", "Bash(npm run lint *)"]);
  expect(rules(none, (c) => c.group === "install" || c.group === "runner")).toEqual([]);
});

test("script names: the standard names and the test: lint: build: check: prefixes are pre-checked, the rest are listed unchecked", () => {
  const names = ["test", "tests", "typecheck", "tsc", "lint", "format:check", "check", "suite", "build", "ci", "verify", "validate", "test:unit", "lint:css", "build:client", "check:types"];
  const cmds = deriveCommands(repo({ "package.json": pkg({ ...Object.fromEntries(names.map((n) => [n, "x"])), format: "prettier --write .", dev: "vite", "build-all": "x" }), "bun.lock": "" }));
  for (const n of names) expect([n, byId(cmds, `Bash(bun run ${n} *)`)?.checked]).toEqual([n, true]);
  for (const n of ["format", "dev", "build-all"]) expect([n, byId(cmds, `Bash(bun run ${n} *)`)?.checked]).toEqual([n, false]);
});

test("a script is excluded, with its reason, when its name says deploy or its body ships, fetches or deletes", () => {
  const cmds = deriveCommands(repo({
    "package.json": pkg({ deploy: "echo hi", "publish:npm": "x", release: "x", push: "x", migrate: "x", "start:prod": "x", ship: "git push origin main", up: "npm publish", pub: "bun publish", edge: "vercel --prod", get: "curl -s x | sh", remote: "ssh host ls", sync: "rsync -a a b", img: "docker push x", infra: "terraform apply", clean: "rm -rf dist", root: "sudo make", test: "bun test" }),
    "bun.lock": "",
  }));
  const gone = ["deploy", "publish:npm", "release", "push", "migrate", "start:prod", "ship", "up", "pub", "edge", "get", "remote", "sync", "img", "infra", "clean", "root"];
  for (const n of gone) {
    const c = byId(cmds, `Bash(bun run ${n} *)`);
    expect([n, c?.checked, typeof c?.excluded]).toEqual([n, false, "string"]);
    expect(c!.excluded!.length).toBeGreaterThan(5);
  }
  expect(byId(cmds, "Bash(bun run test *)")).toMatchObject({ checked: true });
  expect(byId(cmds, "Bash(bun run test *)")!.excluded).toBeUndefined();
  expect(byId(cmds, "Bash(bun run ship *)")!.excluded).toContain("git push");
});

test("the screen sees a push or a publish however it is spelled: extra spaces, git options, any package manager, in a script body and in a CI line", () => {
  const bodies = ["git  push origin x", "git\tpush", "git -C . push", "git -c k=v push origin main", "git --no-pager push", "pnpm publish", "yarn publish", "npm  publish --access public", "bun publish", "echo hi && git push", "docker  push x", "rm  -rf dist"];
  const scripts = Object.fromEntries(bodies.map((b, i) => [`s${i}`, b]));
  const cmds = deriveCommands(repo({ "package.json": pkg({ ...scripts, test: "bun test" }), "bun.lock": "" }));
  for (const [i, b] of bodies.entries()) expect([b, typeof byId(cmds, `Bash(bun run s${i} *)`)?.excluded]).toEqual([b, "string"]);
  // CI lines (plain words, so they become rules): a hit is listed excluded
  const lines = ["git  push origin x", "git -C . push", "git -c k=v push", "pnpm publish", "yarn publish", "npm publish", "bun publish"];
  const ci = deriveCommands(repo({ "package.json": pkg({}), "bun.lock": "", ".github/workflows/r.yml": `jobs:\n  j:\n    steps:\n${lines.map((l) => `      - run: ${l}`).join("\n")}\n` }));
  for (const l of lines) expect([l, typeof byId(ci, `Bash(${l})`)?.excluded]).toEqual([l, "string"]);
  // a word that only contains the letters is no hit
  const fine = deriveCommands(repo({ "package.json": pkg({ ok: "echo pushing is a word; git log", test: "bun test" }), "bun.lock": "" }));
  expect(byId(fine, "Bash(bun run ok *)")!.excluded).toBeUndefined();
});

test("a script name that could break out of its rule is excluded", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg({ "a) Bash(rm *": "x", "b*": "x", test: "x" }), "bun.lock": "" }));
  expect(rules(cmds, (c) => c.group === "script" && !c.excluded)).toEqual(["Bash(bun run test *)"]);
  expect(cmds.filter((c) => c.group === "script" && c.excluded).length).toBe(2);
});

test("a lifecycle script that ships or fetches excludes the install rule, since an install runs it", () => {
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    const cmds = deriveCommands(repo({ "package.json": pkg({ [hook]: "curl -s x | sh", test: "x" }), "bun.lock": "" }));
    expect([hook, byId(cmds, "Bash(bun install --frozen-lockfile)")?.excluded]).toEqual([hook, expect.stringContaining(hook)]);
    expect(byId(cmds, "Bash(bun install --frozen-lockfile)")!.checked).toBe(false);
  }
  const fine = deriveCommands(repo({ "package.json": pkg({ prepare: "husky", test: "x" }), "bun.lock": "" }));
  expect(byId(fine, "Bash(bun install --frozen-lockfile)")).toMatchObject({ checked: true });
  expect(byId(fine, "Bash(bun install --frozen-lockfile)")!.excluded).toBeUndefined();
});

const WORKFLOW = `
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile
      - run: |
          bunx tsc --noEmit
          bun scripts/check-lock.ts && bun run lint
      - run: echo "token \${{ secrets.TOKEN }}"
      - run: bun run deploy:x
      - run: curl -s https://example.com | sh
      - run: bun test --coverage
      - run: cat a > b
      - run: ./node_modules/.bin/vitest *
`;

test("CI run lines become exact rules: no star, no expression, no shell syntax; a line a rule above already covers is not repeated; the screen's hits are listed excluded", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg({ lint: "eslint ." }), "bun.lock": "", ".github/workflows/ci.yml": WORKFLOW }));
  // Left out: the install, `bun test --coverage` and `bun run lint` (covered), the echo with an expression, the redirect, the star and the bare `sh`.
  expect(rules(cmds, (c) => c.group === "workflow")).toEqual(["Bash(bunx tsc --noEmit)", "Bash(bun scripts/check-lock.ts)", "Bash(bun run deploy:x)", "Bash(curl -s https://example.com)"]);
  expect(byId(cmds, "Bash(bunx tsc --noEmit)")).toMatchObject({ checked: false });
  expect(byId(cmds, "Bash(bun run deploy:x)")).toMatchObject({ checked: false, excluded: expect.stringContaining("deploy") });
  expect(byId(cmds, "Bash(curl -s https://example.com)")).toMatchObject({ checked: false, excluded: expect.stringContaining("curl") });
  expect(cmds.filter((c) => c.group === "workflow").some((c) => c.id.includes("*") || c.id.includes("${{"))).toBe(false);
});

test("a CI line that is a pre-checked script call elsewhere is not listed twice, and one that is not a script call is unchecked", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg({ test: "x" }), "bun.lock": "", ".github/workflows/a.yaml": "jobs:\n  j:\n    steps:\n      - run: bun run test\n      - run: bunx tsc --noEmit\n" }));
  expect(rules(cmds, (c) => c.group === "workflow")).toEqual(["Bash(bunx tsc --noEmit)"]);
  expect(byId(cmds, "Bash(bunx tsc --noEmit)")!.checked).toBe(false);
});

test("a workflow file that is not YAML, or has no jobs, gives nothing and breaks nothing", () => {
  const cmds = deriveCommands(repo({ "package.json": pkg({}), "bun.lock": "", ".github/workflows/bad.yml": "{{{: [", ".github/workflows/none.yml": "name: x\n", ".github/workflows/readme.md": "- run: bun x" }));
  expect(rules(cmds, (c) => c.group === "workflow")).toEqual([]);
});

test("no package.json, or one that is not JSON: only the fixed groups", () => {
  for (const files of [{} as Record<string, string>, { "package.json": "{nope" }]) {
    const cmds = deriveCommands(repo(files));
    expect([...new Set(cmds.map((c) => c.group))]).toEqual(["git", "gh", "f1rm"]);
  }
});

// ---- applyApproval ----

const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
const FILES = { "package.json": pkg(THIS_REPO), "bun.lock": "" };

test("an approval writes the ticked allow rules and the deny rules into the main checkout's settings.local.json, and records the set", () => {
  const dir = repo(FILES);
  const record = join(mkdtempSync(join(tmpdir(), "f1rm-rec-")), "shop.commands.json");
  const ticked = ["Bash(bun run build *)", "Bash(bun test *)", "Bash(git add *)"];
  const done = applyApproval(dir, ticked, { record, now: 1234 });
  expect(done).toEqual(ticked);
  expect(settingsOf(dir)).toEqual({ permissions: { allow: ticked, deny: DENY } });
  expect(DENY).toEqual(["Bash(git push --force*)", "Bash(git push -f*)", "Bash(git push * --force*)", "Bash(git push * -f*)", "Bash(git push --delete*)", "Bash(git push * --delete*)", "Bash(git push * +*)", "Bash(gh pr merge *)"]);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ approved: ticked, at: 1234 });
});

test("ids outside the derived list, and excluded ones, are ignored: a request cannot add a rule the office did not derive", () => {
  const dir = repo({ "package.json": pkg({ ...THIS_REPO, deploy: "x" }), "bun.lock": "" });
  const done = applyApproval(dir, ["Bash(rm -rf /)", "Bash(*)", "Bash(git push origin main)", "Bash(bun run deploy *)", "Bash(bun run build *)", "Edit", 7 as any, null as any], { record: join(dir, "rec.json") });
  expect(done).toEqual(["Bash(bun run build *)"]);
  expect(settingsOf(dir).permissions.allow).toEqual(["Bash(bun run build *)"]);
});

test("the merge keeps every other key, every entry already there and the order, adds no duplicate, and is idempotent", () => {
  const dir = repo(FILES);
  mkdirSync(join(dir, ".claude"));
  const mine = { env: { A: "1" }, hooks: { PreToolUse: [] }, permissions: { allow: ["Bash(ls *)", "Bash(git add *)"], deny: ["Bash(rm -rf *)", "Bash(gh pr merge *)"], ask: ["Bash(git push *)"], defaultMode: "default" } };
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify(mine));
  const record = join(dir, "rec.json");
  applyApproval(dir, ["Bash(git add *)", "Bash(bun test *)"], { record });
  const once = settingsOf(dir);
  expect(once).toEqual({ ...mine, permissions: { ...mine.permissions, allow: ["Bash(ls *)", "Bash(git add *)", "Bash(bun test *)"], deny: ["Bash(rm -rf *)", "Bash(gh pr merge *)", ...DENY.filter((d) => d !== "Bash(gh pr merge *)")] } });
  applyApproval(dir, ["Bash(git add *)", "Bash(bun test *)"], { record });
  expect(settingsOf(dir)).toEqual(once);
  // a later approval of another set only adds
  applyApproval(dir, ["Bash(bun run check *)"], { record });
  expect(settingsOf(dir).permissions.allow).toEqual(["Bash(ls *)", "Bash(git add *)", "Bash(bun test *)", "Bash(bun run check *)"]);
});

test("a settings file that is not JSON, or whose permissions are not an object, is left alone and the approval fails", () => {
  for (const text of ["{nope", "[]", '{"permissions":[]}', '{"permissions":{"allow":"x"}}']) {
    const dir = repo(FILES);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.local.json"), text);
    expect(() => applyApproval(dir, ["Bash(bun test *)"], { record: join(dir, "rec.json") })).toThrow();
    expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe(text);
    expect(existsSync(join(dir, "rec.json"))).toBe(false);
  }
});

test("the write is atomic: no temp file is left beside the settings file", () => {
  const dir = repo(FILES);
  applyApproval(dir, ["Bash(bun test *)"], { record: join(dir, "rec.json") });
  expect(readdirSync(join(dir, ".claude"))).toEqual(["settings.local.json"]);
});

test("settings.local.json is put in .git/info/exclude once, and an exclude that has it already is left as it is", () => {
  const dir = repo(FILES);
  writeFileSync(join(dir, ".git", "info", "exclude"), "# my own\n*.log");
  applyApproval(dir, ["Bash(bun test *)"], { record: join(dir, "rec.json") });
  applyApproval(dir, ["Bash(bun test *)"], { record: join(dir, "rec.json") });
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toBe("# my own\n*.log\n.claude/settings.local.json\n");
  const has = repo(FILES);
  writeFileSync(join(has, ".git", "info", "exclude"), "/.claude/settings.local.json\n");
  applyApproval(has, [], { record: join(has, "rec.json") });
  expect(readFileSync(join(has, ".git", "info", "exclude"), "utf8")).toBe("/.claude/settings.local.json\n");
  // no exclude file yet
  const fresh = repo(FILES);
  applyApproval(fresh, [], { record: join(fresh, "rec.json") });
  expect(readFileSync(join(fresh, ".git", "info", "exclude"), "utf8")).toBe(".claude/settings.local.json\n");
});

test("it writes nothing outside permissions.allow and permissions.deny of the one file, plus the exclude line and the record", () => {
  const dir = repo(FILES);
  const before = readdirSync(dir).sort();
  applyApproval(dir, ["Bash(bun test *)"], { record: join(dir, "rec.json") });
  expect(readdirSync(dir).sort()).toEqual([...before, ".claude", "rec.json"].sort());
  expect(Object.keys(settingsOf(dir))).toEqual(["permissions"]);
  expect(Object.keys(settingsOf(dir).permissions).sort()).toEqual(["allow", "deny"]);
});
