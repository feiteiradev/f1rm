// The page's actions. It lives under /<ui token>/, so a relative URL carries the token.

/** POSTs an action. `error` is null when the office did it, otherwise why it didn't; `reply` is the JSON body, if there was one. */
export async function send(path: string, body?: object): Promise<{ error: string | null; reply: Record<string, unknown> | null }> {
  try {
    const res = await fetch(new URL(path, location.href), {
      method: "POST",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const reply = await res.json().catch(() => null);
    return { error: res.ok ? null : ((reply?.error as string | undefined) ?? `Failed (${res.status}).`), reply };
  } catch {
    return { error: "The office isn't reachable.", reply: null };
  }
}

/** POSTs an action. Null when the office did it, otherwise why it didn't. */
export const post = async (path: string, body?: object) => (await send(path, body)).error;
