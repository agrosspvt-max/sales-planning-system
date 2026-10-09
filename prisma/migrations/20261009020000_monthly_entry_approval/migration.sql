-- Monthly Planning: approval moves from the whole plan to each ENTRY (market row), so one plan per owner + month can keep accepting entries
-- (Create) while earlier batches sit in Submitted / Approved. The plan-level columns on PartyMonthlySheet stay as the historical record.
ALTER TABLE "PartyMonthlyPlan"
  ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "rmDecidedById" TEXT,
  ADD COLUMN "rmDecidedAt" TIMESTAMP(3),
  ADD COLUMN "adminDecidedById" TEXT,
  ADD COLUMN "adminDecidedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionStage" TEXT,
  ADD COLUMN "rejectionReason" TEXT;

-- Existing entries inherit the state their plan was in, so every historical plan keeps loading in the same section.
UPDATE "PartyMonthlyPlan" p SET
  "approvalStatus" = s."approvalStatus", "submittedAt" = s."submittedAt",
  "rmDecidedById" = s."rmDecidedById", "rmDecidedAt" = s."rmDecidedAt", "adminDecidedById" = s."adminDecidedById", "adminDecidedAt" = s."adminDecidedAt",
  "rejectionStage" = s."rejectionStage", "rejectionReason" = s."rejectionReason"
FROM "PartyMonthlySheet" s WHERE s."id" = p."sheetId";
