-- Billing Exception: billing amount + optional payment condition, and its Daily Work → Recovery task. Additive only; existing exceptions keep NULL (nothing is invented or backfilled,
-- no task is generated retrospectively). Nothing is applied automatically.
ALTER TABLE "BillingException" ADD COLUMN "billingAmount" DECIMAL(14,2);
ALTER TABLE "BillingException" ADD COLUMN "paymentCondition" BOOLEAN;
ALTER TABLE "BillingException" ADD COLUMN "paymentDate" DATE;

-- Shape rules enforced by the database as well as the service: Yes ⇒ a date; No / legacy ⇒ no date; a recorded condition always has a positive amount.
ALTER TABLE "BillingException" ADD CONSTRAINT "BillingException_payment_condition_chk" CHECK (
  ("paymentCondition" IS NULL AND "paymentDate" IS NULL)
  OR ("paymentCondition" IS FALSE AND "paymentDate" IS NULL AND "billingAmount" > 0)
  OR ("paymentCondition" IS TRUE AND "paymentDate" IS NOT NULL AND "billingAmount" > 0)
);

CREATE TABLE "BillingExceptionTask" (
    "id" TEXT NOT NULL,
    "billingExceptionId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "promisedDate" DATE NOT NULL,
    "taskDate" DATE NOT NULL,
    "rescheduled" BOOLEAN NOT NULL DEFAULT false,
    "dailyWorkEntryId" TEXT,
    "dailyWorkContribution" DECIMAL(14,2),
    "dailyWorkConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "materializedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingExceptionTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingExceptionTask_amount_chk" CHECK ("amount" > 0)
);

-- At most ONE task per originating exception.
CREATE UNIQUE INDEX "BillingExceptionTask_billingExceptionId_key" ON "BillingExceptionTask"("billingExceptionId");
CREATE INDEX "BillingExceptionTask_officerId_taskDate_idx" ON "BillingExceptionTask"("officerId", "taskDate");
CREATE INDEX "BillingExceptionTask_dealerId_idx" ON "BillingExceptionTask"("dealerId");
CREATE INDEX "BillingExceptionTask_dailyWorkEntryId_idx" ON "BillingExceptionTask"("dailyWorkEntryId");

ALTER TABLE "BillingExceptionTask" ADD CONSTRAINT "BillingExceptionTask_billingExceptionId_fkey" FOREIGN KEY ("billingExceptionId") REFERENCES "BillingException"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingExceptionTask" ADD CONSTRAINT "BillingExceptionTask_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingExceptionTask" ADD CONSTRAINT "BillingExceptionTask_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
