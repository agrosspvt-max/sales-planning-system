-- Party Planning (Phase 1): a minimal Sales Officer planning record with a Draft → Submit → Admin Approval
-- workflow. Additive only; no existing table/model is modified. appointmentDate is a pure DATE (no timezone).
-- status uses the app's plain-string convention: DRAFT | PENDING_APPROVAL | APPROVED | REJECTED.
CREATE TABLE "PartyPlan" (
  "id"              TEXT NOT NULL,
  "salesOfficerId"  TEXT NOT NULL,
  "partyName"       TEXT,
  "marketName"      TEXT,
  "appointmentDate" DATE,
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "remarks"         TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartyPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PartyPlan_salesOfficerId_idx" ON "PartyPlan" ("salesOfficerId");
CREATE INDEX "PartyPlan_status_idx" ON "PartyPlan" ("status");

ALTER TABLE "PartyPlan"
  ADD CONSTRAINT "PartyPlan_salesOfficerId_fkey"
  FOREIGN KEY ("salesOfficerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
