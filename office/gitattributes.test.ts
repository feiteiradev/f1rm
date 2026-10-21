// The decisions log merges by union: two branches that append different entries to it merge without a conflict.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  return p.exitCode === 0;
}

const entry = (who: string) => [`## 2026-10-21 Title ${who}`, `- Decision: decide ${who}`, `- Why: because ${who}`, `- Rejected: not ${who}`, `- Where: task-${who}`].map((l) => l + "\n").join("");
const card = (who: string, first = `<article id="${who}">`, last = `<!-- end ${who} -->`) =>
  [first, `  <h2>Title ${who}</h2>`, `  <p>Decision: decide ${who}</p>`, `  <p>Why: because ${who}</p>`, `  <p>Where: task-${who}</p>`, last].map((l) => l + "\n").join("");

/** Two branches off one commit, each inserting its own multi-line block before `marker` (or at the end), merged into main one after the other. */
function mergeTwoBranches(file: string, seed: string, block: (who: string) => string, attributes: string | null, marker?: string) {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-attrs-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), seed);
  if (attributes) writeFileSync(join(dir, ".gitattributes"), attributes);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  for (const name of ["one", "two"]) {
    git(dir, "checkout", "-q", "-b", name, "main");
    const text = readFileSync(join(dir, file), "utf8");
    writeFileSync(join(dir, file), marker ? text.replace(marker, block(name) + marker) : text + block(name));
    git(dir, "commit", "-q", "-am", name);
  }
  git(dir, "checkout", "-q", "main");
  expect(git(dir, "merge", "--no-ff", "-q", "-m", "one", "one")).toBe(true);
  return { merged: git(dir, "merge", "--no-ff", "-q", "-m", "two", "two"), text: readFileSync(join(dir, file), "utf8") };
}

test("this repo's .gitattributes merges docs/decisions.md by union", () => {
  expect(readFileSync(join(REPO, ".gitattributes"), "utf8").split("\n")).toContain("docs/decisions.md merge=union");
});

test("two branches appending different multi-line entries to docs/decisions.md conflict without the attribute and merge with both entries with it", () => {
  const seed = "# Decisions\n\n## 2026-10-20 Seeded\n- Decision: x\n";
  expect(mergeTwoBranches("docs/decisions.md", seed, entry, null).merged).toBe(false);
  const { merged, text } = mergeTwoBranches("docs/decisions.md", seed, entry, "docs/decisions.md merge=union\n");
  expect(merged).toBe(true);
  expect(text).toContain(entry("one"));
  expect(text).toContain(entry("two"));
});

test("the same holds for a docs/decisions.html log, with both entries going in before the closing tags, which stay in place", () => {
  const seed = "<!doctype html>\n<html>\n<body>\n<main>\n</main>\n</body>\n</html>\n";
  expect(mergeTwoBranches("docs/decisions.html", seed, card, null, "</main>\n").merged).toBe(false);
  const { merged, text } = mergeTwoBranches("docs/decisions.html", seed, card, "docs/decisions.html merge=union\n", "</main>\n");
  expect(merged).toBe(true);
  expect(text).toContain(card("one"));
  expect(text).toContain(card("two"));
  expect(text.endsWith("</main>\n</body>\n</html>\n")).toBe(true);
});

test("union folds the identical first and last lines of two entries into one: an HTML entry starts and ends with a line of its own", () => {
  const seed = "<main>\n</main>\n";
  const plain = (who: string) => card(who, "<article>", "</article>");
  const { merged, text } = mergeTwoBranches("docs/decisions.html", seed, plain, "docs/decisions.html merge=union\n", "</main>\n");
  expect(merged).toBe(true);
  expect(text).not.toContain(plain("one")); // the two cards fused into one <article>
  expect(text.match(/<article>/g)?.length).toBe(1);
  expect(text.match(/<\/article>/g)?.length).toBe(1);
});
