// The scripted session the demo recording is made from: hook payloads posted to a real f1rm server.
// Times are seconds on the recording's own clock; replay plays them faster (see replay.ts).
// Prompts, commands, paths and secrets here are bait on purpose, so the scrub step is exercised by real server output.

export type Step = { t: number; session: string; payload: Record<string, unknown> };

type Who = { agent?: string; title?: string; room: string; worktree?: string };
const WHO: Record<string, Who> = {
  pm1: { agent: "f1rm:pm", title: "pixel-pet board", room: "pixel-pet" },
  maya: { agent: "f1rm:designer", title: "sprite sheet", room: "pixel-pet", worktree: "sprite-sheet" },
  felix: { agent: "f1rm:frontend-dev", title: "hud", room: "pixel-pet", worktree: "hud" },
  ines: { agent: "f1rm:reviewer", room: "pixel-pet" },
  pm2: { agent: "f1rm:pm", title: "atlas board", room: "atlas-api" },
  bruno: { agent: "f1rm:backend-dev", room: "atlas-api", worktree: "orders-endpoint" },
  kofi: { agent: "f1rm:researcher", room: "atlas-api" },
  free1: { title: "rotate prod db password for Acme", room: "atlas-api" },
  maya2: { agent: "f1rm:designer", title: "palette", room: "garden-site" },
  free2: { title: "quit job letter draft", room: "garden-site" },
  free3: { room: "notes-cli" },
  free4: { room: "notes-cli" },
  // A Founder project: its PM, and a launch team mixing go-to-market roles.
  pm3: { agent: "f1rm:pm", title: "lemonade board", room: "lemonade" },
  lead: { agent: "f1rm:lead", title: "lead-launch", room: "lemonade" },
  mkt: { agent: "f1rm:marketer", title: "launch.marketer-brand", room: "lemonade", worktree: "brand" },
  seo: { agent: "f1rm:seo-specialist", title: "launch.seo-specialist-audit", room: "lemonade", worktree: "audit" },
};
export const ROOMS = ["pixel-pet", "atlas-api", "garden-site", "notes-cli", "lemonade"];
/** The public names the scrub step may keep. */
export const KEEP = [...ROOMS, "pixel-pet board", "atlas board", "sprite sheet", "hud", "palette", "lemonade board", "lead-launch", "launch.marketer-brand", "launch.seo-specialist-audit"];
/** Strings planted in the payloads above that must not reach the published fixture. */
export const MARKERS = ["sk-ant", "Bearer", "/Users", "/private", "/var/", ".ssh", "layoffs", "Acme", "password", "salary", "resignation", "w0t", "jsonl", "hunter2", "4242", "lemonade.example"];

const steps: Step[] = [];
const at = (t: number, session: string, hook_event_name: string, extra: Record<string, unknown> = {}) =>
  steps.push({ t, session, payload: { hook_event_name, ...extra } });
const tool = (t: number, session: string, tool_name: string, tool_input: Record<string, unknown>) =>
  at(t, session, "PreToolUse", { tool_name, tool_input });
const prompt = (t: number, session: string, text: string) => at(t, session, "UserPromptSubmit", { prompt: text });
const ask = (t: number, session: string, tool_name: string, tool_input: Record<string, unknown>) =>
  at(t, session, "PermissionRequest", { tool_name, tool_input });
const spawn = (t: number, session: string, id: string, agent_type: string) => at(t, session, "SubagentStart", { agent_id: id, agent_type });
const done = (t: number, session: string, id: string, agent_type: string) => at(t, session, "SubagentStop", { agent_id: id, agent_type });

at(0, "pm1", "SessionStart");
prompt(4, "pm1", "I want a pet feeding mini-game. My mom's birthday is the 14th, ship before then. Token is hunter2");
tool(8, "pm1", "Read", { file_path: "BOARD.md" });
tool(14, "pm1", "Grep", { pattern: "TODO|FIXME" });
spawn(20, "pm1", "agent-1", "Explore");
done(44, "pm1", "agent-1", "Explore");
tool(50, "pm1", "Edit", { file_path: "BOARD.md" });
at(58, "pm1", "Stop");
prompt(200, "pm1", "Looks good, start on the HUD");
tool(205, "pm1", "Read", { file_path: "BOARD.md" });
tool(212, "pm1", "Edit", { file_path: "BOARD.md" });
at(220, "pm1", "Stop");

