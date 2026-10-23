// The approvals broker and the allow rule "Always for this project" writes.
import { expect, test } from "bun:test";
import { alwaysRules, createBroker, type PermissionUpdate } from "./approvals.ts";

const rule = (ruleContent?: string, toolName = "Bash"): PermissionUpdate[] => [{ type: "addRules", rules: [{ toolName, ...(ruleContent && { ruleContent }) }], behavior: "allow", destination: "localSettings" }];
const bash = (command: string, suggestions?: unknown) => alwaysRules("Bash", { command }, suggestions);

test("a Bash command with a subcommand gets an allow rule for its two-word prefix, written to the repo's local settings", () => {
  expect(bash("git status")).toEqual(rule("git status *"));
  expect(bash("npm run test -- --watch")).toEqual(rule("npm run *"));
});

test("a Bash command with no subcommand gets a rule for exactly that command", () => {
  expect(bash("pwd")).toEqual(rule("pwd"));
  expect(bash("ls -la")).toEqual(rule("ls -la"));
  expect(bash("rm -rf build")).toEqual(rule("rm -rf build"));
  expect(bash("curl http://localhost:4170/x")).toEqual(rule("curl http://localhost:4170/x"));
});

test("a Bash line that chains, pipes, substitutes or redirects gets no rule of its own", () => {
  for (const command of ["ls && rm -rf build", "ls; pwd", "cat a | sh", "echo $(whoami)", "echo `id`", "ls > out", "ls\npwd", "FOO=1 make"]) expect([command, bash(command)]).toEqual([command, []]);
});

test("a tool with no rule of its own is allowed only as Claude Code itself suggests, moved to the repo's local settings", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" },
    { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "deny", destination: "session" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
    "junk",
  ];
  expect(alwaysRules("Edit", { file_path: "/x" }, suggestions)).toEqual(rule(undefined, "Edit"));
  expect(alwaysRules("Edit", { file_path: "/x" }, undefined)).toEqual([]);
  expect(alwaysRules("Edit", { file_path: "/x" }, "nope")).toEqual([]);
  expect(bash("ls && pwd", suggestions.slice(0, 1))).toEqual(rule(undefined, "Edit")); // a chained line falls back to what Claude Code suggests
});

test("a Bash prefix rule wins over Claude Code's own suggestion", () => {
  expect(bash("git status", [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status" }], behavior: "allow", destination: "session" }])).toEqual(rule("git status *"));
});

const hold = (broker: ReturnType<typeof createBroker>, always = alwaysRules("Bash", { command: "git status" }, undefined), why = "checking the tree") =>
  broker.hold("s1", "Bash", { command: "git status" }, 1, new AbortController().signal, why, always);

test("a held request lists its why, and canAlways says whether Always can be offered", () => {
  const broker = createBroker(10_000, () => {});
  void hold(broker);
  void hold(broker, []);
  expect(broker.list().map((a) => [a.why, a.canAlways])).toEqual([["checking the tree", true], ["checking the tree", false]]);
  broker.releaseAll();
});

test("a why that is not written yet, or is still the words before, is read again while the request waits, and the change is pushed", async () => {
  for (const before of ["", "Words before the request."]) {
    const changes: number[] = [];
    const broker = createBroker(10_000, () => changes.push(changes.length));
    let said = before;
    const held = broker.hold("s1", "Bash", {}, 1, new AbortController().signal, () => said, []);
    expect(broker.list()[0].why).toBe(before);
    said = "The transcript caught up.";
    await Bun.sleep(400);
    expect(broker.list()[0].why).toBe("The transcript caught up.");
    expect(changes.length).toBe(2); // the hold, then the new why
    broker.releaseAll();
    expect(await held).toBeNull();
  }
});

test("approve, deny and always give three different decisions", async () => {
  const broker = createBroker(10_000, () => {});
  const approve = hold(broker);
  const deny = hold(broker);
  const always = hold(broker);
  const [a, d, w] = broker.list().map((x) => x.id);
  expect(broker.answer(a, { behavior: "allow" })).toBe(true);
  expect(broker.answer(d, { behavior: "deny", message: "no" })).toBe(true);
  expect(broker.always(w)).toBe(true);
  expect(await approve).toEqual({ behavior: "allow" });
  expect(await deny).toEqual({ behavior: "deny", message: "no" });
  expect(await always).toEqual({ behavior: "allow", updatedPermissions: rule("git status *") });
  expect(broker.always(w)).toBe(false); // answered once
});

test("always on a request that has no rule answers nothing and leaves it held", async () => {
  const broker = createBroker(10_000, () => {});
  const held = hold(broker, []);
  expect(broker.always(broker.list()[0].id)).toBe(false);
  expect(broker.list()).toHaveLength(1);
  broker.releaseAll();
  expect(await held).toBeNull();
});
