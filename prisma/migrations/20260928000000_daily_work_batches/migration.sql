-- Repeatable Daily Plan batches + one final Daily Report per officer/business date.
-- Existing SUBMITTED Daily Work represented a final day, so it is preserved and backfilled as FINALIZED.

ALTER TABLE "DailyWorkEntry"
  ADD COLUMN "batchId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "actualDealerVisits" INTEGER,
  ADD COLUMN "actualNewPartyVisits" INTEGER,
  ADD COLUMN "planSubmittedAt" TIMESTAMP(3);

-- Every historical date becomes one immutable legacy batch. Draft-only dates keep this batch as their editor.
UPDATE "DailyWorkEntry"
SET "batchId" = 'legacy:' || "officerId" || ':' || "workDate"::text,
    "planSubmittedAt" = CASE WHEN "status" = 'SUBMITTED' THEN "updatedAt" ELSE NULL END;

CREATE TABLE "DailyWorkDay" (
  "id" TEXT NOT NULL,
  "officerId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "currentBatchId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "selfRating" INTEGER,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyWorkDay_pkey" PRIMARY KEY ("id")
);

INSERT INTO "DailyWorkDay" (
  "id", "officerId", "workDate", "currentBatchId", "status", "selfRating", "finalizedAt", "createdAt", "updatedAt"
)
SELECT
  'legacy-day:' || e."officerId" || ':' || e."workDate"::text,
  e."officerId",
  e."workDate",
  CASE WHEN BOOL_OR(e."status" = 'SUBMITTED')
    THEN 'locked:' || e."officerId" || ':' || e."workDate"::text
    ELSE 'legacy:' || e."officerId" || ':' || e."workDate"::text
  END,
  CASE WHEN BOOL_OR(e."status" = 'SUBMITTED') THEN 'FINALIZED' ELSE 'OPEN' END,
  MAX(e."selfRating"),
  CASE WHEN BOOL_OR(e."status" = 'SUBMITTED') THEN MAX(e."updatedAt") ELSE NULL END,
  MIN(e."createdAt"),
  MAX(e."updatedAt")
FROM "DailyWorkEntry" e
GROUP BY e."officerId", e."workDate";

-- A legacy date that had reached SUBMITTED represented the old final-day boundary. Freeze every row on that
-- date into the one legacy batch so draft section data cannot become orphaned or disappear behind the lock.
UPDATE "DailyWorkEntry" e
SET "status" = 'FINALIZED',
    "planSubmittedAt" = COALESCE(e."planSubmittedAt", e."updatedAt")
FROM "DailyWorkDay" d
WHERE d."officerId" = e."officerId"
  AND d."workDate" = e."workDate"
  AND d."status" = 'FINALIZED';

DROP INDEX "DailyWorkEntry_officerId_workDate_section_rowKey_key";
CREATE UNIQUE INDEX "DailyWorkEntry_officerId_workDate_batchId_section_rowKey_key"
  ON "DailyWorkEntry" ("officerId", "workDate", "batchId", "section", "rowKey");
CREATE INDEX "DailyWorkEntry_batchId_idx" ON "DailyWorkEntry" ("batchId");

CREATE UNIQUE INDEX "DailyWorkDay_officerId_workDate_key" ON "DailyWorkDay" ("officerId", "workDate");
CREATE INDEX "DailyWorkDay_officerId_idx" ON "DailyWorkDay" ("officerId");
CREATE INDEX "DailyWorkDay_workDate_idx" ON "DailyWorkDay" ("workDate");
CREATE INDEX "DailyWorkDay_status_idx" ON "DailyWorkDay" ("status");
ALTER TABLE "DailyWorkDay" ADD CONSTRAINT "DailyWorkDay_officerId_fkey"
  FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