at(6, "pm2", "SessionStart");
prompt(12, "pm2", "Add an orders endpoint to atlas");
tool(18, "pm2", "Read", { file_path: "BOARD.md" });
tool(26, "pm2", "Edit", { file_path: "BOARD.md" });
at(34, "pm2", "Stop");
prompt(250, "pm2", "How is Bruno doing?");
tool(256, "pm2", "Read", { file_path: "BOARD.md" });
at(262, "pm2", "Stop");

at(10, "maya2", "SessionStart");
prompt(16, "maya2", "Warmer greens for the garden site");
tool(24, "maya2", "Read", { file_path: "tokens.css" });
tool(36, "maya2", "Edit", { file_path: "tokens.css" });
tool(52, "maya2", "Edit", { file_path: "hero.css" });
at(70, "maya2", "Stop");
prompt(300, "maya2", "Check the dark mode too");
tool(306, "maya2", "Edit", { file_path: "tokens.css" });
at(320, "maya2", "Stop");

at(14, "free3", "SessionStart");
prompt(20, "free3", "why does cargo build fail on my work laptop /Users/pedro/code/acme-secret");
tool(28, "free3", "Bash", { command: "cargo build" });
tool(40, "free3", "Edit", { file_path: "main.rs" });
tool(52, "free3", "Bash", { command: "cargo test" });
at(64, "free3", "Stop");
at(340, "free3", "SessionEnd");

at(20, "free2", "SessionStart");
prompt(24, "free2", "draft my resignation letter");
tool(30, "free2", "Read", { file_path: "index.html" });
tool(38, "free2", "Edit", { file_path: "index.html" });
at(46, "free2", "Stop");

at(30, "maya", "SessionStart");
prompt(34, "maya", "Draw the pet sprite sheet");
tool(40, "maya", "Read", { file_path: "moodboard.md" });
tool(48, "maya", "WebFetch", { url: "https://internal.acme.test/brand", prompt: "colors" });
tool(56, "maya", "Edit", { file_path: "pet.css" });
tool(64, "maya", "Edit", { file_path: "sprites.css" });
ask(72, "maya", "Bash", { command: "npx imagemin sprites/*.png" });
tool(110, "maya", "Bash", { command: "npx imagemin sprites/*.png" });
tool(126, "maya", "Edit", { file_path: "sprites.css" });
at(140, "maya", "Stop");

