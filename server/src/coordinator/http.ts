/**
 * Tiny fetch helper with timeout. `tryFetchJson` never throws — it returns
 * null on network error / timeout so callers can degrade gracefully (FR-D2).
 */

export interface HttpResult {
  ok: boolean;
  status: number;
  body: any;
}

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 2000): Promise<HttpResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body is fine */
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function tryFetchJson(url: string, init: RequestInit = {}, timeoutMs = 2000): Promise<HttpResult | null> {
  try {
    return await fetchJson(url, init, timeoutMs);
  } catch {
    return null;
  }
}
