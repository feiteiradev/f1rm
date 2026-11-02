// The top bar's Stop all / Resume all: what it shows, that one confirm comes before anything posts, and what it says of the office's reply.
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { IDLE, stopAllControls, type View } from "./stopall.ts";
import { StopAll, StopAllView } from "./stopall.tsx";

const real = { fetch: globalThis.fetch, location: (globalThis as any).location, mode: process.env.MODE };
afterEach(() => {
  Object.assign(globalThis, { fetch: real.fetch, location: real.location });
  if (real.mode === undefined) delete process.env.MODE;
  else process.env.MODE = real.mode;
});

/** A page at /tok/ whose office answers `reply` (status `status`) and records every post. */
function office(reply: object, status = 200) {
  const posts: { path: string; body: unknown }[] = [];
  Object.assign(globalThis, {
    location: { href: "http://127.0.0.1:4170/tok/" },
    fetch: async (url: URL, init: RequestInit) => (posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) }), Response.json(reply, { status })),
  });
  return posts;
}
/** The controls on a view that starts idle; `views` is every view they set, `now()` the last. */
function controls() {
  const views: View[] = [];
  return { c: stopAllControls((v) => views.push(v)), views, now: () => views[views.length - 1] };
}
const html = (paused: string[], view: View = IDLE) => renderToString(createElement(StopAllView, { paused, view, controls: stopAllControls(() => {}) }));
const stopped = (room: string, over: object = {}) => ({ room, stopped: ["lead-a", "dev-b"], killed: [{ pid: 7, command: "sleep 600", cwd: null, signal: "SIGTERM" }], remaining: [], checkpoint: `cp-${room}`, verified: true, saved: [], ...over });

test("nothing paused shows a Stop all button; a paused project shows Resume all in its place", () => {
  expect(html([])).toContain(">Stop all</button>");
  expect(html([])).not.toContain("Resume all");
  expect(html(["shop"])).toContain(">Resume all</button>");
  expect(html(["shop"])).not.toContain("Stop all");
  expect(html([])).toContain('role="status"');
});

test("the demo recording shows no button", () => {
  process.env.MODE = "demo";
  expect(renderToString(createElement(StopAll, { paused: [] }))).toBe("");
});

test("Stop all asks once and posts nothing until Confirm; Cancel posts nothing and goes back", async () => {
  const posts = office({ ok: true, rooms: [], results: [] });
  const { c, now } = controls();
  c.ask();
  expect(now().phase).toBe("confirm");
  expect(html([], now())).toContain("Stop all projects?");
  expect(html([], now())).toContain(">Confirm</button>");
  expect(html([], now())).toContain(">Cancel</button>");
  c.cancel();
  expect(now()).toEqual(IDLE);
  expect(posts).toEqual([]);
  c.ask();
  await c.confirm();
  expect(posts).toEqual([{ path: "/tok/pause", body: { all: true } }]);
});

test("while the stop runs the button is busy and says so", async () => {
  office({ ok: true, rooms: ["a"], results: [stopped("a")] });
  const { c, views } = controls();
  const done = c.confirm();
  expect(views[0]!.phase).toBe("stopping");
  expect(html([], views[0]!)).toContain('aria-disabled="true"');
  expect(html([], views[0]!)).toContain("Stopping");
  await done;
});

test("All N stopped counts the sessions and processes of every project and names the checkpoints", async () => {
  office({ ok: true, rooms: ["a", "b"], results: [stopped("a"), stopped("b", { killed: [], checkpoint: "cp-two" })] });
  const { c, now } = controls();
  await c.confirm();
  expect(now().failed).toBe(false);
  expect(now().status).toBe("All 5 stopped. Checkpoints cp-a, cp-two.");
  expect(html([], now())).toContain("All 5 stopped. Checkpoints cp-a, cp-two.");
});

test("a project the office could not verify shows what still runs, never All N stopped", async () => {
  office({ ok: true, rooms: ["a"], results: [stopped("a", { verified: false, remaining: [{ pid: 9, command: "node server.js", cwd: "/x" }] })] });
  const { c, now } = controls();
  await c.confirm();
  expect(now().failed).toBe(true);
  expect(now().status).toContain("a is NOT stopped");
  expect(now().status).toContain("pid 9 node server.js");
  expect(now().status).not.toContain("All ");
});

test("an error reply shows the error, never All N stopped", async () => {
  office({ ok: false, error: "shop: the stop failed", rooms: [], results: [stopped("a")] }, 500);
  const { c, now } = controls();
  await c.confirm();
  expect(now().failed).toBe(true);
  expect(now().status).toContain("shop: the stop failed");
  expect(now().status).not.toContain("All ");
});

test("Resume all posts all:true to resume and says who woke and who did not", async () => {
  const posts = office({ ok: true, rooms: ["shop", "blog"], waking: 3, lost: [{ name: "dev-x", why: "its session is gone" }] });
  const { c, now } = controls();
  await c.resume();
  expect(posts).toEqual([{ path: "/tok/resume", body: { all: true } }]);
  expect(now().status).toBe("Resumed shop, blog: 3 hires waking. NOT woken: dev-x (its session is gone).");
  expect(now().failed).toBe(true);
  office({ ok: true, rooms: [], waking: 0, lost: [] });
  await c.resume();
  expect(now().status).toBe("No project was paused.");
});
