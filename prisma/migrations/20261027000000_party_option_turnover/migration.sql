-- Tentative turnover category per candidate party option. ADDITIVE: one nullable column. Existing rows keep NULL ("not recorded") — no category is ever guessed.
ALTER TABLE "PartyMonthlyOption" ADD COLUMN "turnoverCategory" TEXT;
-- Only the five stable codes, and only for an option that has a party (clearing a party clears its turnover).
ALTER TABLE "PartyMonthlyOption" ADD CONSTRAINT "PartyMonthlyOption_turnoverCategory_valid"
  CHECK ("turnoverCategory" IS NULL OR ("turnoverCategory" IN ('LT_50L', '50L_TO_1CR', '1CR_TO_2CR', '2CR_TO_4CR', 'GT_4CR') AND "partyName" IS NOT NULL));
