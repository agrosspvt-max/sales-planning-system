import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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

/**
 * Resolve the current session or throw 401. The session id comes from a JWT, which can
 * outlive the database (e.g. after a re-seed/reset the user row is recreated with a new id).
 * We therefore confirm the user still exists and is active, and return the DB row as the
 * source of truth — so `ctx.userId` is guaranteed to reference a real User and can never
 * violate a foreign key downstream (audit logs, import/onboarding records, etc.).
 */
export async function requireAuth(): Promise<AuthContext> {
  const session = await auth();
  if (!session?.user?.id) throw new ApiError(401, "Not authenticated");
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true, username: true, isActive: true },
  });
  if (!user || !user.isActive) {
    throw new ApiError(401, "Your session is no longer valid. Please sign in again.");
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
