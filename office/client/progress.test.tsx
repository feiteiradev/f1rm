// The project room's progress panel: done over total with a bar, the last landed task, what is stuck, and desk lines whose proofs are links.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Topic } from "../server/progress.ts";
import type { OfficeState } from "../server/office.ts";
import { ago, proofHref } from "./progress.ts";
import { Progress } from "./progress.tsx";
import { projectState } from "./lobby.ts";

const NOW = Date.parse("2026-11-03T12:12:00Z");
const topic: Topic = {
  team: "topics",
  done: 3,
  total: 5,
  last: { task: "effort-flag", at: "2026-11-03T12:00:00Z" },
  stuck: ["T4 blocked: waits for a slot"],
  desk: [
    { at: "2026-11-03T12:00:00Z", task: "effort-flag", proof: "shot-1.png", note: "the flag lands" },
    { at: "2026-11-03T11:00:00Z", task: "gauges", proof: "https://example.com/g", note: "gauges <b>land</b>" },
    { at: "2026-11-03T10:00:00Z", task: "plumbing", proof: "none (not visible)", note: "no ui" },
  ],
};

test("a topic shows done over total with a bar, the last landed task with its age, and what is stuck", () => {
  const html = renderToStaticMarkup(<Progress topics={[topic]} repo="shop" now={NOW} />);
  expect(html).toContain("topics");
  expect(html).toContain("3 / 5 done");
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="3"');
  expect(html).toContain('aria-valuemax="5"');
  expect(html).toContain("effort-flag");
  expect(html).toContain("12m ago");
  expect(html).toContain("T4 blocked: waits for a slot");
});

test("a topic with nothing stuck says none; no topics render nothing", () => {
  expect(renderToStaticMarkup(<Progress topics={[{ ...topic, stuck: [] }]} repo="shop" now={NOW} />)).toContain("stuck: none");
  expect(renderToStaticMarkup(<Progress topics={[]} repo="shop" now={NOW} />)).toBe("");
});

test("desk lines link to their proof inside the evidence route, a https proof opens as it is, and a line without a proof has no link", () => {
  const html = renderToStaticMarkup(<Progress topics={[topic]} repo="shop" now={NOW} />);
  expect(html).toContain('href="evidence/shop/lead-topics/shot-1.png"');
  expect(html).toContain('href="https://example.com/g"');
  expect(html.match(/<a /g)).toHaveLength(2);
  expect(html).toContain("gauges &lt;b&gt;land&lt;/b&gt;");
});

test("a proof path becomes the evidence route's address, and anything else is no link", () => {
  expect(proofHref("shot 1.png", "shop", "x")).toBe("evidence/shop/lead-x/shot%201.png");
  expect(proofHref("/Users/me/.f1rm/evidence/shop/task/a.png", "shop", "x")).toBe("evidence/shop/task/a.png");
  expect(proofHref("/etc/passwd", "shop", "x")).toBeNull();
  expect(proofHref("javascript:alert(1)", "shop", "x")).toBeNull();
  expect(proofHref("http://insecure.example", "shop", "x")).toBeNull();
  expect(proofHref("none (not visible)", "shop", "x")).toBeNull();
  expect(proofHref("", "shop", "x")).toBeNull();
});

test("ages read as minutes, hours and days", () => {
  const t = (ms: number) => ago(new Date(NOW - ms).toISOString(), NOW);
  expect([t(20_000), t(12 * 60_000), t(2 * 3600_000), t(3 * 86400_000)]).toEqual(["just now", "12m ago", "2h ago", "3d ago"]);
  expect(ago(null, NOW)).toBe("");
  expect(ago("nonsense", NOW)).toBe("");
});

test("a project's slice carries its topics", () => {
  const state = { rooms: { a: { id: "a", name: "a" }, b: { id: "b", name: "b" } }, employees: {}, interns: {}, topics: { a: [topic], b: [] } } as OfficeState;
  expect(projectState(state, "a").topics).toEqual({ a: [topic] });
});
