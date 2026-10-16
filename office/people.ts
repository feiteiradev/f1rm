// Who an employee is: the company roles with their shirts, and the name pool everyone's name comes from.
// Shared by the server (which assigns names) and the client (which draws them), so it imports nothing.

// A look is a seed that packs three sprite choices; the sprite sheet offers this many of each.
const SKINS = 3, SHIRTS = 12, HAIRS = 6;
const look = (skin: number, shirt: number, hair: number) => skin + SKINS * (shirt + SHIRTS * hair);
export const decodeLook = (seed: number) => ({
  skin: seed % SKINS,
  shirt: Math.floor(seed / SKINS) % SHIRTS,
  hair: Math.floor(seed / (SKINS * SHIRTS)) % HAIRS,
});

/** The models a hire can be lowered or raised to, in place of its role's own. */
export const MODELS = ["haiku", "sonnet", "opus"];

/** In company order, which is also the order staff take desks. Each role wears its own shirt; freelancers wear only the first six. */
export const ROLES = {
  pm: { title: "PM", shirt: 0 },
  lead: { title: "Team lead", shirt: 6 },
  designer: { title: "Designer", shirt: 1 },
  frontend: { title: "Frontend dev", shirt: 2 },
  backend: { title: "Backend dev", shirt: 3 },
  reviewer: { title: "Reviewer", shirt: 4 },
  researcher: { title: "Researcher", shirt: 5 },
  marketer: { title: "Marketer", shirt: 7 },
  seo: { title: "SEO specialist", shirt: 8 },
  social: { title: "Social media", shirt: 9 },
  sales: { title: "Sales", shirt: 10 },
  strategist: { title: "Strategist", shirt: 11 },
} as const;
export type RoleId = keyof typeof ROLES;
export const ROLE_IDS = Object.keys(ROLES) as RoleId[];
/** The go-to-market roles only a Founder project hires. */
export const FOUNDER_ONLY: ReadonlySet<RoleId> = new Set(["marketer", "seo", "social", "sales", "strategist"]);

const AGENT_TYPES: Record<string, RoleId> = {
  "f1rm:pm": "pm",
  "f1rm:lead": "lead",
  "f1rm:designer": "designer",
  "f1rm:frontend-dev": "frontend",
  "f1rm:backend-dev": "backend",
  "f1rm:reviewer": "reviewer",
  "f1rm:researcher": "researcher",
  "f1rm:marketer": "marketer",
  "f1rm:seo-specialist": "seo",
  "f1rm:social-media": "social",
  "f1rm:sales": "sales",
  "f1rm:strategist": "strategist",
};

/** Exactly the agent types of the plugin's role files are roles; any other agent type (another plugin's, a built-in, a near miss) is not. */
export const roleOfAgentType = (agentType: unknown): RoleId | undefined =>
  typeof agentType === "string" && Object.hasOwn(AGENT_TYPES, agentType) ? AGENT_TYPES[agentType] : undefined;

