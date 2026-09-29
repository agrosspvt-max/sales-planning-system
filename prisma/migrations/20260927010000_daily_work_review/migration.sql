-- Phase 2: Regional Manager's immutable daily review of a Sales Officer's submitted Daily Work.
-- A submission is identified by (officerId, workDate); the UNIQUE on those columns enforces exactly one review
-- per submission and blocks duplicate/concurrent creation. The service only ever inserts (never updates/deletes),
-- so the row is immutable. Additive; no existing data is touched.
CREATE TABLE "DailyWorkReview" (
    "id" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyWorkReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyWorkReview_officerId_workDate_key" ON "DailyWorkReview"("officerId", "workDate");
CREATE INDEX "DailyWorkReview_reviewerId_idx" ON "DailyWorkReview"("reviewerId");
CREATE INDEX "DailyWorkReview_workDate_idx" ON "DailyWorkReview"("workDate");

ALTER TABLE "DailyWorkReview" ADD CONSTRAINT "DailyWorkReview_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyWorkReview" ADD CONSTRAINT "DailyWorkReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
