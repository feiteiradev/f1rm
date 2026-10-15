// Who an employee is: the six company roles with their fixed names and looks, and the freelancer name pool.
// Shared by the server (which assigns names) and the client (which draws them), so it imports nothing.

// A look is a seed that packs three sprite choices; the sprite sheet offers this many of each.
const SKINS = 3, SHIRTS = 6, HAIRS = 6;
const look = (skin: number, shirt: number, hair: number) => skin + SKINS * (shirt + SHIRTS * hair);
export const decodeLook = (seed: number) => ({
  skin: seed % SKINS,
  shirt: Math.floor(seed / SKINS) % SHIRTS,
  hair: Math.floor(seed / (SKINS * SHIRTS)) % HAIRS,
});

/** In company order, which is also the order staff take desks. */
export const ROLES = {
  pm: { title: "PM", name: "Priya", seed: look(0, 0, 2) },
  designer: { title: "Designer", name: "Maya", seed: look(1, 1, 0) },
  frontend: { title: "Frontend dev", name: "Felix", seed: look(2, 2, 1) },
  backend: { title: "Backend dev", name: "Bruno", seed: look(0, 3, 3) },
  reviewer: { title: "Reviewer", name: "Ines", seed: look(1, 4, 4) },
  researcher: { title: "Researcher", name: "Kofi", seed: look(2, 5, 5) },
} as const;
export type RoleId = keyof typeof ROLES;
export const ROLE_IDS = Object.keys(ROLES) as RoleId[];

/**
 * `f1rm:designer` and `f1rm:frontend-dev` are roles; any other agent type (another plugin's, a built-in) is not.
 * ponytail: the `-dev` spelling is a guess at the role file names; the plugin's role files (#10) must match or this follows them.
 */
export function roleOfAgentType(agentType: unknown): RoleId | undefined {
  if (typeof agentType !== "string" || !agentType.startsWith("f1rm:")) return undefined;
  const id = agentType.slice("f1rm:".length).replace(/-dev$/, "");
  return Object.hasOwn(ROLES, id) ? (id as RoleId) : undefined;
}

// None of the six role names, so a freelancer is never mistaken for staff.
// ponytail: 48 names, then the pool repeats with counters ("Tomas (2)"); widen the pool if offices that big get common.
const FREELANCER_NAMES = [
  "Tomas", "Livia", "Anders", "Zainab", "Mateo", "Hana", "Oskar", "Elif", "Dario", "Nadia", "Jonas", "Amara",
  "Soraya", "Ivo", "Greta", "Idris", "Noor", "Caio", "Aiko", "Bianca", "Cyrus", "Dalia", "Emeka", "Freya",
  "Gael", "Helga", "Imani", "Joaquin", "Katya", "Leif", "Mira", "Nikolai", "Odile", "Pavel", "Quinn", "Rosa",
  "Stellan", "Thea", "Umar", "Vera", "Wren", "Xavi", "Yara", "Zeno", "Abel", "Beatriz", "Cato", "Dina",
];

export function seedOf(sessionId: string): number {
  let h = 2166136261;
  for (const c of sessionId) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * The name a new arrival takes, unique among `taken`. A role keeps its fixed name and, when another shift
 * of the role is in, gets the lowest free counter ("Maya (2)"). A freelancer starts at a name picked by its
 * session id and probes forward, so the same id lands on the same name until the pool runs out, then the
 * pool is reused with a counter.
 */
export function nameFor(sessionId: string, role: RoleId | null, taken: ReadonlySet<string>): string {
  const withCounter = (base: string, n: number) => (n === 1 ? base : `${base} (${n})`);
  if (role) {
    for (let n = 1; ; n++) if (!taken.has(withCounter(ROLES[role].name, n))) return withCounter(ROLES[role].name, n);
  }
  const start = seedOf(sessionId) % FREELANCER_NAMES.length;
  for (let n = 1; ; n++) {
    for (let i = 0; i < FREELANCER_NAMES.length; i++) {
      const name = withCounter(FREELANCER_NAMES[(start + i) % FREELANCER_NAMES.length], n);
      if (!taken.has(name)) return name;
    }
  }
}

export const roleTitle = (role: RoleId | null) => (role ? ROLES[role].title : "Freelancer");
export const seedFor = (e: { sessionId: string; role: RoleId | null }) => (e.role ? ROLES[e.role].seed : seedOf(e.sessionId));
