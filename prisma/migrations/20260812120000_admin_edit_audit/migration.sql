-- Additive only: field-level history of Super-Admin corrections to APPROVED plans (Admin Override).
-- Records history only; it does not touch any planning table, the approval workflow, or calculations.
CREATE TABLE "AdminEditAudit" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "planType" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER,
    "seasonId" TEXT,
    "seasonMonthId" TEXT,
    "dealerId" TEXT NOT NULL,
    "dealerName" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT,
    "fieldName" TEXT NOT NULL,
    "oldValue" DECIMAL(14,4),
    "newValue" DECIMAL(14,4),
    "difference" DECIMAL(14,4),
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminEditAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminEditAudit_planId_idx" ON "AdminEditAudit"("planId");
CREATE INDEX "AdminEditAudit_dealerId_idx" ON "AdminEditAudit"("dealerId");
CREATE INDEX "AdminEditAudit_productId_idx" ON "AdminEditAudit"("productId");
CREATE INDEX "AdminEditAudit_seasonId_idx" ON "AdminEditAudit"("seasonId");
CREATE INDEX "AdminEditAudit_seasonMonthId_idx" ON "AdminEditAudit"("seasonMonthId");
CREATE INDEX "AdminEditAudit_adminId_idx" ON "AdminEditAudit"("adminId");
CREATE INDEX "AdminEditAudit_createdAt_idx" ON "AdminEditAudit"("createdAt");
