-- Daily Work — Sales Officer self-rating (1–10), captured at day-level Submit and stored on the day's SUMMARY row.
-- Additive and nullable so historical Daily Work submissions remain valid; no existing row is back-filled.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "selfRating" INTEGER;
