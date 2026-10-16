-- Task rescheduling history: one IMMUTABLE row per genuine date change (previous → new, who, when, optional reason), written in the same transaction as the change.
CREATE TABLE "TaskRescheduleEvent" (
  "id" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "previousDate" DATE NOT NULL,
  "newDate" DATE NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskRescheduleEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskRescheduleEvent_sourceType_chk" CHECK ("sourceType" IN ('BILLING_EXCEPTION', 'CN_PAYMENT', 'CN_LEGACY', 'CALENDAR_ENTRY')),
  CONSTRAINT "TaskRescheduleEvent_moved_chk" CHECK ("previousDate" <> "newDate")
);
CREATE INDEX "TaskRescheduleEvent_source_idx" ON "TaskRescheduleEvent"("sourceType", "sourceId", "createdAt");
CREATE INDEX "TaskRescheduleEvent_owner_idx" ON "TaskRescheduleEvent"("ownerId", "createdAt");
CREATE INDEX "TaskRescheduleEvent_createdAt_idx" ON "TaskRescheduleEvent"("createdAt");
CREATE INDEX "TaskRescheduleEvent_previousDate_idx" ON "TaskRescheduleEvent"("previousDate");
CREATE INDEX "TaskRescheduleEvent_newDate_idx" ON "TaskRescheduleEvent"("newDate");

CREATE FUNCTION "task_reschedule_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TaskRescheduleEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TaskRescheduleEvent_no_update" BEFORE UPDATE ON "TaskRescheduleEvent" FOR EACH ROW EXECUTE FUNCTION "task_reschedule_event_append_only"();
CREATE TRIGGER "TaskRescheduleEvent_no_delete" BEFORE DELETE ON "TaskRescheduleEvent" FOR EACH ROW EXECUTE FUNCTION "task_reschedule_event_append_only"();

-- Tasks that were moved BEFORE history was recorded keep an honest marker ("moved at least once, the details were not retained"): never a verified zero, never an invented move.
--   Billing Exception tasks: the existing `rescheduled` flag is exact evidence of ≥ 1 move.
--   CN Recovery tasks: the `taskRescheduled` flag is also set when an SO picks a follow-up date, so it only proves the date may have been chosen / changed — also a gap.
--   Legacy CN requests carry no flag at all: their schedule history is unknown.
ALTER TABLE "BillingExceptionTask" ADD COLUMN "rescheduleHistoryGap" BOOLEAN NOT NULL DEFAULT false;
UPDATE "BillingExceptionTask" SET "rescheduleHistoryGap" = true WHERE "rescheduled" = true;
ALTER TABLE "CnPaymentEvent" ADD COLUMN "rescheduleHistoryGap" BOOLEAN NOT NULL DEFAULT false;
UPDATE "CnPaymentEvent" SET "rescheduleHistoryGap" = true WHERE "taskRescheduled" = true;
ALTER TABLE "CnRequest" ADD COLUMN "rescheduleHistoryGap" BOOLEAN NOT NULL DEFAULT false;
UPDATE "CnRequest" SET "rescheduleHistoryGap" = true WHERE "paymentTrackingMode" IS NULL AND "taskDate" IS NOT NULL;
