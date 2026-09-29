-- Daily Work: persist the explicit "No Plan" section decisions. One additive nullable column on the per-day
-- SUMMARY row (a CSV set of mandatory section names marked No Plan). FILLED/REMAINING remain derived from
-- real section data and are never stored. No existing row or column is modified.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "noPlanSections" TEXT;
