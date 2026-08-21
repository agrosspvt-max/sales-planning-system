-- Credit Note (CN) Requests raised by Sales Officers. Workflow: SUBMITTED → ACCEPTED (RM) → APPROVED
-- (Admin); SUBMITTED → REJECTED; ACCEPTED → APPROVED. Admin may approve directly.
CREATE TABLE "CnRequest" (
  "id"             TEXT NOT NULL,
  "officerId"      TEXT NOT NULL,
  "dealerId"       TEXT NOT NULL,
  "cnType"         TEXT NOT NULL,
  "amount"         DECIMAL(14,2),
  "paymentStatus"  TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'SUBMITTED',
  "remarks"        TEXT,
  "actedByRmId"    TEXT,
  "actedByAdminId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CnRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CnRequest_officerId_idx" ON "CnRequest"("officerId");
CREATE INDEX "CnRequest_status_idx" ON "CnRequest"("status");

ALTER TABLE "CnRequest" ADD CONSTRAINT "CnRequest_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CnRequest" ADD CONSTRAINT "CnRequest_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
