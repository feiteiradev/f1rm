// Jump: bring an employee's terminal to the front.
import type { machine as realMachine } from "./machine.ts";
import type { Employee } from "./office.ts";

export type JumpResult = { ok: true } | { ok: false; error: string };

export async function jump(machine: typeof realMachine, e: Employee): Promise<JumpResult> {
  try {
    // VS Code's terminal inherits ITERM_SESSION_ID when VS Code was launched from iTerm2, so it is checked first.
    if (e.terminal.termProgram === "vscode") {
      await machine.openVsCode(e.cwd);
      return { ok: true };
    }
    if (e.terminal.itermSessionId) {
      return (await machine.focusIterm(e.terminal.itermSessionId))
        ? { ok: true }
        : { ok: false, error: "Its terminal tab is closed." };
    }
    // Background sessions have no tab; attaching gives them one.
    // ponytail: runs `claude agents` on each such jump; fine until a jump is felt to lag.
    const id = await machine.backgroundId(e.sessionId);
    if (id) {
      await machine.attachInIterm(id);
      return { ok: true };
    }
    return { ok: false, error: "No iTerm2 tab or VS Code window to jump to." };
  } catch (err) {
    return { ok: false, error: `Jump failed: ${(err as Error).message}` };
  }
}
