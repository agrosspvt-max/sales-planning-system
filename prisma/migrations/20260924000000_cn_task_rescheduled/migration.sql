-- Existing task dates were selected under the historical manual-scheduling flow. Mark them as rescheduled,
-- then use false for every new system-assigned next-working-day task.
ALTER TABLE "CnPaymentEvent"
ADD COLUMN "taskRescheduled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CnPaymentEvent"
ALTER COLUMN "taskRescheduled" SET DEFAULT false;
