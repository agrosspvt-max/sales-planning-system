import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertDaybookEnabled } from "./daybook.server";
import { assertSuper } from "./service.server";
import { savedDaybookProducts } from "./daybook-products";

export type ProductJob = {
  id: string;
  connectionId: string;
  monthKey: string;
  fromDate: string;
  throughDate: string;
  completedAt: Date | null;
  summary: Prisma.JsonValue | null;
};
const select = {
  id: true,
  connectionId: true,
  monthKey: true,
  fromDate: true,
  throughDate: true,
  completedAt: true,
  summary: true,
} as const;
export async function authorizedProductJob(ctx: AuthContext, jobId: string): Promise<ProductJob> {
  assertDaybookEnabled();
  assertSuper(ctx);
  const job = await prisma.tallyDaybookJob.findFirst({
    where: { id: jobId, status: "SUCCEEDED", connection: { enabled: true } },
    select,
  });
  if (!job)
    throw new ApiError(404, "This published Daybook capture is unavailable. Reload Daybook.");
  return job;
}
export function productsInJob(job: ProductJob) {
  const summary = job.summary;
  const saved = savedDaybookProducts.safeParse(
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? summary._daybookProducts
      : undefined,
  );
  return saved.success ? saved.data : null;
}
export function unavailableProducts(job: ProductJob) {
  const saved = productsInJob(job);
  return saved?.capture.status === "unavailable"
    ? `Daybook product capture was not complete (${saved.capture.error}). Refresh this month to retry. Sales figures are unchanged.`
    : "This older Daybook capture has no complete bill-product dataset. Install connector 1.6.9-test and refresh this month.";
}
export async function productJobsAcrossMonths(source: ProductJob) {
  const months = await prisma.tallyDaybookJob.groupBy({
    by: ["monthKey"],
    where: {
      connectionId: source.connectionId,
      status: "SUCCEEDED",
      completedAt: { not: null },
      monthKey: { gte: "2026-04", lte: "2027-03", not: source.monthKey },
    },
    _max: { completedAt: true },
  });
  const latest = months.length
    ? await prisma.tallyDaybookJob.findMany({
        where: {
          connectionId: source.connectionId,
          status: "SUCCEEDED",
          OR: months.map((month) => ({
            monthKey: month.monthKey,
            completedAt: month._max.completedAt,
          })),
        },
        select,
      })
    : [];
  return [source, ...latest];
}
