// The one-time leftovers card in the Approvals tray: its copy and groups, the two answers and what they post (never ids), the busy and failure states, and the badge.
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LeftoversView } from "../server/gauges.ts";
import type { OfficeState } from "../server/office.ts";
import { answerLeftovers, OPEN, sampleOf, type View } from "./leftovers.ts";
import { LeftoversView as Card } from "./leftovers.tsx";
import { Tray } from "./approvals.tsx";

const real = { fetch: globalThis.fetch, location: (globalThis as any).location };
afterEach(() => Object.assign(globalThis, real));

const FP = "ab12cd34ef56ab78";
const CARD: LeftoversView = {
  count: 39, running: 27, exited: 12, moreGroups: 0, fingerprint: FP,
  groups: [
    { prefix: "tideline-e2e-*", running: 11, exited: 0, names: Array.from({ length: 8 }, (_, i) => `tideline-e2e-0${i}`) },
    { prefix: "quillbase-e2e-*", running: 9, exited: 0, names: ["quillbase-e2e-1d7e90", "quillbase-e2e-52ac08", "quillbase-e2e-7"].slice(0, 3) },
    { prefix: "review-marlow-*", running: 0, exited: 2, names: ["review-marlow-77", "review-marlow-80"] },
  ],
};
const html = (view: View = OPEN, card = CARD) => renderToStaticMarkup(<Card card={card} view={view} controls={{ remove: () => {}, keep: () => {} }} />);

function office(reply: object, status = 200) {
  const posts: { path: string; method: string; body: unknown }[] = [];
  Object.assign(globalThis, {
    location: { href: "http://127.0.0.1:4170/tok/" },
    fetch: async (url: URL, init: RequestInit) => (posts.push({ path: url.pathname, method: init.method!, body: init.body }), Response.json(reply, { status })),
  });
  return posts;
}

test("the card says what will happen in the spec's words, from the data", () => {
  const h = html();
  expect(h).toContain('<article class="leftovers" aria-label="Leftover containers">');
  expect(h).toContain('Leftover containers <span class="count">39</span>');
  expect(h).toContain("Left behind by other projects, not tagged by f1rm. <b>Remove</b> stops the 27 running ones and deletes all 39. Images, volumes and everything else stay. You are asked once.");
});

test("one details per group with the pattern, count and state, a closed one-line sample, and the names capped at 8 plus and N more", () => {
  const h = html();
  expect(h.match(/<details/g)).toHaveLength(3);
  expect(h).toContain('<span class="pattern">tideline-e2e-*</span><span class="kind">11 running</span>');
  expect(h).toContain('<span class="kind">2 exited</span>');
  expect(h).toContain("quillbase-e2e-1d7e90 and 8 more");
  expect(h).toContain("<li>and 3 more</li>"); // tideline: 11 in the group, 8 named
  expect(h).not.toContain("and 0 more");
  expect(h.match(/<li>tideline-e2e-0\d<\/li>/g)).toHaveLength(8);
  expect(sampleOf({ prefix: "p-*", running: 1, exited: 0, names: ["p-1"] })).toBe("p-1");
});

test("two buttons: Yes names its count, Not now keeps; both are plain buttons in the focus order after the groups", () => {
  const h = html();
  expect(h).toContain(">Yes, remove 39 containers</button>");
  expect(h).toContain(">Not now, keep them</button>");
  expect(h.match(/<button/g)).toHaveLength(2);
  expect(h.indexOf("</details>")).toBeLessThan(h.indexOf("Yes, remove"));
  expect(html(OPEN, { ...CARD, count: 1, running: 1, exited: 0 })).toContain("Yes, remove 1 container<");
});

