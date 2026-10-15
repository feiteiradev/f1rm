// Who an employee is. Names and looks come from the session id so they stay put across reloads.
const NAMES = [
  "Maya", "Tomas", "Ines", "Kofi", "Livia", "Anders", "Zainab", "Mateo", "Hana", "Oskar", "Priya", "Bruno",
  "Elif", "Dario", "Nadia", "Jonas", "Amara", "Felix", "Soraya", "Ivo", "Greta", "Idris", "Noor", "Caio",
];

// FNV-1a: stable, no dependencies.
export function seedOf(sessionId: string): number {
  let h = 2166136261;
  for (const c of sessionId) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function identityOf(sessionId: string) {
  const seed = seedOf(sessionId);
  // ponytail: every session is a Freelancer until the normalizer carries a role; then the role picks name and sprite.
  return { name: NAMES[seed % NAMES.length], role: "Freelancer", seed };
}
