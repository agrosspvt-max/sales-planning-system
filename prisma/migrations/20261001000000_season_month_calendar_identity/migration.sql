-- Additive only: no IDs, statuses, planning, actuals, or financial rows are changed.
ALTER TABLE "SeasonMonth" ADD COLUMN "calendarMonth" INTEGER, ADD COLUMN "calendarYear" INTEGER;
ALTER TABLE "SeasonMonth" ADD CONSTRAINT "SeasonMonth_calendar_identity_check" CHECK (
  ("calendarMonth" IS NULL AND "calendarYear" IS NULL) OR
  ("calendarMonth" BETWEEN 1 AND 12 AND "calendarYear" BETWEEN 2000 AND 2100
   AND "calendarMonth" IS NOT NULL AND "calendarYear" IS NOT NULL)
);
-- Only backfill whole seasons whose existing names/orders agree with their explicit
-- anchor. Arbitrary extension names, missing anchors, gaps and >12-month legacy
-- layouts remain NULL and are flagged, never guessed from Season.year/cutoff dates.
WITH candidates AS (
  SELECT m."id", m."seasonId", m."order", m."name",
    s."startMonth", s."startYear",
    s."startYear" * 12 + s."startMonth" - 1 + m."order" - 1 AS idx
  FROM "SeasonMonth" m JOIN "Season" s ON s."id" = m."seasonId"
), safe_seasons AS (
  SELECT "seasonId" FROM candidates GROUP BY "seasonId"
  HAVING COUNT(*) BETWEEN 1 AND 12 AND MIN("order") = 1 AND MAX("order") = COUNT(*)
    AND BOOL_AND(COALESCE("startMonth" BETWEEN 1 AND 12 AND "startYear" BETWEEN 2000 AND 2100
      AND FLOOR(idx::numeric / 12) BETWEEN 2000 AND 2100
      AND LOWER(TRIM("name")) = LOWER((ARRAY['January','February','March','April','May','June',
        'July','August','September','October','November','December'])[MOD(idx,12)+1]), FALSE))
)
UPDATE "SeasonMonth" m SET "calendarMonth" = MOD(c.idx,12)+1,
  "calendarYear" = FLOOR(c.idx::numeric/12)::integer
FROM candidates c JOIN safe_seasons s ON s."seasonId" = c."seasonId" WHERE m."id" = c."id";
CREATE UNIQUE INDEX "SeasonMonth_seasonId_calendarYear_calendarMonth_key"
  ON "SeasonMonth"("seasonId", "calendarYear", "calendarMonth");
DO $$ DECLARE unresolved text; BEGIN
  SELECT STRING_AGG("id", ', ' ORDER BY "id") INTO unresolved FROM "SeasonMonth" WHERE "calendarMonth" IS NULL;
  IF unresolved IS NOT NULL THEN
    RAISE WARNING 'SeasonMonths need explicit calendar review (preserved unchanged): %', unresolved;
  END IF;
END $$;
