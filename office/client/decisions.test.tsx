// A decision ticket in the Approvals tray: the question, one button per option with the recommendation marked, the risk, a link to the ticket, the badge, and what an answer posts.
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OfficeState } from "../server/office.ts";
import type { Decision } from "../server/scheduler.ts";
import { Tray } from "./approvals.tsx";
import { answerDecision, takeRecommended } from "./approvals.ts";

const real = { fetch: globalThis.fetch, location: (globalThis as any).location };
afterEach(() => Object.assign(globalThis, real));

const D: Decision = { id: "/code/shop#12", repo: "/code/shop", number: 12, url: "https://github.com/o/shop/issues/12", question: "Keep the old API?", options: ["Keep it", "Drop it, nothing uses it"], recommended: 1, restart: null, drop: null, ready: null, raise: null, ticket: null, risk: "low", step: "implement-7", spec: 7, at: 0 };
const state = (decisions: Decision[]) => ({ rooms: {}, employees: {}, approvals: [], decisions }) as unknown as OfficeState;
const open = (decisions: Decision[]) => renderToStaticMarkup(<Tray state={state(decisions)} open0 />);

test("a decision ticket waits in the tray: its question, one button per option with the recommendation marked, the risk and a link to the ticket", () => {
  const h = open([D]);
  expect(h).toContain('aria-label="1 waiting"');
  expect(h).toContain('<article class="decision" aria-label="shop needs a decision">');
  expect(h).toContain("<p class=\"question\">Keep the old API?</p>");
  expect(h).toContain(">Keep it</button>");
  expect(h).toContain(">Drop it, nothing uses it <span class=\"recommended\">recommended</span></button>");
  expect(h).toContain("Low risk: the recommendation is taken 4 hours after the ticket opened if nobody answers.");
  expect(h).toContain('href="https://github.com/o/shop/issues/12"');
  expect(open([{ ...D, risk: "high", recommended: null }])).toContain("High risk: it waits for you.");
  expect(open([{ ...D, recommended: null }])).toContain("Low risk, but no recommendation: it waits for you.");
});

test("an answer posts the picked option to the decision's route", async () => {
  const posts: { path: string; body: unknown }[] = [];
  Object.assign(globalThis, {
    location: { href: "http://127.0.0.1:4170/tok/" },
    fetch: async (url: URL, init: RequestInit) => (posts.push({ path: url.pathname, body: init.body }), Response.json({ ok: true })),
  });
  expect(await answerDecision(D.id, 1)).toBeNull();
  expect(posts).toEqual([{ path: "/tok/decide/%2Fcode%2Fshop%2312", body: JSON.stringify({ option: 1 }) }]);
});

test("with two or more recommendations waiting, one button takes them all: each posts its own recommended option, and one without a recommendation is left", async () => {
  const two = [D, { ...D, id: "/code/shop#13", number: 13, risk: "high" as const, recommended: 0 }];
  expect(open(two)).toContain(">Take all 2 recommendations</button>");
  expect(open([D])).not.toContain("Take all");
  expect(open([D, { ...D, id: "/code/shop#14", recommended: null }])).not.toContain("Take all");
  const posts: { path: string; body: unknown }[] = [];
  Object.assign(globalThis, {
    location: { href: "http://127.0.0.1:4170/tok/" },
    fetch: async (url: URL, init: RequestInit) => (posts.push({ path: url.pathname, body: init.body }), Response.json({ ok: true })),
  });
  const seen: number[] = [];
  expect(await takeRecommended([...two, { ...D, id: "/code/shop#14", recommended: null }], (done) => seen.push(done))).toEqual([]);
  expect(seen).toEqual([1, 2]);
  expect(posts).toEqual([
    { path: "/tok/decide/%2Fcode%2Fshop%2312", body: JSON.stringify({ option: 1 }) },
    { path: "/tok/decide/%2Fcode%2Fshop%2313", body: JSON.stringify({ option: 0 }) },
  ]);
});
