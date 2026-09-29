-- Structured CN Request rejection reasons. Both columns remain nullable so historical rejected requests
-- stay readable without inventing a reason that the old immediate-reject flow never captured.
ALTER TABLE "CnRequest"
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "rejectionReasonDetails" TEXT;
