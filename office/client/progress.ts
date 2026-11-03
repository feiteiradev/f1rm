// What a desk line's proof and time look like, as pure functions.

const route = (path: string) => "evidence/" + path.split("/").map(encodeURIComponent).join("/");

/**
 * Where a proof opens: a https link as it is, a path under `~/.f1rm/evidence/` or relative to the lead's folder through the office's read-only evidence route, otherwise nowhere.
 * The server refuses anything outside the evidence folder again; this only keeps a hostile line from becoming a `javascript:` link.
 */
export function proofHref(proof: string, repo: string, team: string): string | null {
  const p = proof.trim();
  if (/^https:\/\/\S+$/i.test(p)) return p;
  if (!p || /^none\b/i.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  const tail = p.split("/.f1rm/evidence/")[1];
  const rel = tail ?? (p.startsWith("/") ? "" : `${repo}/lead-${team}/${p}`);
  return rel && !rel.split("/").some((s) => !s || s === "." || s === "..") ? route(rel) : null;
}

/** "12m ago", or "" for no time or one that is not a date. */
export function ago(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
