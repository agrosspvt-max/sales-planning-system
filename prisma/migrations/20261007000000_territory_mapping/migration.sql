-- Party Planning · Territory Mapping (Phase 1). Purely additive: three new tables, no existing table or column is altered
-- or rewritten. The legacy free-text marketName columns (PartyPlan / DailyWorkEntry / CalendarEntry) are untouched.

CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "potential" TEXT,
    "source" TEXT NOT NULL DEFAULT 'EXISTING',
    "expectedParties" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Market_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Market_potential_check" CHECK ("potential" IS NULL OR "potential" IN ('A', 'B', 'C')),
    CONSTRAINT "Market_source_check" CHECK ("source" IN ('EXISTING', 'REQUESTED'))
);
CREATE UNIQUE INDEX "Market_nameKey_key" ON "Market"("nameKey");

CREATE TABLE "DealerMarketMapping" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "marketId" TEXT,
    "potential" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerMarketMapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DealerMarketMapping_potential_check" CHECK ("potential" IS NULL OR "potential" IN ('A', 'B', 'C'))
);
CREATE UNIQUE INDEX "DealerMarketMapping_dealerId_key" ON "DealerMarketMapping"("dealerId");
CREATE INDEX "DealerMarketMapping_marketId_idx" ON "DealerMarketMapping"("marketId");
ALTER TABLE "DealerMarketMapping" ADD CONSTRAINT "DealerMarketMapping_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealerMarketMapping" ADD CONSTRAINT "DealerMarketMapping_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MarketRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "marketName" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "potential" TEXT NOT NULL,
    "numberOfParties" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "rmDecision" TEXT,
    "rmDecidedById" TEXT,
    "rmDecidedAt" TIMESTAMP(3),
    "adminDecision" TEXT,
    "adminDecidedById" TEXT,
    "adminDecidedAt" TIMESTAMP(3),
    "rejectionStage" TEXT,
    "rejectionReason" TEXT,
    "marketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MarketRequest_potential_check" CHECK ("potential" IN ('A', 'B', 'C')),
    CONSTRAINT "MarketRequest_status_check" CHECK ("status" IN ('PENDING_RM', 'PENDING_ADMIN', 'APPROVED', 'REJECTED')),
    CONSTRAINT "MarketRequest_parties_check" CHECK ("numberOfParties" > 0)
);
CREATE INDEX "MarketRequest_requesterId_idx" ON "MarketRequest"("requesterId");
CREATE INDEX "MarketRequest_status_idx" ON "MarketRequest"("status");
CREATE INDEX "MarketRequest_nameKey_idx" ON "MarketRequest"("nameKey");
ALTER TABLE "MarketRequest" ADD CONSTRAINT "MarketRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketRequest" ADD CONSTRAINT "MarketRequest_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;
