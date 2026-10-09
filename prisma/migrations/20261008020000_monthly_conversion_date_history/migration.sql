-- Monthly Planning: append-only history of Conversion Date (PartyMonthlyPlan.planDate) changes by the SO and by Admin.
CREATE TABLE "PartyMonthlyDateChange" (
  "id" TEXT NOT NULL,
  "monthlyPlanId" TEXT NOT NULL,
  "previousDate" DATE,
  "newDate" DATE,
  "byAdmin" BOOLEAN NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartyMonthlyDateChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartyMonthlyDateChange_monthlyPlanId_createdAt_idx" ON "PartyMonthlyDateChange"("monthlyPlanId", "createdAt");
ALTER TABLE "PartyMonthlyDateChange" ADD CONSTRAINT "PartyMonthlyDateChange_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "PartyMonthlyPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "party_monthly_date_change_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PartyMonthlyDateChange is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PartyMonthlyDateChange_no_update" BEFORE UPDATE ON "PartyMonthlyDateChange" FOR EACH ROW EXECUTE FUNCTION "party_monthly_date_change_append_only"();
CREATE TRIGGER "PartyMonthlyDateChange_no_delete" BEFORE DELETE ON "PartyMonthlyDateChange" FOR EACH ROW EXECUTE FUNCTION "party_monthly_date_change_append_only"();
