// `f1rm docker-tag <task>`: the two lines a hire uses so everything it starts in Docker carries its repo and task.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { repoId, stackName } from "../docker.ts";
import { dockerTagIn } from "./dockertag.ts";

const m = { gitCommonDir: (cwd: string) => (cwd.startsWith("/code/shop") ? "/code/shop/.git" : cwd.startsWith("/other/shop") ? "/other/shop/.git" : null) };

test("docker-tag prints COMPOSE_PROJECT_NAME and the two --label flags for the repo it runs in, by its repoId", () => {
  const r = dockerTagIn(["fix-login"], m, "/code/shop/.claude/worktrees/fix-login");
  const id = repoId("/code/shop");
  expect(r.code).toBe(0);
  expect(id).toMatch(/^shop-[0-9a-f]{6}$/);
  expect(r.out).toBe(`COMPOSE_PROJECT_NAME=${stackName(id, "fix-login")}\n--label f1rm.repo=${id} --label f1rm.task=fix-login\n`);
});

test("two repos with the same folder name get different tags", () => {
  const a = dockerTagIn(["t"], m, "/code/shop").out;
  const b = dockerTagIn(["t"], m, "/other/shop").out;
  expect(a).not.toBe(b);
});

test("docker-tag needs exactly one task and a git repo", () => {
  expect(dockerTagIn([], m, "/code/shop").code).toBe(1);
  expect(dockerTagIn(["a", "b"], m, "/code/shop").code).toBe(1);
  expect(dockerTagIn(["a"], m, join("/nowhere")).err).toContain("not in a git repo");
});

test("docker-tag refuses a task that is not a slug: empty, spaces, ;, slashes, capitals", () => {
  for (const bad of ["", "a b", "a;b", "a/b", "Fix", "$(x)", "-a"]) {
    const r = dockerTagIn([bad], m, "/code/shop");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  }
});
