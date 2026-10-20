// Records the demo fixture: runs the real `f1rm serve` against a temporary HOME and throwaway git repos,
// posts the scripted session to it, then scrubs the server's own event log into office/demo/fixture.json.
//   bun scripts/record-demo.ts
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { F1rmEvent } from "../office/server/office.ts";
import { KEEP, ROOMS, SCENARIO, WHO } from "../office/demo/scenario.ts";
import { scrub } from "../office/demo/scrub.ts";

const CLI = join(import.meta.dir, "../office/cli/f1rm.ts");
const FIXTURE = join(import.meta.dir, "../office/demo/fixture.json");

const base = realpathSync(mkdtempSync(join(tmpdir(), "f1rm-demo-")));
const home = join(base, "home");
mkdirSync(join(home, ".claude"), { recursive: true });

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
const repos = Object.fromEntries(ROOMS.map((room) => {
  const dir = join(base, "repos", room);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return [room, dir];
}));
const sessions = Object.fromEntries(Object.entries(WHO).map(([key, who]) => {
  let cwd = repos[who.room];
  if (who.worktree) {
    cwd = join(repos[who.room], ".claude", "worktrees", who.worktree);
    git(repos[who.room], "worktree", "add", "-q", cwd, "-b", who.worktree);
  }
  return [key, { id: crypto.randomUUID(), cwd, ...who }];
}));

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);

const env = { ...process.env, TMPDIR: "", HOME: home, F1RM_PORT: String(port) };
const install = Bun.spawnSync(["bun", CLI, "install"], { env });
if (!install.success) throw new Error(`install failed: ${install.stderr}`);
const server = Bun.spawn(["bun", CLI, "serve"], { env, stdout: "pipe", stderr: "inherit" });
await server.stdout.getReader().read(); // the office URL line: the server is up

try {
  const secret = readFileSync(join(home, ".f1rm", "ingest-headers"), "utf8").split(": ")[1].trim();
  for (const step of SCENARIO) {
    const s = sessions[step.session];
    const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-f1rm-secret": secret,
        "x-f1rm-iterm-session": `w0t${s.id.slice(0, 1)}p0:${s.id.toUpperCase()}`,
        "x-f1rm-term-program": "iTerm.app",
      },
      body: JSON.stringify({
        session_id: s.id,
        cwd: s.cwd,
        transcript_path: join(home, ".claude", "projects", "x", `${s.id}.jsonl`),
        permission_mode: "default",
        ...(s.agent && { agent_type: s.agent }),
        ...(s.title && { session_title: s.title }),
        ...step.payload,
      }),
    });
    if (!res.ok) throw new Error(`ingest ${step.payload.hook_event_name}: ${res.status}`);
  }

  const db = new Database(join(home, ".f1rm", "events.db"), { readonly: true });
  const rows = db.query("SELECT event FROM events ORDER BY id").all() as { event: string }[];
  if (rows.length !== SCENARIO.length) throw new Error(`${SCENARIO.length} steps posted, ${rows.length} events logged`);
  // The log carries the arrival time of each post; the script's own times are what the recording means.
  const raw = rows.map((r, i): F1rmEvent => ({ ...JSON.parse(r.event), at: SCENARIO[i].t * 1000 }));
  const fixture = scrub(raw, { keep: KEEP });
  writeFileSync(FIXTURE, `[\n${fixture.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`);
  console.log(`wrote ${fixture.length} events to ${FIXTURE}`);
} finally {
  server.kill();
  rmSync(base, { recursive: true, force: true });
}
