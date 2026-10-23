-- CN calendar expiry + grace policy. ADDITIVE ONLY: no column is dropped or rewritten except by the documented backfill below.
--
-- Legacy conversion (documented decisions):
--  * Deadline: cnExpiryDate = IST acceptance date + cnExpiryDays - 1 (acceptance date was Day 1) — the EXACT existing deadline, no day added or removed.
--  * Grace: policy-governed legacy CNs (PAYMENT_V1, reason PAYMENT_PENDING, still Accepted / Not Posted) receive the default 5 grace days and cycle 1.
--  * Overdue legacy CNs are NOT classified here. The first read / mutation / scheduled reconciliation applies the normal rules (Grace, then Expired, with the
--    true boundary as effectiveAt and a "legacy deadline" note). No event is written by this migration and no actor or authorization is invented.
--  * Not governed (cnPolicyStage stays NULL): rows without acceptedAt or cnExpiryDays, reason OTHER, legacy non-payment-tracked tasks, direct-posted and
--    posted / returned-from-ledger rows (a return now requires an admin-chosen expiry, which starts a new cycle). Their cnExpiryDate is informational.
ALTER TABLE "CnRequest"
  ADD COLUMN "cnExpiryDate" DATE,
  ADD COLUMN "cnGraceDays" INTEGER,
  ADD COLUMN "cnPolicyStage" TEXT,
  ADD COLUMN "cnPolicyCycle" INTEGER NOT NULL DEFAULT 0;

UPDATE "CnRequest"
-- "acceptedAt" is a timestamp WITHOUT time zone holding UTC: label it UTC first, then read the calendar date in IST.
SET "cnExpiryDate" = ((("acceptedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date + ("cnExpiryDays" - 1))
WHERE "acceptedAt" IS NOT NULL AND "cnExpiryDays" IS NOT NULL AND "cnExpiryDays" > 0;

UPDATE "CnRequest"
SET "cnGraceDays" = 5, "cnPolicyStage" = 'WORKING', "cnPolicyCycle" = 1
WHERE "cnExpiryDate" IS NOT NULL AND "paymentTrackingMode" = 'PAYMENT_V1' AND "acceptanceReason" = 'PAYMENT_PENDING'
  AND "status" = 'ACCEPTED_NOT_POSTED';

ALTER TABLE "CnRequest"
  ADD CONSTRAINT "CnRequest_cnGraceDays_positive" CHECK ("cnGraceDays" IS NULL OR "cnGraceDays" > 0),
  ADD CONSTRAINT "CnRequest_cnPolicyStage_valid" CHECK ("cnPolicyStage" IS NULL OR "cnPolicyStage" IN ('WORKING', 'GRACE', 'EXPIRED'));

CREATE TABLE "CnExpiryEvent" (
  "id" TEXT NOT NULL,
  "cnRequestId" TEXT NOT NULL,
  "cycleNo" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT,
  "actorDesignation" TEXT,
  "expiryDate" DATE,
  "previousExpiryDate" DATE,
  "graceDays" INTEGER,
  "reason" TEXT,
  "authorizedBy" TEXT,
  "note" TEXT,
  CONSTRAINT "CnExpiryEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CnExpiryEvent_kind_valid" CHECK ("kind" IN ('POLICY_SET', 'ENTERED_GRACE', 'EXPIRED', 'REOPENED', 'RETURNED')),
  CONSTRAINT "CnExpiryEvent_reopen_fields" CHECK ("kind" <> 'REOPENED' OR ("actorId" IS NOT NULL AND btrim(coalesce("reason", '')) <> '' AND btrim(coalesce("authorizedBy", '')) <> '' AND "expiryDate" IS NOT NULL))
);
CREATE UNIQUE INDEX "CnExpiryEvent_cnRequestId_cycleNo_kind_key" ON "CnExpiryEvent"("cnRequestId", "cycleNo", "kind");
CREATE INDEX "CnExpiryEvent_cnRequestId_effectiveAt_idx" ON "CnExpiryEvent"("cnRequestId", "effectiveAt");
CREATE INDEX "CnRequest_cnPolicyStage_cnExpiryDate_idx" ON "CnRequest"("cnPolicyStage", "cnExpiryDate");
ALTER TABLE "CnExpiryEvent" ADD CONSTRAINT "CnExpiryEvent_cnRequestId_fkey" FOREIGN KEY ("cnRequestId") REFERENCES "CnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CnExpiryEvent" ADD CONSTRAINT "CnExpiryEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
