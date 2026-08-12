import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * TEMPORARY connection/latency diagnostics (Task 9). Enable with PRISMA_DEBUG=1 to log the duration of
 * every SQL statement and flag slow ones (default > PRISMA_SLOW_MS, 500ms). Because Prisma emits
 * BEGIN / COMMIT as their own "query" events, a long-held transaction shows up as a slow BEGIN…COMMIT
 * span, and a statement that is really just WAITING for a pooled connection shows a large duration —
 * so this pinpoints exactly what holds connections. Off by default (no prod overhead). Remove once the
 * database slowness is diagnosed.
 */
const DEBUG = process.env.PRISMA_DEBUG === "1" || process.env.PRISMA_DEBUG === "true";
const SLOW_MS = Number(process.env.PRISMA_SLOW_MS ?? 500);

function createPrisma(): PrismaClient {
  if (DEBUG) {
    const client = new PrismaClient({
      log: [
        { emit: "event", level: "query" },
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
    });
    client.$on("query", (e: { duration: number; query: string }) => {
      if (e.duration >= SLOW_MS) console.warn(`[prisma ${e.duration}ms] ${e.query.slice(0, 200)}`);
    });
    return client;
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