at(40, "bruno", "SessionStart");
prompt(44, "bruno", "Implement POST /orders");
tool(50, "bruno", "Read", { file_path: "routes.ts" });
tool(58, "bruno", "Grep", { pattern: "handler" });
tool(66, "bruno", "Edit", { file_path: "routes.ts" });
tool(74, "bruno", "Edit", { file_path: "routes.ts" });
tool(82, "bruno", "Bash", { command: "bun test" });
at(88, "bruno", "PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "bun test" } });
tool(92, "bruno", "Edit", { file_path: "schema.sql" });
tool(100, "bruno", "Bash", { command: 'curl -H "Authorization: Bearer sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123" http://localhost:3000/orders' });
at(112, "bruno", "Stop");
prompt(260, "bruno", "Add pagination");
tool(266, "bruno", "Edit", { file_path: "routes.ts" });
spawn(272, "bruno", "agent-3", "Explore");
done(296, "bruno", "agent-3", "Explore");
tool(304, "bruno", "Edit", { file_path: "routes.ts" });
at(312, "bruno", "Stop");

at(52, "kofi", "SessionStart");
prompt(56, "kofi", "Find out how competitors price order APIs; Acme layoffs list is not needed");
tool(62, "kofi", "WebSearch", { query: "order api pricing comparison Acme layoffs" });
tool(72, "kofi", "WebFetch", { url: "https://pricing.example.com/orders" });
tool(82, "kofi", "WebSearch", { query: "rate limit tiers" });
tool(92, "kofi", "Read", { file_path: "/Users/pedro/.ssh/config" });
tool(102, "kofi", "Write", { file_path: "findings.md" });
at(130, "kofi", "Stop");

at(90, "free1", "SessionStart");
prompt(94, "free1", "rotate the prod db password, new one is hunter2");
tool(100, "free1", "Bash", { command: "psql -h db.internal -c 'select 1'" });
tool(108, "free1", "Read", { file_path: "docker-compose.yml" });
ask(116, "free1", "Bash", { command: "rm -rf node_modules" });
tool(150, "free1", "Bash", { command: "rm -rf node_modules" });
at(160, "free1", "Stop");
prompt(330, "free1", "now rebuild everything");
ask(336, "free1", "Bash", { command: "docker compose up --build" });

at(142, "felix", "SessionStart");
prompt(146, "felix", "Build the HUD from Maya's sprites");
tool(152, "felix", "Read", { file_path: "HUD.tsx" });
tool(160, "felix", "Edit", { file_path: "HUD.tsx" });
tool(168, "felix", "Edit", { file_path: "HUD.tsx" });
tool(176, "felix", "Bash", { command: "bun test" });
at(184, "felix", "PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "bun test" } });
tool(190, "felix", "Edit", { file_path: "HUD.tsx" });
tool(198, "felix", "Bash", { command: "bun test" });
spawn(212, "felix", "agent-2", "general-purpose");
done(236, "felix", "agent-2", "general-purpose");
at(242, "felix", "Stop");

at(170, "free4", "SessionStart");
prompt(176, "free4", "scratch pad for a bash one-liner");
tool(182, "free4", "Bash", { command: "cargo run" });
tool(190, "free4", "Read", { file_path: "lib.rs" });
tool(198, "free4", "Edit", { file_path: "lib.rs" });
tool(210, "free4", "Bash", { command: "cargo run" });
at(230, "free4", "Stop");
prompt(400, "free4", "one more thing");
tool(406, "free4", "Edit", { file_path: "lib.rs" });

at(246, "ines", "SessionStart");
prompt(250, "ines", "Review the HUD branch");
tool(256, "ines", "Read", { file_path: "HUD.tsx" });
tool(262, "ines", "Bash", { command: "git diff main" });
tool(270, "ines", "Grep", { pattern: "console.log" });
tool(278, "ines", "Bash", { command: "bun test" });
ask(290, "ines", "Bash", { command: "git merge --no-ff hud" });
tool(312, "ines", "Bash", { command: "git merge --no-ff hud" });
at(320, "ines", "Stop");

at(8, "pm3", "SessionStart");
prompt(12, "pm3", "Launch the lemonade app: a landing page, SEO, and the first posts. My card ends in 4242");
tool(18, "pm3", "Write", { file_path: "BOARD.md" });
at(28, "pm3", "Stop");
at(22, "lead", "SessionStart");
prompt(24, "lead", "Team: launch: the landing page and its first visitors");
tool(30, "lead", "Write", { file_path: "BOARD.launch.md" });
tool(36, "lead", "Bash", { command: "f1rm hire --team launch marketer launch.marketer-brand brand 'Task: brand'" });
at(44, "lead", "Stop");
at(40, "mkt", "SessionStart");
prompt(42, "mkt", "/cro Write growth/brand.md first");
tool(48, "mkt", "Skill", { skill: "brandkit" });
tool(56, "mkt", "Write", { file_path: "growth/brand.md" });
tool(70, "mkt", "Write", { file_path: "growth/marketing/landing.md" });
tool(86, "mkt", "Edit", { file_path: "growth/marketing/landing.md" });
at(104, "mkt", "Stop");
prompt(220, "mkt", "Draft the launch post");
tool(226, "mkt", "Write", { file_path: "growth/marketing/launch-post.md" });
at(250, "mkt", "Stop");
at(46, "seo", "SessionStart");
prompt(48, "seo", "/seo-audit the landing page");
tool(54, "seo", "WebFetch", { url: "https://lemonade.example/" });
tool(66, "seo", "Read", { file_path: "growth/brand.md" });
tool(80, "seo", "Write", { file_path: "growth/seo/audit.md" });
spawn(92, "seo", "agent-3", "Explore");
done(118, "seo", "agent-3", "Explore");
tool(124, "seo", "Edit", { file_path: "growth/seo/audit.md" });
at(140, "seo", "Stop");

export const SCENARIO: Step[] = steps.sort((a, b) => a.t - b.t);

export { WHO };
