-- Add report choices without inferring results or changing any existing plans / actual totals.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "dealerVisitResults" JSONB;
