// The page's actions. It lives under /<ui token>/, so a relative URL carries the token.

/** POSTs an action. Null when the office did it, otherwise why it didn't. */
export async function post(path: string, body?: object): Promise<string | null> {
  try {
    const res = await fetch(new URL(path, location.href), {
      method: "POST",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return res.ok ? null : ((await res.json().catch(() => null))?.error ?? `Failed (${res.status}).`);
  } catch {
    return "The office isn't reachable.";
  }
}
