// The decisions log merges by union: two branches that append different entries to it merge without a conflict.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  return p.exitCode === 0;
}

// Real entries start with a blank line, as docs/decisions.md's do.
const entry = (who: string) => ["", `## 2026-10-21 Title ${who}`, `- Decision: decide ${who}`, `- Why: because ${who}`, `- Rejected: not ${who}`, `- Where: task-${who}`].map((l) => l + "\n").join("");
// An HTML entry opens with a tag that has an id and ends with a closing comment after its closing tag; `plain` has neither.
const card = (who: string, first = `<article id="${who}">`, last = `<!-- end ${who} -->`) =>
  [first, `  <h2>Title ${who}</h2>`, `  <p>Decision: decide ${who}</p>`, `  <p>Why: because ${who}</p>`, `  <p>Where: task-${who}</p>`, "</article>", ...(last ? [last] : [])].map((l) => l + "\n").join("");

/** Two branches off one commit, each inserting its own multi-line block before `marker` (or at the end), merged into main one after the other. */
function mergeTwoBranches(file: string, seed: string, block: (who: string) => string, attributes: string | null, marker?: string) {
  const dir = mkdtempSync(join(tmpdir(), "f1rm-attrs-"));
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("two branches appending different multi-line entries to docs/decisions.md conflict without the attribute and merge with both entries with it", () => {
  const seed = "# Decisions\n\n## 2026-10-20 Seeded\n- Decision: x\n- Where: seed\n";
  expect(mergeTwoBranches("docs/decisions.md", seed, entry, null).merged).toBe(false);
  const { merged, text } = mergeTwoBranches("docs/decisions.md", seed, entry, "docs/decisions.md merge=union\n");
  expect(merged).toBe(true);
  expect(text).toContain(entry("one").slice(1));
  expect(text).toContain(entry("two").slice(1));
  // The blank line that opens each entry folds into one: the second heading follows the first entry's last line.
  expect(text).toContain("- Where: task-one\n## 2026-10-21 Title two\n");
});

test("the same holds for a docs/decisions.html log, with both entries going in before the closing tags, which stay in place", () => {
  const seed = "<!doctype html>\n<html>\n<body>\n<main>\n</main>\n</body>\n</html>\n";
  expect(mergeTwoBranches("docs/decisions.html", seed, card, null, "</main>\n").merged).toBe(false);
  const { merged, text } = mergeTwoBranches("docs/decisions.html", seed, card, "docs/decisions.html merge=union\n", "</main>\n");
  expect(merged).toBe(true);
  expect(text).toContain(card("one"));
  expect(text).toContain(card("two"));
  expect(text.match(/<\/article>/g)?.length).toBe(2);
  expect(text.endsWith("</main>\n</body>\n</html>\n")).toBe(true);
});

test("union folds the identical first and last lines of two entries: an HTML entry needs an opening tag with an id and a closing comment, or a closing tag is lost", () => {
  const seed = "<main>\n</main>\n";
  // Both end `</article>`: the shared closing tag folds, and the first card is left open.
  const plain = (who: string) => card(who, `<article id="${who}">`, "");
  const folded = mergeTwoBranches("docs/decisions.html", seed, plain, "docs/decisions.html merge=union\n", "</main>\n");
  expect(folded.merged).toBe(true);
  expect(folded.text.match(/<article/g)?.length).toBe(2);
  expect(folded.text.match(/<\/article>/g)?.length).toBe(1);
  // Neither first nor last lines shared: nothing folds.
  const unique = mergeTwoBranches("docs/decisions.html", seed, card, "docs/decisions.html merge=union\n", "</main>\n");
  expect(unique.text.match(/<article/g)?.length).toBe(2);
  expect(unique.text.match(/<\/article>/g)?.length).toBe(2);
});
