-- Scheme Master maximum bill count for SO conversion.
-- Existing schemes retain the previous 1–5 behavior through the backward-compatible default of 5.
-- Existing DealerSchemeBill, DealerSchemeInstallment, and DealerSchemePlan rows are untouched.
ALTER TABLE "Scheme" ADD COLUMN "numberOfBills" INTEGER NOT NULL DEFAULT 5;

