-- CN follow-up task: the SO-chosen Daily Work date for an "Accepted, Not Posted" CN Request. NULL means the
-- task is pending/unscheduled. Additive + nullable, so existing rows are unaffected (they have no task date).
ALTER TABLE "CnRequest" ADD COLUMN "taskDate" DATE;

-- Fast lookup of one officer's CN tasks scheduled on a given Daily Work date.
CREATE INDEX "CnRequest_officerId_taskDate_idx" ON "CnRequest" ("officerId", "taskDate");
