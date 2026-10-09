-- Seasonal Planning no longer has a Party Name. The column is made OPTIONAL (not dropped) so every historical entry keeps its original value and
-- audit trail; new entries simply leave it NULL and no code reads it. (It can be dropped later in a separate, deliberate migration.)
ALTER TABLE "SeasonalPlan" ALTER COLUMN "partyName" DROP NOT NULL;
