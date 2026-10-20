// The page's actions. It lives under /<ui token>/, so a relative URL carries the token.

/** What a 401 means to the person: the page's link is from an office that no longer takes it. */
export const OUT_OF_DATE = "This link is out of date — open the office with `f1rm`";

/** Why a reply with this status failed, for an error reply that gave no reason of its own. A 401 never shows as a bare status. */
export const failure = (status: number, own: string | undefined, fallback = `Failed (${status}).`) => (status === 401 ? OUT_OF_DATE : (own ?? fallback));

/** The JSON body of an office reply. `ended` is a Jump on a session that just ended (HTTP 410). */
export type Reply = { ok?: boolean; error?: string; ended?: boolean; [key: string]: unknown };

/** POSTs an action. `error` is null when the office did it, otherwise why it didn't; `reply` is the JSON body, if there was one. */
export async function send(path: string, body?: object): Promise<{ error: string | null; reply: Reply | null }> {
  try {
    const res = await fetch(new URL(path, location.href), {
      method: "POST",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const reply: Reply | null = await res.json().catch(() => null);
    return { error: res.ok ? null : failure(res.status, reply?.error), reply };
  } catch {
    return { error: "The office isn't reachable.", reply: null };
  }
}

/** POSTs an action. Null when the office did it, otherwise why it didn't. */
export const post = async (path: string, body?: object) => (await send(path, body)).error;
