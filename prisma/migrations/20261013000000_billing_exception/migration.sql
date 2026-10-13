-- Last Payment Report → Billing Exception. Additive only: one new table, no change to existing data. Nothing here is applied automatically.
CREATE TABLE "BillingException" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "billingDate" DATE NOT NULL,
    "billNo" TEXT NOT NULL,
    "authPerson" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CURRENT',
    "resolvedAt" TIMESTAMP(3),
    "resolutionReason" TEXT,
    "resolvedDays" INTEGER,
    "snapDays" INTEGER NOT NULL,
    "snapLastPaymentDate" DATE,
    "snapAmount" DECIMAL(14,2),
    "snapParty" TEXT NOT NULL,
    "snapDealerStatus" TEXT NOT NULL,
    "snapState" TEXT,
    "snapTerritory" TEXT,
    "snapSalesOfficer" TEXT,
    "snapSalesOfficerId" TEXT,

    CONSTRAINT "BillingException_pkey" PRIMARY KEY ("id")
);

-- One logical Save = one (creator, requestId): a retry / double click cannot create a second row; a deliberate new exception uses a new requestId.
CREATE UNIQUE INDEX "BillingException_createdById_requestId_key" ON "BillingException"("createdById", "requestId");
CREATE INDEX "BillingException_status_createdAt_idx" ON "BillingException"("status", "createdAt");
CREATE INDEX "BillingException_dealerId_status_idx" ON "BillingException"("dealerId", "status");
CREATE INDEX "BillingException_dealerId_createdAt_idx" ON "BillingException"("dealerId", "createdAt");

-- RESTRICT: exception history is never cascaded away with a dealer or user.
ALTER TABLE "BillingException" ADD CONSTRAINT "BillingException_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingException" ADD CONSTRAINT "BillingException_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
