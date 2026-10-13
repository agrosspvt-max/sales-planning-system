/**
 * LIST the durable Last Payment jobs that are still open (PENDING / FAILED) — read-only. They are retried AUTOMATICALLY (by the next Day Book upload, and by the first Last
 * Payment Report read after a restart); nothing needs to be run by hand. Use this to see what is waiting and why.
 *
 *   npx tsx scripts/process-last-payment-jobs.ts
 *
 * Connection: DIRECT_URL, else DATABASE_URL. Credentials are never printed.
 */
import { PrismaClient } from "@prisma/client";

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL.");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [open, done] = await Promise.all([
      prisma.lastPaymentJob.findMany({ where: { status: { in: ["PENDING", "FAILED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, scopeKey: true, workbookName: true, status: true, attempts: true, lastError: true, createdAt: true } }),
      prisma.lastPaymentJob.count({ where: { status: "DONE" } }),
    ]);
    console.log(`${open.length} open job(s), ${done} done · database host: ${new URL(url).hostname}`);
    for (const j of open) console.log(`  ${j.id} · ${j.workbookName} · month ${j.scopeKey} · ${j.status} · attempts ${j.attempts} · ${j.createdAt.toISOString()}${j.lastError ? ` · ${j.lastError}` : ""}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
