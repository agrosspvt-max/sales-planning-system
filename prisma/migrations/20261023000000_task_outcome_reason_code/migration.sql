-- Structured abandonment reasons for Daily Report task outcomes (additive). A stable reason CODE is stored next to the optional "Other" explanation (`reason`).
-- Existing rows are untouched: committed abandonments keep their free-text reason and simply have no code (they are displayed as written, never mapped to a category).
ALTER TABLE "DailyTaskOutcome" ADD COLUMN "reasonCode" TEXT;

-- The permitted codes depend on the task's section (Sales: product unavailable / dealer refused / other; Recovery: no dues / other).
ALTER TABLE "DailyTaskOutcome" ADD CONSTRAINT "DailyTaskOutcome_reasonCode_chk" CHECK (
  "reasonCode" IS NULL OR
  ("section" = 'SALES' AND "reasonCode" IN ('PRODUCT_UNAVAILABLE', 'DEALER_REFUSED', 'OTHER')) OR
  ("section" = 'RECOVERY' AND "reasonCode" IN ('NO_DUES', 'OTHER')));

-- A committed abandonment is either a legacy free-text one (no code, explanation >= 20 characters), OTHER with its explanation (>= 20 characters) or a predefined reason with no text.
ALTER TABLE "DailyTaskOutcome" DROP CONSTRAINT "DailyTaskOutcome_committed_shape_chk";
ALTER TABLE "DailyTaskOutcome" ADD CONSTRAINT "DailyTaskOutcome_committed_shape_chk" CHECK ("state" = 'DRAFT' OR (
  ("outcome" = 'COMPLETED' AND "actualAmount" > 0 AND "nextDate" IS NULL AND "reason" IS NULL AND "reasonCode" IS NULL AND "committedAt" IS NOT NULL) OR
  ("outcome" = 'RESCHEDULED' AND "nextDate" IS NOT NULL AND "actualAmount" IS NULL AND "reason" IS NULL AND "reasonCode" IS NULL AND "committedAt" IS NOT NULL) OR
  ("outcome" = 'ABANDONED' AND "actualAmount" IS NULL AND "nextDate" IS NULL AND "committedAt" IS NOT NULL AND (
    ("reasonCode" IS NULL AND "reason" IS NOT NULL AND length(btrim("reason")) >= 20) OR
    ("reasonCode" = 'OTHER' AND "reason" IS NOT NULL AND length(btrim("reason")) >= 20) OR
    ("reasonCode" IN ('PRODUCT_UNAVAILABLE', 'DEALER_REFUSED', 'NO_DUES') AND "reason" IS NULL)))));
