// What the demo shows beyond the recorded events: each project's edition, and the boards of the Founder project. Room ids
// are the scrubbed ones in the fixture. Every word here is invented for the demo.
import type { OfficeState } from "../server/office.ts";

const room = (name: string) => `/home/demo/${name}/.git`;
const row = (id: string, owner: string, status: string, task: string) => ({ id, owner, status, branch: owner === "-" ? "-" : `worktree-${id.toLowerCase()}`, task });

export const EXTRAS: Pick<OfficeState, "editions" | "boards" | "teamBoards"> = {
  editions: {
    [room("pixel-pet")]: "work",
    [room("atlas-api")]: "work",
    [room("garden-site")]: "work",
    [room("notes-cli")]: "work",
    [room("lemonade")]: "founder",
  },
  boards: {
    [room("lemonade")]: [
      row("T1", "strategist-validate", "done", "Validate the idea with five shop owners"),
      row("T2", "lead-launch", "doing", "Launch: landing page, SEO and the first visitors"),
      row("T3", "marketer-tagline", "publish", "Tagline and one-line pitch"),
      row("T4", "social-media-week1", "publish", "Week 1 posts"),
      row("T5", "-", "todo", "Pricing page"),
    ],
  },
  teamBoards: {
    [room("lemonade")]: {
      launch: [
        row("T1", "launch.marketer-brand", "doing", "Write growth/brand.md"),
        row("T2", "launch.seo-specialist-audit", "doing", "Audit the landing page"),
        row("T3", "-", "todo", "Landing page copy"),
      ],
    },
  },
};
