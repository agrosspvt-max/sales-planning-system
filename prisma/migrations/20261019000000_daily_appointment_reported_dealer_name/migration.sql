-- Daily Report → Dealer Appointment: the dealer name the officer REPORTS for an Appointed result. It is report information only
-- (never a Dealer Master record, never a Monthly Party Planning candidate name) and is kept apart from the legacy typed planning name.
-- Additive and nullable: existing rows are untouched.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "reportedDealerName" TEXT;
