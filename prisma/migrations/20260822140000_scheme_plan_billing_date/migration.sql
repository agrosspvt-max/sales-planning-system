-- Expected Billing Date: when a dealer is expected to start billing for the scheme (draft planning).
ALTER TABLE "DealerSchemePlan" ADD COLUMN "expectedBillingDate" TIMESTAMP(3);
