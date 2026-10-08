-- Party Planning · Monthly Planning (Phase 3). Purely additive: three new tables. Season, SeasonMonth, Market, SeasonalPlan, the Sales
-- Planning "MonthlyPlan" and every other existing table are untouched. Requires the Territory Mapping (20261007000000) and
-- Seasonal Planning (20261007010000) migrations first.

CREATE TABLE "PartyMonthlyPlan" (
    "id" TEXT NOT NULL,
    "seasonalPlanId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "seasonMonthId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketNameAtPlanning" TEXT NOT NULL,
    "marketPotentialAtPlanning" TEXT,
    "planDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PartyMonthlyPlan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PartyMonthlyPlan_potential_check" CHECK ("marketPotentialAtPlanning" IS NULL OR "marketPotentialAtPlanning" IN ('A', 'B', 'C'))
);
CREATE UNIQUE INDEX "PartyMonthlyPlan_seasonalPlanId_seasonMonthId_key" ON "PartyMonthlyPlan"("seasonalPlanId", "seasonMonthId");
CREATE INDEX "PartyMonthlyPlan_seasonId_idx" ON "PartyMonthlyPlan"("seasonId");
CREATE INDEX "PartyMonthlyPlan_ownerId_idx" ON "PartyMonthlyPlan"("ownerId");
CREATE INDEX "PartyMonthlyPlan_seasonMonthId_idx" ON "PartyMonthlyPlan"("seasonMonthId");
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_seasonalPlanId_fkey" FOREIGN KEY ("seasonalPlanId") REFERENCES "SeasonalPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_seasonMonthId_fkey" FOREIGN KEY ("seasonMonthId") REFERENCES "SeasonMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PartyMonthlyOption" (
    "id" TEXT NOT NULL,
    "monthlyPlanId" TEXT NOT NULL,
    "optionNo" INTEGER NOT NULL,
    "partyName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentInfo" JSONB,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedInfo" JSONB,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "actualPartyName" TEXT,
    "actualAppointedOn" DATE,
    "rejectionReason" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PartyMonthlyOption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PartyMonthlyOption_optionNo_check" CHECK ("optionNo" IN (1, 2)),
    CONSTRAINT "PartyMonthlyOption_status_check" CHECK ("status" IN ('PENDING', 'DOC_SENT', 'DOC_RECEIVED', 'SD_DELAYED_BY_SO', 'SD_BOUNCE', 'APPOINTED', 'PART_REJECTED')),
    -- Actual appointment data exists only for an APPOINTED option; a rejection reason only for a PART_REJECTED one.
    CONSTRAINT "PartyMonthlyOption_appointed_check" CHECK (("actualPartyName" IS NULL AND "actualAppointedOn" IS NULL) OR "status" = 'APPOINTED'),
    CONSTRAINT "PartyMonthlyOption_rejected_check" CHECK ("rejectionReason" IS NULL OR "status" = 'PART_REJECTED')
);
CREATE UNIQUE INDEX "PartyMonthlyOption_monthlyPlanId_optionNo_key" ON "PartyMonthlyOption"("monthlyPlanId", "optionNo");
ALTER TABLE "PartyMonthlyOption" ADD CONSTRAINT "PartyMonthlyOption_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "PartyMonthlyPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PartyMonthlyEvent" (
    "id" TEXT NOT NULL,
    "monthlyPlanId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartyMonthlyEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PartyMonthlyEvent_type_check" CHECK ("eventType" IN ('PLAN_CREATED', 'PARTY_UPDATED', 'STATUS_CHANGED'))
);
CREATE INDEX "PartyMonthlyEvent_monthlyPlanId_idx" ON "PartyMonthlyEvent"("monthlyPlanId");
CREATE INDEX "PartyMonthlyEvent_optionId_createdAt_idx" ON "PartyMonthlyEvent"("optionId", "createdAt");
ALTER TABLE "PartyMonthlyEvent" ADD CONSTRAINT "PartyMonthlyEvent_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "PartyMonthlyPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyEvent" ADD CONSTRAINT "PartyMonthlyEvent_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PartyMonthlyOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: the timeline can be INSERTed into, never rewritten or erased.
CREATE FUNCTION "party_monthly_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PartyMonthlyEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PartyMonthlyEvent_no_update" BEFORE UPDATE ON "PartyMonthlyEvent" FOR EACH ROW EXECUTE FUNCTION "party_monthly_event_append_only"();
CREATE TRIGGER "PartyMonthlyEvent_no_delete" BEFORE DELETE ON "PartyMonthlyEvent" FOR EACH ROW EXECUTE FUNCTION "party_monthly_event_append_only"();
