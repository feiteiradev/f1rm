// The machine module's liveSessions against a stub `claude` on PATH.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "f1rm-machine-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "claude"), '#!/bin/sh\nprintf %s "$STUB_OUT"\nexit "${STUB_EXIT:-0}"\n');
chmodSync(join(dir, "claude"), 0o755);

// Bun resolves a spawned command against the PATH it started with, so liveSessions runs in a child that starts with the stub first.
async function claudeAgents(out: string, exit = 0) {
  const child = Bun.spawn(
    ["bun", "-e", `import { machine } from ${JSON.stringify(import.meta.dir + "/machine.ts")}; const s = await machine.liveSessions(); console.log(JSON.stringify(s && [...s]))`],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_OUT: out, STUB_EXIT: String(exit) }, stdout: "pipe" },
  );
  const ids: string[] | null = JSON.parse(await new Response(child.stdout).text());
  return ids && new Set(ids);
}

test("liveSessions lists the session ids of `claude agents --json`", async () => {
  const out = JSON.stringify([
    { pid: 1, cwd: "/code/shop", kind: "interactive", startedAt: 0, sessionId: "a", name: "x", status: "busy" },
    { pid: 2, cwd: "/code/shop", kind: "background", startedAt: 0, sessionId: "b", name: "y", status: "waiting", waitingFor: "approval" },
  ]);
  expect(await claudeAgents(out)).toEqual(new Set(["a", "b"]));
  expect(await claudeAgents("[]")).toEqual(new Set());
});

test("liveSessions is null when claude agents fails, so nobody is mistaken for gone", async () => {
  expect(await claudeAgents("[]", 1)).toBeNull();
  expect(await claudeAgents("not json")).toBeNull();
  expect(await claudeAgents('{"error":"x"}')).toBeNull();
});
