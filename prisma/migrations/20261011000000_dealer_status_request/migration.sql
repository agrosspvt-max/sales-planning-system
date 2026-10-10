-- Dealer Status Change Requests (Territory Mapping). Additive only: one new table, no change to existing data.
CREATE TABLE "DealerStatusRequest" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "statusAtRequest" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedByRole" "Role" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerStatusRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DealerStatusRequest_status_createdAt_idx" ON "DealerStatusRequest"("status", "createdAt");
CREATE INDEX "DealerStatusRequest_dealerId_status_idx" ON "DealerStatusRequest"("dealerId", "status");
CREATE INDEX "DealerStatusRequest_requestedById_idx" ON "DealerStatusRequest"("requestedById");

-- At most ONE pending request per dealer (race-safe duplicate guard; Prisma cannot express a partial index).
CREATE UNIQUE INDEX "DealerStatusRequest_one_pending_per_dealer" ON "DealerStatusRequest"("dealerId") WHERE "status" = 'PENDING';

ALTER TABLE "DealerStatusRequest" ADD CONSTRAINT "DealerStatusRequest_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealerStatusRequest" ADD CONSTRAINT "DealerStatusRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealerStatusRequest" ADD CONSTRAINT "DealerStatusRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
