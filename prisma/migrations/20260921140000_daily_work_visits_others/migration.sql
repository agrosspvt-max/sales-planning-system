-- Daily Work: add the Visits + Others sections. These live on ONE per-day DailyWorkEntry row (section
-- 'SUMMARY', rowKey 'SUMMARY'), so no new table is created. Purely additive — three nullable columns; no
-- existing row or section is modified.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "dealerVisits"   INTEGER;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "newPartyVisits" INTEGER;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "others"         TEXT;
