-- Monthly Planning: ONE operational status per market row (replaces the per-option status workflow in the UI) + its append-only history.
ALTER TABLE "PartyMonthlyPlan" ADD COLUMN "opStatus" TEXT NOT NULL DEFAULT 'NONE', ADD COLUMN "opStatusChangedAt" TIMESTAMP(3);
ALTER TABLE "PartyMonthlyDateChange" ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PartyMonthlyStatusEvent" (
  "id" TEXT NOT NULL,
  "monthlyPlanId" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL,
  "newStatus" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "remarks" TEXT,
  "sentInfo" JSONB,
  "receivedInfo" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartyMonthlyStatusEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartyMonthlyStatusEvent_monthlyPlanId_createdAt_idx" ON "PartyMonthlyStatusEvent"("monthlyPlanId", "createdAt");
ALTER TABLE "PartyMonthlyStatusEvent" ADD CONSTRAINT "PartyMonthlyStatusEvent_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "PartyMonthlyPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "party_monthly_status_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PartyMonthlyStatusEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PartyMonthlyStatusEvent_no_update" BEFORE UPDATE ON "PartyMonthlyStatusEvent" FOR EACH ROW EXECUTE FUNCTION "party_monthly_status_event_append_only"();
CREATE TRIGGER "PartyMonthlyStatusEvent_no_delete" BEFORE DELETE ON "PartyMonthlyStatusEvent" FOR EACH ROW EXECUTE FUNCTION "party_monthly_status_event_append_only"();

-- Safe default for historical rows: derive the row status from the furthest per-option status. The per-option tables and their timeline
-- (PartyMonthlyOption / PartyMonthlyEvent) are NOT modified or deleted — they remain as the historical record.
UPDATE "PartyMonthlyPlan" p SET
  "opStatus" = CASE
    WHEN EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" = 'APPOINTED') THEN 'APPOINTED'
    WHEN EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" = 'SD_BOUNCE') THEN 'SD_BOUNCE'
    WHEN EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" IN ('DOC_RECEIVED', 'SD_DELAYED_BY_SO')) THEN 'DOC_RECEIVED'
    WHEN EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" = 'DOC_SENT') THEN 'DOC_SENT'
    WHEN EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" = 'PART_REJECTED')
         AND NOT EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."partyName" IS NOT NULL AND o."status" <> 'PART_REJECTED') THEN 'REJECTED'
    ELSE 'NONE' END,
  "opStatusChangedAt" = (SELECT MAX(o."statusChangedAt") FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" <> 'PENDING')
WHERE EXISTS (SELECT 1 FROM "PartyMonthlyOption" o WHERE o."monthlyPlanId" = p."id" AND o."status" <> 'PENDING');