const NAMES = [
  "Abel", "Ada", "Adaeze", "Aiko", "Alba", "Alma", "Amara", "Amir", "Anders", "Anika", "Arjun", "Astrid",
  "Aurora", "Ayla", "Bastian", "Beatriz", "Bela", "Bianca", "Bo", "Bruna", "Caio", "Calla", "Camila", "Cato",
  "Celeste", "Chidi", "Clara", "Cosmo", "Cyrus", "Dalia", "Dara", "Dario", "Dina", "Ditte", "Dov", "Edda",
  "Elif", "Elio", "Elsa", "Emeka", "Emil", "Enzo", "Esme", "Ezra", "Fabio", "Farah", "Femi", "Filipa",
  "Finn", "Flora", "Freya", "Gael", "Gia", "Gideon", "Greta", "Gus", "Hadi", "Hana", "Hedda", "Helga",
  "Hiro", "Hugo", "Ida", "Idris", "Ilse", "Imani", "Inez", "Ira", "Isak", "Ivo", "Jada", "Jalen",
  "Jana", "Javi", "Joaquin", "Jonas", "Juno", "Kai", "Kamal", "Karin", "Katya", "Keanu", "Kenji", "Kira",
  "Lara", "Leif", "Lena", "Lior", "Livia", "Lotte", "Luca", "Lumi", "Lupe", "Mads", "Maeve", "Malik",
  "Mara", "Marek", "Mateo", "Maxim", "Mei", "Milo", "Mira", "Nadia", "Nalu", "Nell", "Niko", "Nikolai",
  "Nils", "Noa", "Noor", "Odile", "Olek", "Omar", "Oona", "Oskar", "Otto", "Paloma", "Pavel", "Pia",
  "Quinn", "Rafa", "Rania", "Ravi", "Remy", "Rhea", "Rio", "Rosa", "Rumi", "Runa", "Sade", "Sami",
  "Sanne", "Selin", "Sena", "Sigrid", "Silas", "Sina", "Soraya", "Stellan", "Suki", "Sven", "Tala", "Tarik",
  "Teo", "Thea", "Tiago", "Tomas", "Tove", "Udo", "Uma", "Umar", "Una", "Uri", "Valentina", "Vera",
  "Vesna", "Vik", "Wanda", "Wren", "Xavi", "Xenia", "Yara", "Yasmin", "Yuki", "Yusuf", "Zainab", "Zara",
  "Zeno", "Zia", "Zoltan", "Ines", "Kofi", "Priya", "Maya", "Felix", "Bruno", "Aditi", "Bram", "Carys",
  "Dagny", "Eero", "Fenna", "Goran", "Halim", "Ilka", "Jorun", "Kasimir", "Linnea", "Mika", "Nuno", "Orla",
];
const INITIALS = "ABCDEFGHIJKLMNOPRSTVWZ";

export function seedOf(sessionId: string): number {
  let h = 2166136261;
  for (const c of sessionId) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * The name a new arrival takes, unique among `taken`: a first name picked by its session id, probing forward through the
 * pool, so the same id lands on the same name while it is free. Past the pool, a last initial ("Tomas R.").
 */
export function nameFor(sessionId: string, taken: ReadonlySet<string>): string {
  const seed = seedOf(sessionId);
  const candidates = function* () {
    for (let i = 0; i < NAMES.length; i++) yield NAMES[(seed + i) % NAMES.length];
    for (let j = 0; j < INITIALS.length; j++) {
      for (let i = 0; i < NAMES.length; i++) yield `${NAMES[(seed + i) % NAMES.length]} ${INITIALS[(seed + j) % INITIALS.length]}.`;
    }
  };
  for (const name of candidates()) if (!taken.has(name)) return name;
  // ponytail: past 4,400 people in one office the session id finishes the name; nobody runs that many.
  return `${NAMES[seed % NAMES.length]} ${sessionId.slice(0, 6)}`;
}

/**
 * The team an employee works in, read from its session name, which `f1rm hire` sets: a lead is `lead-<team>` and a team
 * member `<team>.<role>-<task>`. Anyone else, freelancers included, is in no team.
 */
export function teamOf(e: { role: RoleId | null; title?: string }): string | null {
  const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
  if (!e.role || e.role === "pm") return null;
  const m = new RegExp(e.role === "lead" ? `^lead-(${slug})$` : `^(${slug})\\.`).exec(e.title ?? "");
  return m ? m[1] : null;
}

export const roleTitle = (role: RoleId | null) => (role ? ROLES[role].title : "Freelancer");
const FREELANCER_SHIRTS = 6;
/** A role's shirt with this session's skin and hair; a freelancer's whole look comes from its session id, in a plain shirt. */
export function seedFor(e: { sessionId: string; role: RoleId | null }): number {
  const s = seedOf(e.sessionId);
  return look(s % SKINS, e.role ? ROLES[e.role].shirt : (s >>> 3) % FREELANCER_SHIRTS, (s >>> 7) % HAIRS);
}
