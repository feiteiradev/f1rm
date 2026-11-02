// The top bar's Stop all / Resume all: what it shows, that one confirm comes before anything posts, and what it says of the office's reply.
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OUT_OF_DATE } from "./post.ts";
import { escapeCancels, IDLE, keepsStatus, OWN_MS, stopAllControls, type View } from "./stopall.ts";
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

/** A page whose fetch is `fetch`. */
const page = (fetch: (url: URL, init: RequestInit) => Promise<Response>) => Object.assign(globalThis, { location: { href: "http://127.0.0.1:4170/tok/" }, fetch });
const stopWith = async () => {
  const k = controls();
  await k.c.confirm();
  return k.now();
};

test("no results never reads as All 0 stopped: it says what the office paused, or that there was nothing to stop", async () => {
  office({ ok: true, rooms: ["shop", "blog"], results: [] });
  expect(await stopWith()).toEqual({ phase: "idle", status: "Paused shop, blog; nothing was running to check.", failed: false });
  office({ ok: true, rooms: [], results: [] });
  expect((await stopWith()).status).toBe("Nothing to stop: every project is already paused.");
});

test("a 200 that is no JSON is an error, for Stop all and Resume all", async () => {
  page(async () => new Response("<html>", { status: 200 }));
  const stop = await stopWith();
  expect([stop.failed, stop.status]).toEqual([true, expect.stringContaining("could not be read")]);
  expect(stop.status).not.toContain("All ");
  const k = controls();
  await k.c.resume();
  expect([k.now().failed, k.now().status]).toEqual([true, expect.stringContaining("could not be read")]);
});

test("an old link, an office that is gone and one that does not answer each say so and leave the button usable", async () => {
  page(async () => new Response("unauthorized", { status: 401 }));
  expect(await stopWith()).toMatchObject({ phase: "idle", failed: true, status: expect.stringContaining(OUT_OF_DATE) });
  page(async () => Promise.reject(new TypeError("fetch failed")));
  expect(await stopWith()).toMatchObject({ phase: "idle", failed: true, status: expect.stringContaining("The office isn't reachable.") });
  page(async () => Promise.reject(new DOMException("timed out", "TimeoutError")));
  expect(await stopWith()).toMatchObject({ phase: "idle", failed: true, status: expect.stringContaining("did not answer in time") });
});

test("the stop waits at most two minutes for the office", async () => {
  let signal: AbortSignal | null | undefined;
  page(async (_url, init) => ((signal = init.signal), Response.json({ ok: true, rooms: [], results: [] })));
  await stopWith();
  expect(signal).toBeInstanceOf(AbortSignal);
});

test("whatever goes wrong while it runs, the button comes back to idle with a failure text", async () => {
  office({ ok: true, rooms: ["shop"], results: [null] }); // a reply the page cannot read
  expect(await stopWith()).toMatchObject({ phase: "idle", failed: true, status: expect.stringContaining("Something went wrong") });
  const k = controls();
  await k.c.confirm();
  expect(k.views.map((v) => v.phase)).toEqual(["stopping", "idle"]);
});

test("a second click while a stop runs does nothing: one post, and nothing else opens until it is done", async () => {
  let release!: () => void;
  const posts: string[] = [];
  page(async (url) => (posts.push(url.pathname), await new Promise<void>((r) => (release = r)), Response.json({ ok: true, rooms: [], results: [] })));
  const k = controls();
  const first = k.c.confirm();
  await Promise.resolve();
  await k.c.confirm();
  await k.c.resume();
  k.c.ask();
  k.c.cancel();
  expect(posts).toEqual(["/tok/pause"]);
  expect(k.now().phase).toBe("stopping");
  release();
  await first;
  expect(k.now().phase).toBe("idle");
  k.c.ask();
  expect(k.now().phase).toBe("confirm");
});

test("a stop that failed half-way names who did stop, says what the error was, and how to try again", async () => {
  office({ ok: false, error: "blog: could not take the checkpoint", rooms: ["shop"], results: [stopped("shop")] }, 500);
  const done = await stopWith();
  expect(done.failed).toBe(true);
  expect(done.status).toContain("blog: could not take the checkpoint");
  expect(done.status).toContain("Stopped: shop.");
  expect(done.status).toContain("`f1rm pause --all` again");
  expect(done.status).toContain("press Stop all again");
  office({ ok: true, rooms: ["a"], results: [stopped("a", { verified: false, remaining: [{ pid: 9, command: "node s.js", cwd: null }] })] });
  expect((await stopWith()).status).toContain("`f1rm pause --all` again");
});

test("Escape closes the question only while it is open; a result text is stale only when no action of the page made it", () => {
  const view = (phase: View["phase"]): View => ({ ...IDLE, phase });
  expect(escapeCancels(view("confirm"), "Escape")).toBe(true);
  expect(escapeCancels(view("confirm"), "Enter")).toBe(false);
  for (const phase of ["idle", "stopping", "resuming"] as const) expect(escapeCancels(view(phase), "Escape")).toBe(false);
  expect(keepsStatus(view("idle"), OWN_MS + 1)).toBe(false);
  expect(keepsStatus(view("idle"), 10)).toBe(true);
  expect(keepsStatus(view("stopping"), OWN_MS + 1)).toBe(true);
});
