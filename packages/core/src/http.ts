/**
 * Throws on non-2xx responses, embedding the response body so geo-blocks
 * (HTTP 403/451) and rate limits are visible in logs instead of a bare status.
 */
export async function assertHttpOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let body = '';
  try {
    body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    // body unreadable — status alone is still useful
  }
  throw new Error(`${what}: HTTP ${res.status}${body ? ` — ${body}` : ''}`);
}
