export interface ApiErrorBody {
  error?: string;
  issues?: Record<string, string[]>;
}

// Guards against firing multiple sign-outs when several requests 401 at once (e.g. Recovery +
// Notifications + Labels all firing on one page after the session became invalid).
let signingOut = false;

/**
 * A 401 means the session is no longer valid — most commonly the JWT outlived the database (the user
 * row was recreated by a migration / DB reset, so the token's id no longer resolves). We fully SIGN
 * OUT (clear the stale cookie) and return to /login rather than leaving the page on a blank/error
 * state. A plain redirect would loop, because the login route bounces a present token back into the
 * app; signOut removes the token first. We never do this while already on /login (the unauthenticated
 * shell may legitimately probe an authed endpoint) so there is no redirect loop.
 */
async function handleUnauthenticated(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  if (signingOut) return;
  signingOut = true;
  const { signOut } = await import("next-auth/react");
  await signOut({ callbackUrl: "/login" });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = body as ApiErrorBody;
    if (res.status === 401) void handleUnauthenticated();
    throw new Error(err.error ?? "Request failed");
  }
  return body as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, data: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(data) }),
  patch: <T>(url: string, data: unknown) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(data) }),
  put: <T>(url: string, data: unknown) =>
    request<T>(url, { method: "PUT", body: JSON.stringify(data) }),
  del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};
