import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { admitPrismaClient, DatabaseAdmission, databaseRuntimeOptions, type DatabaseRuntime } from "./db-admission";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; admittedPrisma?: PrismaClient; databaseRuntime?: DatabaseRuntime };
const options = process.env.DATABASE_URL ? databaseRuntimeOptions(process.env.DATABASE_URL, process.env.DB_MAX_CONCURRENT_OPERATIONS) : null;
const runtime = globalForPrisma.databaseRuntime ??= {
  admission: new DatabaseAdmission(options?.limit ?? 6), transaction: new AsyncLocalStorage<boolean>(),
};

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
      ...(options ? { datasources: { db: { url: options.url } } } : {}),
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
    ...(options ? { datasources: { db: { url: options.url } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

// A hot reload must reuse BOTH the client/pool and the admission queue. Reuse an older unwrapped
// development client too, rather than leaking its live connections when this wrapper is first loaded.
export const prisma = globalForPrisma.admittedPrisma ??= admitPrismaClient(globalForPrisma.prisma ?? createPrisma(), runtime);

// Pin the client to this process/isolate in every environment. Module caching normally already gives one
// production client, while globalThis also protects against the same module being evaluated through more than
// one server bundle. Serverless isolates still have their own client, as required by their process boundary.
globalForPrisma.prisma = prisma;
