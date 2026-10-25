-- Dealer-based Dealer Visits (Daily Plan → Visits). Additive only: two nullable columns, no data is touched or backfilled.
--   "followUpType": Sales / Recovery manual entries — VISIT or TELEPHONIC. NULL for every existing row and for automatic / calendar task rows (nothing is invented).
--                   On a day's SUMMARY row the value DERIVED marks that its "dealerVisits" count is derived from the dealer rows.
--   "purpose":      the compulsory purpose of a manually added Relationship visit (rows of the new section value 'RELATIONSHIP'; rowKey = dealer id).
-- Legacy numeric Dealer Visits plans and reports stay exactly as stored.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "followUpType" TEXT;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "purpose" TEXT;
ALTER TABLE "DailyWorkEntry" ADD CONSTRAINT "DailyWorkEntry_followUpType_check" CHECK ("followUpType" IS NULL OR "followUpType" IN ('VISIT', 'TELEPHONIC', 'DERIVED'));
