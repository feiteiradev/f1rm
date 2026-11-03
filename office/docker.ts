// Docker tagging: every container, network and volume a task starts carries its repo and task, so it can be torn down by tag.
// Only tagged resources are ever removed (never images, never a prune). Pure: the docker runner is injected, no server/client imports.

export type Docker = (args: string[]) => Promise<{ code: number; out: string }>;

/** The real docker. Missing binary or a down daemon gives code 127/nonzero, never a throw. */
export const realDocker: Docker = async (args) => {
  try {
    const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code, out: code === 0 ? out : out || err };
  } catch {
    return { code: 127, out: "" };
  }
};

export const stackName = (repo: string, task: string) => `f1rm-${repo}-${task}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
export const tagLabels = (repo: string, task: string) => [`f1rm.repo=${repo}`, `f1rm.task=${task}`];
/** What a hire exports so everything it starts is tagged. */
export const tagEnv = (repo: string, task: string) => ({
  COMPOSE_PROJECT_NAME: stackName(repo, task),
  F1RM_DOCKER_LABELS: tagLabels(repo, task).join(","),
});

type Removed = { containers: string[]; networks: string[]; volumes: string[]; errors: string[] };
type Row = { id: string; name: string; state: string; image: string; project: string; task: string };
type Kind = "containers" | "networks" | "volumes";

const L = (k: string) => `{{.Label "${k}"}}`;
const TAIL = [L("com.docker.compose.project"), L("f1rm.task")];
// One tab-separated row per resource: id, name, state, image, compose project, f1rm.task label.
const FORMAT: Record<Kind, string> = {
  containers: ["{{.ID}}", "{{.Names}}", "{{.State}}", "{{.Image}}", ...TAIL].join("\t"),
  networks: ["{{.ID}}", "{{.Name}}", "", "", ...TAIL].join("\t"),
  volumes: ["{{.Name}}", "{{.Name}}", "", "", ...TAIL].join("\t"),
};
const LIST: Record<Kind, string[]> = { containers: ["ps", "-a"], networks: ["network", "ls"], volumes: ["volume", "ls"] };

async function list(d: Docker, kind: Kind, labels: string[], errors: string[]): Promise<Row[]> {
  const filters = labels.flatMap((l) => ["--filter", `label=${l}`]);
  const r = await run(d, [...LIST[kind], ...filters, "--format", FORMAT[kind]]);
  if (r.code !== 0) { errors.push(`${kind}: ${r.out.trim() || `docker exited ${r.code}`}`); return []; }
  return r.out.split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", state = "", image = "", project = "", task = ""] = line.split("\t");
    return { id, name, state, image, project, task };
  });
}

async function run(d: Docker, args: string[]) {
  try { return await d(args); } catch (e) { return { code: 1, out: String(e) }; }
}

/** Remove containers (with their anonymous volumes), then networks, then volumes. Returns what docker confirmed. */
async function remove(d: Docker, found: Record<Kind, string[]>): Promise<Removed> {
  const out: Removed = { containers: [], networks: [], volumes: [], errors: [] };
  const steps: [Kind, string[]][] = [["containers", ["rm", "-f", "-v"]], ["networks", ["network", "rm"]], ["volumes", ["volume", "rm"]]];
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

/** Tear down one task's stack: everything labelled with its repo AND task, or belonging to its compose project. */
export async function teardown(d: Docker, repo: string, task: string): Promise<Removed> {
  const errors: string[] = [];
  const found = { containers: [], networks: [], volumes: [] } as Record<Kind, string[]>;
  for (const kind of KINDS) {
    const tagged = await list(d, kind, tagLabels(repo, task), errors);
    const project = await list(d, kind, [`com.docker.compose.project=${stackName(repo, task)}`], errors);
    found[kind] = [...tagged, ...project].map((r) => r.id);
  }
  const r = await remove(d, found);
  r.errors.unshift(...errors);
  return r;
}

/** Remove every resource of this repo whose task is not live any more. Other repos' resources are never listed. */
export async function sweep(d: Docker, repo: string, liveTasks: Set<string>): Promise<Removed> {
  const errors: string[] = [];
  const found = { containers: [], networks: [], volumes: [] } as Record<Kind, string[]>;
  for (const kind of KINDS) {
    const rows = await list(d, kind, [`f1rm.repo=${repo}`], errors);
    found[kind] = rows.filter((r) => r.task && !liveTasks.has(r.task)).map((r) => r.id);
  }
  const r = await remove(d, found);
  r.errors.unshift(...errors);
  return r;
}

/** Old untagged per-task containers (names like *-e2e-* and review-*), for the user to approve once. */
export async function leftovers(d: Docker) {
  const rows = await list(d, "containers", [], []);
  const items = rows
    .filter((r) => !r.task && (/-e2e-/.test(r.name) || /^review-/.test(r.name)))
    .map(({ id, name, state, image, project }) => ({ id, name, state, image, project }));
  return { items, count: items.length };
}

/** Remove the chosen leftovers, but only those still in a fresh list (an id that became tagged or vanished is skipped). */
export async function removeLeftovers(d: Docker, wanted: string[]) {
  const fresh = new Set((await leftovers(d)).items.map((i) => i.id));
  const ids = wanted.filter((id) => fresh.has(id));
  const out = { removed: [] as string[], errors: [] as string[] };
  for (const id of ids) {
    const r = await run(d, ["rm", "-f", "-v", id]);
    if (r.code === 0) out.removed.push(id);
    else out.errors.push(`${id}: ${r.out.trim() || `docker exited ${r.code}`}`);
  }
  return out;
}