test("busy: both buttons aria-disabled (not disabled), the Yes label is Removing…", () => {
  const h = html({ phase: "busy" });
  expect(h).toContain("Removing…");
  expect(h.match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(h).not.toContain(" disabled");
  expect(h).not.toContain("Yes, remove");
});

test("a failed removal keeps the card with the problem as an alert and Yes becomes Try again", () => {
  const h = html({ phase: "open", problem: "Removed 31 of 39. 8 could not be removed: device busy. Try again or keep them." });
  expect(h).toContain('<p class="problem" role="alert">Removed 31 of 39. 8 could not be removed: device busy. Try again or keep them.</p>');
  expect(h).toContain(">Try again</button>");
  expect(h).toContain(">Not now, keep them</button>");
});

test("Yes posts leftovers/remove with the fingerprint of the list it was shown and no ids (the office decides what to delete), and settles with what was removed", async () => {
  const posts = office({ ok: true, removed: 39 });
  const seen: View[] = [];
  await answerLeftovers("remove", FP, (v) => seen.push(v));
  expect(posts).toEqual([{ path: "/tok/leftovers/remove", method: "POST", body: `{"fingerprint":"${FP}"}` }]);
  expect(seen[0]).toEqual({ phase: "busy" });
  expect(seen[seen.length - 1]).toEqual({ phase: "done", note: "Removed 39 leftover containers. Nothing else was touched." });
});

test("an answer the office could not save is said in the line", async () => {
  office({ ok: true, removed: 39, note: "The answer was not saved, so f1rm may ask again after a restart." });
  const seen: View[] = [];
  await answerLeftovers("remove", FP, (v) => seen.push(v));
  expect(seen[seen.length - 1]).toEqual({ phase: "done", note: "Removed 39 leftover containers. Nothing else was touched. The answer was not saved, so f1rm may ask again after a restart." });
});

test("a list that changed under the click is refused and the card stays, with the office's words", async () => {
  office({ ok: false, error: "The list changed, review it again." }, 409);
  const seen: View[] = [];
  await answerLeftovers("remove", FP, (v) => seen.push(v));
  expect(seen[seen.length - 1]).toEqual({ phase: "open", problem: "The list changed, review it again." });
});

test("groups past the cap are counted: and N more groups", () => {
  expect(html(OPEN, { ...CARD, moreGroups: 5 })).toContain('<p class="more">and 5 more groups</p>');
  expect(html()).not.toContain("more groups");
});

test("Not now posts leftovers/keep and settles with the kept line", async () => {
  const posts = office({ ok: true });
  const seen: View[] = [];
  await answerLeftovers("keep", FP, (v) => seen.push(v));
  expect(posts.map((p) => p.path)).toEqual(["/tok/leftovers/keep"]);
  expect(seen[seen.length - 1]).toEqual({ phase: "done", note: "Kept. f1rm will not ask about these again." });
});

test("a refused removal returns to the open card with the office's own words as the problem", async () => {
  office({ ok: false, error: "Removed 31 of 39. 8 could not be removed: device busy. Try again or keep them.", removed: 31, failed: 8 }, 502);
  const seen: View[] = [];
  await answerLeftovers("remove", FP, (v) => seen.push(v));
  expect(seen[seen.length - 1]).toEqual({ phase: "open", problem: "Removed 31 of 39. 8 could not be removed: device busy. Try again or keep them." });
});

test("the Approvals badge counts the card, and does not when there is none", () => {
  const state = (leftovers: LeftoversView | null): OfficeState => ({ rooms: {}, employees: {}, interns: {}, approvals: [], leftovers });
  expect(renderToStaticMarkup(<Tray state={state(CARD)} />)).toContain('aria-label="1 waiting"');
  expect(renderToStaticMarkup(<Tray state={state(CARD)} />)).toContain("data-waiting");
  expect(renderToStaticMarkup(<Tray state={state(null)} />)).toContain('aria-label="0 waiting"');
});

test("an open tray always has its status region (empty until an answer fills it) and a panel focus can move to", () => {
  const state = (leftovers: LeftoversView | null): OfficeState => ({ rooms: {}, employees: {}, interns: {}, approvals: [], leftovers });
  for (const s of [state(CARD), state(null)]) {
    const h = renderToStaticMarkup(<Tray state={s} open0 />);
    expect(h).toContain('<p class="none" role="status"></p>');
    expect(h).toContain('tabindex="-1"');
  }
});
