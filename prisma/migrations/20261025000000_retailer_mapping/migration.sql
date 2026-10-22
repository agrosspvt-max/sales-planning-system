-- Retailer Mapping (additive). A Retailer is its OWN entity (never a Dealer); one retailer can be linked to many dealers.
-- A retailer-creation REQUEST keeps its submitted details and original dealer selection as history, whatever its outcome.
CREATE TABLE "RetailerRequest" (
  "id" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "requesterRole" TEXT NOT NULL,
  "retailerName" TEXT NOT NULL,
  "firmName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  -- The browser's one-per-form-open key: a double click or a retry of the SAME submission can never create a second request.
  "submissionKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decidedByName" TEXT,
  "decidedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "retailerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetailerRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetailerRequest_phone_chk" CHECK ("phone" ~ '^[0-9]{10}$'),
  CONSTRAINT "RetailerRequest_names_chk" CHECK (length(btrim("retailerName")) > 0 AND length(btrim("firmName")) > 0),
  CONSTRAINT "RetailerRequest_status_chk" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT "RetailerRequest_shape_chk" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "retailerId" IS NULL) OR
    ("status" = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "retailerId" IS NOT NULL) OR
    ("status" = 'REJECTED' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "retailerId" IS NULL AND "rejectionReason" IS NOT NULL AND length(btrim("rejectionReason")) > 0))
);
CREATE UNIQUE INDEX "RetailerRequest_submission_key" ON "RetailerRequest"("requesterId", "submissionKey");
CREATE INDEX "RetailerRequest_status_createdAt_idx" ON "RetailerRequest"("status", "createdAt");
CREATE INDEX "RetailerRequest_requester_idx" ON "RetailerRequest"("requesterId", "createdAt");
ALTER TABLE "RetailerRequest" ADD CONSTRAINT "RetailerRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The dealers the requester selected (the ORIGINAL selection, kept as history even if assignments change later).
CREATE TABLE "RetailerRequestDealer" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "dealerId" TEXT NOT NULL,
  "dealerName" TEXT NOT NULL,
  CONSTRAINT "RetailerRequestDealer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailerRequestDealer_request_dealer_key" ON "RetailerRequestDealer"("requestId", "dealerId");
CREATE INDEX "RetailerRequestDealer_dealerId_idx" ON "RetailerRequestDealer"("dealerId");
ALTER TABLE "RetailerRequestDealer" ADD CONSTRAINT "RetailerRequestDealer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RetailerRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailerRequestDealer" ADD CONSTRAINT "RetailerRequestDealer_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The approved retailer: ONE record, however many dealers it is linked to. Never merged automatically by name or phone.
CREATE TABLE "Retailer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "firmName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Retailer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Retailer_phone_chk" CHECK ("phone" ~ '^[0-9]{10}$')
);
CREATE UNIQUE INDEX "Retailer_requestId_key" ON "Retailer"("requestId");
ALTER TABLE "Retailer" ADD CONSTRAINT "Retailer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Retailer" ADD CONSTRAINT "Retailer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RetailerRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailerRequest" ADD CONSTRAINT "RetailerRequest_retailerId_fkey" FOREIGN KEY ("retailerId") REFERENCES "Retailer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RetailerDealerLink" (
  "id" TEXT NOT NULL,
  "retailerId" TEXT NOT NULL,
  "dealerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetailerDealerLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailerDealerLink_retailer_dealer_key" ON "RetailerDealerLink"("retailerId", "dealerId");
CREATE INDEX "RetailerDealerLink_dealerId_idx" ON "RetailerDealerLink"("dealerId");
ALTER TABLE "RetailerDealerLink" ADD CONSTRAINT "RetailerDealerLink_retailerId_fkey" FOREIGN KEY ("retailerId") REFERENCES "Retailer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailerDealerLink" ADD CONSTRAINT "RetailerDealerLink_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
