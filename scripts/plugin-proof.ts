#!/usr/bin/env bun
// Live proofs for the plugin against the real `claude` (Haiku, a few cents):
//   bun scripts/plugin-proof.ts designer   the Designer gets the design skills through the slash command
//   bun scripts/plugin-proof.ts pm         `f1rm pm` opens with an interview question
// Sessions run with the real login, so they leave ordinary transcripts under ~/.claude/projects.
import { join } from "node:path";
import { claudeEnv } from "../office/server/machine.ts";

const REPO = join(import.meta.dir, "..");
const PLUGIN = join(REPO, "plugin");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

/** One headless Designer session with the given first prompt; returns the Skill calls it made and its tools. */
async function designer(prompt: string) {
  const p = Bun.spawn(
    ["claude", "-p", "--plugin-dir", PLUGIN, "--agent", "f1rm:designer", "--model", "haiku", "--output-format", "stream-json", "--verbose", prompt],
    { cwd: REPO, env: claudeEnv(), stdout: "pipe", stderr: "pipe", timeout: 240_000 },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  const events = out.trim().split("\n").map((l) => JSON.parse(l));
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const skills = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((c: any) => c.type === "tool_use" && c.name === "Skill")
    .map((c: any) => c.input.skill as string);
  const text = events.findLast((e) => e.type === "result")?.result as string;
  return { init, skills, text };
}

async function proveDesigner() {
  const ask = "Do only step 1 of Steps: load the two skills it names. Make no design. Then reply DONE.";
  const expected = ["impeccable:impeccable", "design-taste-frontend"];

  const withSlash = await designer(`/design-pipeline ${ask}`);
  const tools = [...withSlash.init.tools].sort().join(",");
  // These are the Designer's tools from its file, so the session really runs as f1rm:designer.
  if (tools !== "Bash,Edit,Read,SendMessage,Skill,Task,WebFetch,WebSearch,Write") fail(`session is not the designer, tools: ${tools}`);
  for (const s of expected) if (!withSlash.skills.includes(s)) fail(`with /design-pipeline the designer never loaded ${s}: ${withSlash.skills}`);
  console.log(`ok   with the slash command the designer loaded ${expected.join(" and ")}`);

  // The same question with and without the slash command. The marker only exists in design-pipeline's text.
  const quote = "Without calling any tool: quote the first sentence after the `# Design pipeline` heading of the design-pipeline skill text if it is already in your context, else say NOT LOADED.";
  const marker = "Three parts, one job each";
  const control = await designer(quote);
  if (control.text.includes(marker) || !control.text.includes("NOT LOADED")) fail(`without the slash command the skill text was in context: ${control.text}`);
  console.log("ok   without the slash command the skill text is not in context (role frontmatter alone loads nothing)");
  const slash = await designer(`/design-pipeline ${quote}`);
  if (!slash.text.includes(marker)) fail(`with the slash command the skill text did not arrive: ${slash.text}`);
  console.log(`ok   with the slash command the designer quotes the skill: ${slash.text.slice(0, 120).replace(/\s+/g, " ")}`);
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
const strip = (s: string) => plain(s).replace(/\s+/g, "");

async function provePm() {
  let raw = "";
  const dec = new TextDecoder();
  const proc = Bun.spawn(["bun", join(REPO, "office/cli/f1rm.ts"), "pm", "--plugin-dir", PLUGIN, "--model", "haiku"], {
    cwd: REPO,
    env: { ...claudeEnv(), TERM: "xterm-256color" },
    terminal: { cols: 160, rows: 50, data: (_t, d) => void (raw += typeof d === "string" ? d : dec.decode(d)) },
  });
  const deadline = Date.now() + 180_000;
  let seen = "";
  while (Date.now() < deadline) {
    await sleep(500);
    seen = strip(raw);
    // The grilling format numbers its questions "Q1 ...". The prompt we send never contains that.
    if (/❓\**Q1/.test(seen)) break;
    if (/Doyouwantto(proceed|make|create)/.test(seen.slice(-1500))) break; // a proof must not run real work
  }
  const asked = /❓\**Q1/.test(seen);
  proc.terminal?.write("/exit\r");
  await Promise.race([proc.exited, sleep(3000)]);
  proc.kill();
  if (!asked) fail(`the PM did not open with an interview question (or asked to act first). Screen tail: ${seen.slice(-800)}`);
  const shown = plain(raw).replace(/\s+/g, " ");
  console.log(`ok   the PM started by f1rm pm opened with: ${shown.slice(shown.search(/❓/), shown.search(/❓/) + 300)}`);
}

const proofs: Record<string, () => Promise<void>> = { designer: proveDesigner, pm: provePm };
const which = process.argv[2] ?? "";
if (!proofs[which]) fail("usage: bun scripts/plugin-proof.ts designer | pm");
await proofs[which]();
