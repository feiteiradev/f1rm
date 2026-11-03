// Docker tagging: every container, network and volume a task starts carries its repo and task, so it can be torn down by tag.
// The real tag is COMPOSE_PROJECT_NAME (tagEnv): compose puts the com.docker.compose.project label on everything it creates.
// For plain `docker run`, pass tagLabels(repo, task) as `--label` flags (f1rm.repo=..., f1rm.task=...).
// teardown and sweep match BOTH the f1rm labels and the project label.
// Only tagged resources are ever removed (never images, never a prune). Pure: the docker runner is injected, no server/client imports.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

export type Docker = (args: string[]) => Promise<{ code: number; out: string }>;

/** The real docker. Missing binary or a down daemon gives code 127/nonzero, never a throw. */
export const dockerWith = (cmd: string[], timeoutMs = 10_000): Docker => async (args) => {
  try {
    const p = Bun.spawn([...cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    // A wedged daemon must not hang the office: after the timeout the process is killed and the answer is code 124.
    let late = false;
    const timer = setTimeout(() => ((late = true), p.kill("SIGKILL")), timeoutMs);
    try {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      return late ? { code: 124, out: "" } : { code, out: code === 0 ? out : out || err };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: 127, out: "" };
  }
};
export const realDocker: Docker = dockerWith(["docker"]);

/** The repo name every tag, teardown and sweep uses: its folder name plus 6 hex of the real path's hash, so two repos both called `app` never share resources. */
export function repoId(repoPath: string): string {
  let real = repoPath;
  try { real = realpathSync(repoPath); } catch { /* a folder that is gone keeps its given path */ }
  return `${basename(repoPath)}-${createHash("sha256").update(real).digest("hex").slice(0, 6)}`;
}

const san = (x: string) => x.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
const hash = (repo: string, task: string) => createHash("sha256").update(`${repo}\0${task}`).digest("hex").slice(0, 8);
/** Injective: the hash of the raw inputs keeps ("a","b-c") and ("a-b","c"), or "Fix Login!" and "fix login?", apart. */
export const stackName = (repo: string, task: string) => `f1rm-${san(repo)}-${san(task)}-${hash(repo, task)}`;
/** True when a compose project name is some task's stack of this repo (its hash matches the task text between prefix and hash). */
const ownsProject = (repo: string, project: string) => {
  const prefix = `f1rm-${san(repo)}-`;
  const m = project.startsWith(prefix) && project.slice(prefix.length).match(/^(.+)-([0-9a-f]{8})$/);
  return !!m && hash(repo, m[1]!) === m[2];
};

export const tagLabels = (repo: string, task: string) => [`f1rm.repo=${repo}`, `f1rm.task=${task}`];
/** What a hire exports so everything compose starts is tagged. */
export const tagEnv = (repo: string, task: string) => ({ COMPOSE_PROJECT_NAME: stackName(repo, task) });

type Removed = { containers: string[]; networks: string[]; volumes: string[]; errors: string[] };
type Row = { id: string; name: string; state: string; image: string; project: string; task: string; repo: string };
type Kind = "containers" | "networks" | "volumes";

const L = (k: string) => `{{.Label "${k}"}}`;
const TAIL = [L("com.docker.compose.project"), L("f1rm.task"), L("f1rm.repo")];
// One tab-separated row per resource: id, name, state, image, compose project, f1rm.task label, f1rm.repo label.
const FORMAT: Record<Kind, string> = {
  containers: ["{{.ID}}", "{{.Names}}", "{{.State}}", "{{.Image}}", ...TAIL].join("\t"),
  networks: ["{{.ID}}", "{{.Name}}", "", "", ...TAIL].join("\t"),
  volumes: ["{{.Name}}", "{{.Name}}", "", "", ...TAIL].join("\t"),
};
const LIST: Record<Kind, string[]> = { containers: ["ps", "-a"], networks: ["network", "ls"], volumes: ["volume", "ls"] };

async function run(d: Docker, args: string[]) {
  try { return await d(args); } catch (e) { return { code: 1, out: String(e) }; }
}

async function list(d: Docker, kind: Kind, labels: string[], errors: string[]): Promise<Row[]> {
  const filters = labels.flatMap((l) => ["--filter", `label=${l}`]);
  const r = await run(d, [...LIST[kind], ...filters, "--format", FORMAT[kind]]);
  if (r.code !== 0) { errors.push(`${kind}: ${r.out.trim() || `docker exited ${r.code}`}`); return []; }
  return r.out.split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", state = "", image = "", project = "", task = "", repo = ""] = line.split("\t");
    return { id, name, state, image, project, task, repo };
  });
}

