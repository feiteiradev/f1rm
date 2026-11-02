// The commands card: it lists the derived lines as the server pre-checked them, greys the excluded ones with their reason, and sends only what is on.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Cmd } from "../server/projectcmds.ts";
import type { OfficeState } from "../server/office.ts";
import { approveCommands, commandOf, groupsOf, idsOn, isOn } from "./commands.ts";
import { CommandsCard } from "./commands.tsx";
import { projectState } from "./lobby.ts";

const LIST: Cmd[] = [
  { id: "Bash(bun run build *)", group: "script", checked: true },
  { id: "Bash(bun run smoke *)", group: "script", checked: false },
  { id: "Bash(bun run deploy *)", group: "script", checked: false, excluded: 'its name says "deploy"' },
  { id: "Bash(bun test *)", group: "runner", checked: true },
  { id: "Bash(git add *)", group: "git", checked: true },
];

test("the card lists every line with one checkbox, pre-checked as derived, an excluded line greyed with its reason and not tickable, and one button", () => {
  const html = renderToStaticMarkup(<CommandsCard room="/code/shop/.git" name="shop" list={LIST} />);
  expect(html).toContain("Commands for <span");
  expect(html).toContain("shop");
  expect(html.match(/type="checkbox"/g)).toHaveLength(LIST.length);
  expect(html.match(/checked=""/g)).toHaveLength(3);
  expect(html.match(/disabled=""/g)).toHaveLength(1);
  for (const c of LIST) expect(html).toContain(`<code>${commandOf(c.id)}</code>`);
  expect(html).toContain('data-excluded=""');
  expect(html).toContain('Left out: its name says &quot;deploy&quot;');
  expect(html).toContain("Approve these commands");
  expect(html.match(/<button/g)).toHaveLength(1);
});

test("lines are grouped in the derived order, and what a tick sends is the lines that are on", () => {
  expect(groupsOf(LIST).map((g) => [g.group, g.items.length])).toEqual([["script", 3], ["runner", 1], ["git", 1]]);
  expect(idsOn(LIST, {})).toEqual(["Bash(bun run build *)", "Bash(bun test *)", "Bash(git add *)"]);
  expect(idsOn(LIST, { "Bash(bun run smoke *)": true, "Bash(git add *)": false })).toEqual(["Bash(bun run build *)", "Bash(bun run smoke *)", "Bash(bun test *)"]);
  // an excluded line cannot be switched on, whatever the ticks say
  expect(isOn(LIST[2], { [LIST[2].id]: true })).toBe(false);
});

// The button's wiring: there is no DOM here, so this runs the action the button calls (the component only adds the ticks it holds).
test("the button POSTs commands/<encoded room> with the ids that are on: the pre-checks, minus what the user unticked, plus what they ticked", async () => {
  const sent: { url: string; method: string; body: unknown }[] = [];
  const real = { fetch: globalThis.fetch, location: (globalThis as any).location };
  (globalThis as any).location = { href: "http://127.0.0.1:4170/tok/" };
  globalThis.fetch = (async (url: URL, init: RequestInit) => (sent.push({ url: String(url), method: init.method!, body: JSON.parse(String(init.body)) }), Response.json({ ok: true }))) as unknown as typeof fetch;
  try {
    expect(await approveCommands("/Users/me/my shop/.git", LIST, { "Bash(git add *)": false, "Bash(bun run smoke *)": true })).toBeNull();
    expect(await approveCommands("/r/.git", LIST, {})).toBeNull();
  } finally {
    globalThis.fetch = real.fetch;
    (globalThis as any).location = real.location;
  }
  expect(sent).toEqual([
    { url: "http://127.0.0.1:4170/tok/commands/%2FUsers%2Fme%2Fmy%20shop%2F.git", method: "POST", body: { ids: ["Bash(bun run build *)", "Bash(bun run smoke *)", "Bash(bun test *)"] } },
    { url: "http://127.0.0.1:4170/tok/commands/%2Fr%2F.git", method: "POST", body: { ids: ["Bash(bun run build *)", "Bash(bun test *)", "Bash(git add *)"] } },
  ]);
});

test("a project's slice of the office keeps its own commands card and no other project's", () => {
  const state: OfficeState = { rooms: { a: { id: "a", name: "a" }, b: { id: "b", name: "b" } }, employees: {}, interns: {}, commands: { a: LIST, b: [] } };
  expect(projectState(state, "a").commands).toEqual({ a: LIST });
  expect(projectState({ ...state, commands: {} }, "a").commands).toBeUndefined();
});
