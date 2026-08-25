-- Part E Phase 4: admin override dates for the three-column verification screen.
ALTER TABLE "DealerSchemePlan"
  ADD COLUMN "adminConversionDate" TIMESTAMP(3),
  ADD COLUMN "adminBillingDate" TIMESTAMP(3);