/** Remove containers (with their anonymous volumes), then networks, then volumes. Returns what docker confirmed. */
async function remove(d: Docker, found: Record<Kind, string[]>): Promise<Removed> {
  const out: Removed = { containers: [], networks: [], volumes: [], errors: [] };
  const steps: [Kind, string[]][] = [["containers", ["rm", "-f", "-v", "--"]], ["networks", ["network", "rm", "--"]], ["volumes", ["volume", "rm", "--"]]];
  for (const [kind, cmd] of steps) {
    const ids = [...new Set(found[kind])];
    if (!ids.length) continue;
    const r = await run(d, [...cmd, ...ids]);
    if (r.code === 0) out[kind] = ids;
    else out.errors.push(`${kind}: ${r.out.trim() || `docker exited ${r.code}`}`);
  }
  return out;
}

const KINDS: Kind[] = ["containers", "networks", "volumes"];
const need = (repo: string, task = "x") => { if (!repo || !task) throw new Error("docker: repo and task must not be empty"); };

/** Tear down one task's stack: everything labelled with its repo AND task, or in its exact compose project (unless a label says it is another's). */
export async function teardown(d: Docker, repo: string, task: string): Promise<Removed> {
  need(repo, task);
  const errors: string[] = [];
  const found = { containers: [], networks: [], volumes: [] } as Record<Kind, string[]>;
  for (const kind of KINDS) {
    const tagged = await list(d, kind, tagLabels(repo, task), errors);
    const project = (await list(d, kind, [`com.docker.compose.project=${stackName(repo, task)}`], errors))
      .filter((r) => (!r.repo || r.repo === repo) && (!r.task || r.task === task));
    found[kind] = [...tagged, ...project].map((r) => r.id);
  }
  const r = await remove(d, found);
  r.errors.unshift(...errors);
  return r;
}

/** Remove this repo's resources whose task is not live any more, by f1rm label or by this repo's compose project name. */
export async function sweep(d: Docker, repo: string, liveTasks: Set<string>): Promise<Removed> {
  need(repo);
  const errors: string[] = [];
  const liveStacks = new Set([...liveTasks].map((t) => stackName(repo, t)));
  const found = { containers: [], networks: [], volumes: [] } as Record<Kind, string[]>;
  for (const kind of KINDS) {
    const byLabel = (await list(d, kind, [`f1rm.repo=${repo}`], errors)).filter((r) => r.task && !liveTasks.has(r.task));
    const byProject = (await list(d, kind, ["com.docker.compose.project"], errors))
      .filter((r) => !r.repo && !r.task && ownsProject(repo, r.project) && !liveStacks.has(r.project));
    found[kind] = [...byLabel, ...byProject].map((r) => r.id);
  }
  const r = await remove(d, found);
  r.errors.unshift(...errors);
  return r;
}

/** Old untagged per-task containers (names like *-e2e-* and review-*), for the user to approve once. Never an f1rm one. */
export async function leftovers(d: Docker) {
  const errors: string[] = [];
  const rows = await list(d, "containers", [], errors);
  const items = rows
    .filter((r) => !r.task && !r.repo && !r.project.startsWith("f1rm-") && (/-e2e-/.test(r.name) || /^review-/.test(r.name)))
    .map(({ id, name, state, image, project }) => ({ id, name, state, image, project }));
  return { items, count: items.length, errors };
}

/** Remove the chosen leftovers, but only those still in a fresh list (an id that became tagged or vanished is skipped). */
export async function removeLeftovers(d: Docker, wanted: string[]) {
  const now = await leftovers(d);
  const fresh = new Set(now.items.map((i) => i.id));
  const ids = wanted.filter((id) => fresh.has(id));
  const out = { removed: [] as string[], errors: [...now.errors] };
  for (const id of ids) {
    const r = await run(d, ["rm", "-f", "-v", "--", id]);
    if (r.code === 0) out.removed.push(id);
    else out.errors.push(`${id}: ${r.out.trim() || `docker exited ${r.code}`}`);
  }
  return out;
}
