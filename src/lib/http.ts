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
 * Single-flight de-duplication of the per-request auth lookup.
 *
 * Every API request re-verifies the caller via prisma.user.findUnique. Opening one page fires several
 * API calls at once (e.g. /api/groups + /api/labels + /api/notifications), so WITHOUT this the same
 * user row is fetched N times simultaneously — N connections held for identical work. During a Neon
 * cold start (compute waking from auto-suspend) that concurrency is exactly what tips the small pool
 * into P2024 "timed out fetching a connection" and surfaces P1001. Coalescing collapses a concurrent
 * burst for the same (userId, iat) into ONE in-flight query.
 *
 * This is pure concurrency de-duplication, NOT a cache: the entry is deleted the instant the query
 * settles, so the very next (non-concurrent) request does a fresh lookup. Deactivation/deletion and
 * sessionValidAfter therefore still take effect immediately — security semantics are unchanged.
 */
const inflightAuthUser = new Map<string, Promise<AuthUserRow>>();

function loadAuthUser(id: string, key: string): Promise<AuthUserRow> {
  const existing = inflightAuthUser.get(key);
  if (existing) return existing;
  const p = withDbRetry(() =>
    prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, username: true, isActive: true, deletedAt: true, sessionValidAfter: true },
    }),
  ) as Promise<AuthUserRow>;
  inflightAuthUser.set(key, p);
  // Clear on settle so this is coalescing, not caching. The cleanup branch swallows its own error;
  // the real error still propagates to awaiters via the returned promise.
  p.finally(() => {
    if (inflightAuthUser.get(key) === p) inflightAuthUser.delete(key);
  }).catch(() => {});
  return p;
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
