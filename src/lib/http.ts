import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db-retry";
import { can, type Action, type Resource } from "@/lib/rbac";
import type { Role } from "@prisma/client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthContext {
  userId: string;
  role: Role;
  username: string;
}

type AuthUserRow = {
  id: string;
  role: Role;
  username: string;
  isActive: boolean;
  deletedAt: Date | null;
  sessionValidAfter: Date | null;
} | null;

/**
 * Per-request auth lookup with single-flight + a short TTL cache.
 *
 * Every API request re-verifies the caller via prisma.user.findUnique. Opening one page fans out to
 * many API calls at once (page data + /api/labels + /api/notifications), each authenticating — so this
 * lookup is, by far, the most-repeated query in the app and a prime contributor to pool pressure.
 *
 *  - SINGLE-FLIGHT: concurrent lookups for the same (userId, iat) share one in-flight query.
 *  - SHORT TTL CACHE (AUTH_CACHE_TTL_MS, default 8s): once resolved, the row is reused for a few
 *    seconds, so a burst of requests (and rapid navigation) issues ONE user query instead of dozens.
 *
 * Security note: this caps how quickly a mid-session change is observed to AUTH_CACHE_TTL_MS — a
 * deactivation / deletion / role change / password-change (sessionValidAfter) takes effect within the
 * TTL rather than instantly. All of those checks still run every request against the (cached) row; only
 * the DB read is throttled. Set AUTH_CACHE_TTL_MS=0 to disable the cache and revert to per-request reads.
 */
const AUTH_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 8000);
const authCache = new Map<string, { at: number; row: AuthUserRow }>();
const inflightAuthUser = new Map<string, Promise<AuthUserRow>>();

function loadAuthUser(id: string, key: string): Promise<AuthUserRow> {
  const cached = authCache.get(key);
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) return Promise.resolve(cached.row);

  const existing = inflightAuthUser.get(key);
  if (existing) return existing;

  const p = withDbRetry(() =>
    prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, username: true, isActive: true, deletedAt: true, sessionValidAfter: true },
    }),
  ).then((row) => {
    if (AUTH_TTL_MS > 0) authCache.set(key, { at: Date.now(), row: row as AuthUserRow });
    return row as AuthUserRow;
  });
  inflightAuthUser.set(key, p);
  // Clear the in-flight entry on settle; errors still propagate to awaiters via the returned promise.
  p.finally(() => {
    if (inflightAuthUser.get(key) === p) inflightAuthUser.delete(key);
  }).catch(() => {});
  return p;
}

/** Drop a user's cached auth row immediately (call after deactivate/delete/role or password changes). */
export function invalidateAuthCache(userId: string): void {
  for (const k of authCache.keys()) if (k.startsWith(`${userId}:`)) authCache.delete(k);
}

/**
 * Resolve the current session or throw 401. The session id comes from a JWT, which can
 * outlive the database (e.g. after a re-seed/reset the user row is recreated with a new id).
 * We therefore confirm the user still exists and is active, and return the DB row as the
 * source of truth — so `ctx.userId` is guaranteed to reference a real User and can never
 * violate a foreign key downstream (audit logs, import/onboarding records, etc.).
 */
export async function requireAuth(): Promise<AuthContext> {
  const session = await auth();
  if (!session?.user?.id) {
    console.warn("[requireAuth] 401 — no session/JWT on the request");
    throw new ApiError(401, "Not authenticated");
  }
  // The auth check itself is unchanged; only the DB read is retried on TRANSIENT connectivity errors
  // (e.g. a Neon connection briefly unavailable during a heavy import) so a momentary P1001 does not
  // turn every request into a 500. Security is not affected — the same user validation still runs.
  // Concurrent requests for the same (user, iat) share a single in-flight lookup (see loadAuthUser).
  const iat = session.user.iat;
  const user = await loadAuthUser(session.user.id, `${session.user.id}:${typeof iat === "number" ? iat : "0"}`);
  // Every request re-verifies the DB user: must exist, not be soft-deleted, and be active — so
  // deactivating/deleting a user takes effect immediately, even for an already-issued JWT. The most
  // common cause of "found=false" is a JWT that outlived the database (user row recreated by a
  // migration / re-seed with a new id) — the client signs out + redirects to /login on this 401.
  if (!user || user.deletedAt || !user.isActive) {
    console.warn(`[requireAuth] 401 — DB user check failed (id=${session.user.id}, found=${!!user}, deleted=${!!user?.deletedAt}, active=${user?.isActive ?? "n/a"})`);
    throw new ApiError(401, "Your session is no longer valid. Please sign in again.");
  }
  // Sessions issued before a password change / forced logout are rejected (iat in seconds).
  if (user.sessionValidAfter && (typeof iat !== "number" || iat * 1000 < user.sessionValidAfter.getTime())) {
    console.warn(`[requireAuth] 401 — session predates sessionValidAfter (id=${session.user.id})`);
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }
  return { userId: user.id, role: user.role, username: user.username };
}

/** Resolve the session and assert a permission, or throw 401/403. */
export async function requirePermission(
  resource: Resource,
  action: Action,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!can(ctx.role, resource, action)) {
    throw new ApiError(403, "You do not have permission to perform this action");
  }
  return ctx;
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/** Wrap a route handler with uniform error handling. The handler itself must never throw. */
export function handle(fn: () => Promise<NextResponse>) {
  return fn().catch((error: unknown) => {
    // Any failure while classifying/serialising the error must still yield a valid response,
    // never a second crash that masks the original problem.
    try {
      if (error instanceof ApiError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof ZodError) {
        return NextResponse.json(
          { error: "Validation failed", issues: error.flatten().fieldErrors },
          { status: 422 },
        );
      }
      if (prismaErrorCode(error) === "P2002") {
        // Log the exact constraint so root causes are never masked by the generic message.
        const target = (error as { meta?: { target?: unknown } }).meta?.target;
        const targetStr = Array.isArray(target) ? target.join(", ") : String(target ?? "unknown");
        console.error("P2002 unique constraint violation on:", targetStr, "\n", error);
        return NextResponse.json(
          { error: `A record with this value already exists (${targetStr})` },
          { status: 409 },
        );
      }
      if (prismaErrorCode(error) === "P2003") {
        // Foreign-key violation — typically a referenced record that no longer exists
        // (e.g. a stale session id). Surface it clearly rather than as a raw 500.
        return NextResponse.json(
          { error: "A referenced record no longer exists. Please refresh and sign in again." },
          { status: 409 },
        );
      }
      console.error(error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    } catch (handlerError) {
      console.error("Error handler failed:", handlerError, "— original error:", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}
