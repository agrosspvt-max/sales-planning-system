-- Party Planning · Seasonal Planning (Phase 2). Purely additive: one new table. Season, Market, User and every existing table are
-- untouched. Requires the Territory Mapping migration (20261007000000) — the "Market" table — to be applied first.

CREATE TABLE "SeasonalPlan" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "rmDecidedById" TEXT,
    "rmDecidedAt" TIMESTAMP(3),
    "adminDecidedById" TEXT,
    "adminDecidedAt" TIMESTAMP(3),
    "rejectionStage" TEXT,
    "rejectionReason" TEXT,
    "approvedMarketSource" TEXT,
    "approvedMarketPotential" TEXT,
    "appointmentStatus" TEXT,
    "appointedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeasonalPlan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SeasonalPlan_approvalStatus_check" CHECK ("approvalStatus" IN ('DRAFT', 'PENDING_RM', 'PENDING_ADMIN', 'APPROVED', 'REJECTED')),
    CONSTRAINT "SeasonalPlan_appointmentStatus_check" CHECK ("appointmentStatus" IS NULL OR "appointmentStatus" IN ('PENDING', 'APPOINTED')),
    CONSTRAINT "SeasonalPlan_rejectionStage_check" CHECK ("rejectionStage" IS NULL OR "rejectionStage" IN ('RM', 'ADMIN')),
    CONSTRAINT "SeasonalPlan_approvedMarketPotential_check" CHECK ("approvedMarketPotential" IS NULL OR "approvedMarketPotential" IN ('A', 'B', 'C')),
    -- An appointment date can only exist for an APPOINTED plan, and only an approved plan has an appointment status.
    CONSTRAINT "SeasonalPlan_appointment_consistency_check" CHECK (
      ("appointedAt" IS NULL OR "appointmentStatus" = 'APPOINTED')
      AND ("appointmentStatus" IS NULL OR "approvalStatus" = 'APPROVED')
    )
);
CREATE INDEX "SeasonalPlan_seasonId_idx" ON "SeasonalPlan"("seasonId");
CREATE INDEX "SeasonalPlan_ownerId_idx" ON "SeasonalPlan"("ownerId");
CREATE INDEX "SeasonalPlan_marketId_idx" ON "SeasonalPlan"("marketId");
CREATE INDEX "SeasonalPlan_approvalStatus_idx" ON "SeasonalPlan"("approvalStatus");
ALTER TABLE "SeasonalPlan" ADD CONSTRAINT "SeasonalPlan_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SeasonalPlan" ADD CONSTRAINT "SeasonalPlan_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SeasonalPlan" ADD CONSTRAINT "SeasonalPlan_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
