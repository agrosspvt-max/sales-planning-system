-- Monthly Planning: plan-level lifecycle (Create → Submitted → Approved), separate from each option's own status.
ALTER TABLE "PartyMonthlySheet"
  ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "rmDecidedById" TEXT,
  ADD COLUMN "rmDecidedAt" TIMESTAMP(3),
  ADD COLUMN "adminDecidedById" TEXT,
  ADD COLUMN "adminDecidedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionStage" TEXT,
  ADD COLUMN "rejectionReason" TEXT;

-- Existing plans were already in use before this lifecycle existed: a plan whose options have already moved past Pending is treated as
-- Approved so its work continues unchanged; everything else starts as Draft. No row, option, date history or timeline is modified.
UPDATE "PartyMonthlySheet" s SET "approvalStatus" = 'APPROVED'
WHERE EXISTS (
  SELECT 1 FROM "PartyMonthlyPlan" p JOIN "PartyMonthlyOption" o ON o."monthlyPlanId" = p."id"
  WHERE p."sheetId" = s."id" AND o."status" <> 'PENDING'
);
