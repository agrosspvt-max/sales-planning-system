-- Durable CN Auto Task -> Daily Work materialization links.
-- Contributions are stored separately so rescheduling can reverse exactly one task without changing
-- the officer's manual Recovery plan amount or another task's contribution.

ALTER TABLE "CnPaymentEvent"
  ADD COLUMN "dailyWorkEntryId" TEXT,
  ADD COLUMN "dailyWorkContribution" DECIMAL(14,2);

ALTER TABLE "CnRequest"
  ADD COLUMN "legacyDailyWorkEntryId" TEXT,
  ADD COLUMN "legacyDailyWorkContribution" DECIMAL(14,2);

CREATE INDEX "CnPaymentEvent_dailyWorkEntryId_idx" ON "CnPaymentEvent"("dailyWorkEntryId");
CREATE INDEX "CnRequest_legacyDailyWorkEntryId_idx" ON "CnRequest"("legacyDailyWorkEntryId");

ALTER TABLE "CnPaymentEvent"
  ADD CONSTRAINT "CnPaymentEvent_dailyWorkEntryId_fkey"
  FOREIGN KEY ("dailyWorkEntryId") REFERENCES "DailyWorkEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CnRequest"
  ADD CONSTRAINT "CnRequest_legacyDailyWorkEntryId_fkey"
  FOREIGN KEY ("legacyDailyWorkEntryId") REFERENCES "DailyWorkEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
