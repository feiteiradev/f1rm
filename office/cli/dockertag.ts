// `f1rm docker-tag <task>`: what a hire passes to Docker so the task's containers, networks and volumes are tagged and torn down with it.
import { dirname } from "node:path";
import { repoId, stackName, tagLabels } from "../docker.ts";
import { SLUG } from "./hire.ts";

export function dockerTagIn(args: string[], m: { gitCommonDir: (cwd: string) => string | null }, cwd: string): { out: string; err: string; code: number } {
  if (args.length !== 1) return { out: "", err: "usage: f1rm docker-tag <task>", code: 1 };
  const [task] = args as [string];
  if (!SLUG.test(task)) return { out: "", err: `docker-tag: "${task}" is not a task name (lowercase letters, digits and single dashes)`, code: 1 };
  const common = m.gitCommonDir(cwd);
  if (!common) return { out: "", err: "not in a git repo", code: 1 };
  const repo = repoId(dirname(common));
  return { out: `COMPOSE_PROJECT_NAME=${stackName(repo, task)}\n${tagLabels(repo, task).map((l) => `--label ${l}`).join(" ")}\n`, err: "", code: 0 };
}
