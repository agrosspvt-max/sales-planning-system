import { localizeDatesInText } from "./date-format";

export interface ApiErrorBody {
  error?: string;
  issues?: Record<string, string[]>;
}

/**
 * Error thrown by the API client for a non-OK response. Carries the HTTP `status` so callers can react to
 * specific conditions (e.g. autosave treating 409 as a stale-batch conflict rather than a retryable failure).
 * Still a plain `Error` with the server message, so existing `(e as Error).message` handling is unchanged.
 */
export class ApiRequestError extends Error {
  status: number;
  issues?: Record<string, string[]>;
  constructor(status: number, message: string, issues?: Record<string, string[]>) {
    super(localizeDatesInText(message)); // an ISO date inside a server message is shown as DD/MM/YYYY
    this.name = "ApiRequestError";
    this.status = status;
    this.issues = issues;
  }
}

/** A transport failure, explicitly distinguished from a payload/JSON/programming error. */
export class ApiNetworkError extends Error {
  readonly code = "API_NETWORK_ERROR";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network request failed");
    this.name = "ApiNetworkError";
  }
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
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    text = await res.text();
  } catch (error) {
    // Explicit cancellation must not be turned into a retryable network failure.
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    throw new ApiNetworkError(error);
  }
  let body: ApiErrorBody | T = {} as T;
  try { body = text ? JSON.parse(text) : {}; }
  catch (error) {
    // Proxies can return HTML for a genuine HTTP failure. Retain its status for bounded retry.
    if (res.ok) throw error;
  }
  if (!res.ok) {
    const err = body as ApiErrorBody;
    if (res.status === 401) void handleUnauthenticated();
    throw new ApiRequestError(res.status, err.error ?? "Request failed", err.issues);
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
  del: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "DELETE", ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }),
};
