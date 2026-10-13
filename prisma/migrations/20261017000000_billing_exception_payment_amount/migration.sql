-- Promised recovery ("Payment") amount of a Billing Exception, stored separately from its billing amount. Additive: existing rows keep NULL (not rewritten); no task is regenerated.
ALTER TABLE "BillingException" ADD COLUMN "paymentAmount" DECIMAL(14,2);

-- A promised amount is positive, and only a "Yes" payment condition can carry one (legacy Yes rows may have none).
ALTER TABLE "BillingException" ADD CONSTRAINT "BillingException_paymentAmount_check"
  CHECK ("paymentAmount" IS NULL OR ("paymentAmount" > 0 AND "paymentCondition" IS TRUE));
