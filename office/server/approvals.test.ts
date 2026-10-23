// The approvals broker and the allow rule "Always for this project" writes.
import { expect, test } from "bun:test";
import { alwaysRules, createBroker, type PermissionUpdate } from "./approvals.ts";

const update = (...rules: { toolName: string; ruleContent?: string }[]): PermissionUpdate[] => [{ type: "addRules", rules, behavior: "allow", destination: "localSettings" }];
/** What Claude Code offers in `permission_suggestions` for an allow rule: the destination it would save to in the terminal is its own choice. */
const offered = (ruleContent: string | undefined, toolName = "Bash", destination = "localSettings") => ({ type: "addRules", rules: [{ toolName, ...(ruleContent !== undefined && { ruleContent }) }], behavior: "allow", destination });

test("Always is exactly the allow rules Claude Code suggested for the request, moved to the repo's local settings", () => {
  expect(alwaysRules([offered("rm -rf node_modules")])).toEqual(update({ toolName: "Bash", ruleContent: "rm -rf node_modules" }));
  expect(alwaysRules([offered("npm run proofa", "Bash", "session")])).toEqual(update({ toolName: "Bash", ruleContent: "npm run proofa" }));
  expect(alwaysRules([offered("/code/shop/src/**", "Edit", "projectSettings")])).toEqual(update({ toolName: "Edit", ruleContent: "/code/shop/src/**" }));
  // several suggestions, several rules: all of them, in order
  expect(alwaysRules([offered("git status"), offered("git diff", "Bash", "session")])).toEqual([...update({ toolName: "Bash", ruleContent: "git status" }), ...update({ toolName: "Bash", ruleContent: "git diff" })]);
});

test("the office makes no rule of its own: no suggestion, no Always", () => {
  expect(alwaysRules(undefined)).toEqual([]);
  expect(alwaysRules("nope")).toEqual([]);
  expect(alwaysRules([])).toEqual([]);
});

test("only allow rules count: deny and ask rules, modes, directories and junk are left out", () => {
  const suggestions = [
    { ...offered("rm -rf build"), behavior: "deny" },
    { ...offered("rm -rf build"), behavior: "ask" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
    { type: "addDirectories", directories: ["/etc"], destination: "session" },
    { type: "replaceRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "session" },
    "junk", null, 7,
    { type: "addRules", behavior: "allow", destination: "session" },
    { type: "addRules", rules: "Bash", behavior: "allow", destination: "session" },
  ];
  expect(alwaysRules(suggestions)).toEqual([]);
  expect(alwaysRules([...suggestions, offered("ls -la")])).toEqual(update({ toolName: "Bash", ruleContent: "ls -la" }));
});

test("a rule for a whole tool is dropped, and so is a suggestion that has no other rule", () => {
  expect(alwaysRules([offered(undefined)])).toEqual([]);
  expect(alwaysRules([offered("")])).toEqual([]);
  expect(alwaysRules([{ type: "addRules", rules: [{ toolName: "Bash" }, { toolName: "Bash", ruleContent: "git status" }, { ruleContent: "x" }, { toolName: 5, ruleContent: "x" }], behavior: "allow", destination: "session" }])).toEqual(update({ toolName: "Bash", ruleContent: "git status" }));
});

const hold = (broker: ReturnType<typeof createBroker>, always = alwaysRules([offered("git status")]), why = () => "checking the tree") =>
  broker.hold("s1", "Bash", { command: "git status" }, 1, new AbortController().signal, why, always);

test("a held request lists its why, canAlways, and the text of the rule Always would grant", () => {
  const broker = createBroker(10_000, () => {});
  void hold(broker);
  void hold(broker, alwaysRules([offered("git status"), offered("git diff")]));
  void hold(broker, []);
  expect(broker.list().map((a) => [a.why, a.canAlways, a.rule])).toEqual([
    ["checking the tree", true, "Bash(git status)"],
    ["checking the tree", true, "Bash(git status), Bash(git diff)"],
    ["checking the tree", false, ""],
  ]);
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
  expect(await always).toEqual({ behavior: "allow", updatedPermissions: update({ toolName: "Bash", ruleContent: "git status" }) });
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
