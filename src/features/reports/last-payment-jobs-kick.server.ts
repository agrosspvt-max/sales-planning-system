import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Self-healing for durable Last Payment jobs (see LastPaymentJob): after a failure or a server restart the NEXT Day Book upload retries them, and so does the first Last Payment
 * Report read — best effort, fire-and-forget, throttled per process, and only when an open job exists. It processes the stored receipts (idempotent, never touches Recovery) and
 * never delays or fails the read. The report's own payment lookup stays read-only.
 */
let lastKick = 0;
export function kickPendingLastPaymentJobs(): void {
  if (process.env.LAST_PAYMENT_JOB_KICK === "off" || Date.now() - lastKick < 60_000) return;
  lastKick = Date.now();
  void (async () => {
    try {
      if (((await prisma.lastPaymentJob?.count({ where: { status: { in: ["PENDING", "FAILED"] } } })) ?? 0) === 0) return;
      const { processPendingLastPaymentJobs } = await import("@/features/historical-daybook/service.server"); // lazy: the services import each other
      const { reconcileBillingExceptionsSafely } = await import("@/features/reports/billing-exception.server");
      const results = await processPendingLastPaymentJobs({ limit: 5 });
      const actor = results.find((r) => r.status === "DONE")?.uploadedById;
      if (actor) await reconcileBillingExceptionsSafely({ userId: actor }); // the uploader of the recovered job is the audit actor
    } catch (error) {
      console.error("[last-payment] background retry failed", error instanceof Error ? error.name : "Unknown error");
    }
  })();
}
