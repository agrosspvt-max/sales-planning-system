-- Daily Report → Sales / Recovery task OUTCOMES: Completed (positive actual) | Not Completed — Reschedule (future date) | Abandon (reason). One row per identifiable TASK inside a
-- reported Daily Work row (a dealer row can carry several source tasks). Additive: no existing data is changed, historical reports keep their (possibly zero) actuals.
CREATE TABLE "DailyTaskOutcome" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "unitType" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "officerId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "section" TEXT NOT NULL,
  "plannedAmount" DECIMAL(14,2) NOT NULL,
  "outcome" TEXT,
  "actualAmount" DECIMAL(14,2),
  "nextDate" DATE,
  "reason" TEXT,
  "state" TEXT NOT NULL DEFAULT 'DRAFT',
  "committedAt" TIMESTAMP(3),
  "committedById" TEXT,
  "committedByName" TEXT,
  "continuedAsType" TEXT,
  "continuedAsId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyTaskOutcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyTaskOutcome_unitType_chk" CHECK ("unitType" IN ('BILLING_EXCEPTION', 'CN_PAYMENT', 'CN_LEGACY', 'CALENDAR_ENTRY', 'MANUAL_ROW')),
  CONSTRAINT "DailyTaskOutcome_outcome_chk" CHECK ("outcome" IS NULL OR "outcome" IN ('COMPLETED', 'RESCHEDULED', 'ABANDONED')),
  CONSTRAINT "DailyTaskOutcome_state_chk" CHECK ("state" IN ('DRAFT', 'COMMITTED')),
  -- A COMMITTED outcome is complete and carries only the fields of its own outcome (a draft may be incomplete).
  CONSTRAINT "DailyTaskOutcome_committed_shape_chk" CHECK ("state" = 'DRAFT' OR (
    ("outcome" = 'COMPLETED' AND "actualAmount" > 0 AND "nextDate" IS NULL AND "reason" IS NULL AND "committedAt" IS NOT NULL) OR
    ("outcome" = 'RESCHEDULED' AND "nextDate" IS NOT NULL AND "actualAmount" IS NULL AND "reason" IS NULL AND "committedAt" IS NOT NULL) OR
    ("outcome" = 'ABANDONED' AND "reason" IS NOT NULL AND length(btrim("reason")) >= 20 AND "actualAmount" IS NULL AND "nextDate" IS NULL AND "committedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "DailyTaskOutcome_entry_unit_key" ON "DailyTaskOutcome"("entryId", "unitType", "unitId");
CREATE INDEX "DailyTaskOutcome_unit_idx" ON "DailyTaskOutcome"("unitType", "unitId");
CREATE INDEX "DailyTaskOutcome_officer_date_idx" ON "DailyTaskOutcome"("officerId", "workDate");
CREATE INDEX "DailyTaskOutcome_committedAt_idx" ON "DailyTaskOutcome"("committedAt");
ALTER TABLE "DailyTaskOutcome" ADD CONSTRAINT "DailyTaskOutcome_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "DailyWorkEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A committed outcome is historical evidence: it can never be changed or removed.
CREATE FUNCTION "daily_task_outcome_committed_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" = 'COMMITTED' THEN RAISE EXCEPTION 'A committed task outcome is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DailyTaskOutcome_immutable_upd" BEFORE UPDATE ON "DailyTaskOutcome" FOR EACH ROW EXECUTE FUNCTION "daily_task_outcome_committed_immutable"();
CREATE TRIGGER "DailyTaskOutcome_immutable_del" BEFORE DELETE ON "DailyTaskOutcome" FOR EACH ROW EXECUTE FUNCTION "daily_task_outcome_committed_immutable"();

-- Abandonment stops future scheduling of the SOURCE task (nothing is written off or paid): one nullable marker per source that has no status of its own.
-- (A CN payment task uses its existing taskStatus, which becomes 'ABANDONED'.)
ALTER TABLE "BillingExceptionTask" ADD COLUMN "abandonedAt" TIMESTAMP(3);
ALTER TABLE "CnRequest" ADD COLUMN "legacyTaskAbandonedAt" TIMESTAMP(3);
ALTER TABLE "CalendarEntry" ADD COLUMN "abandonedAt" TIMESTAMP(3);
