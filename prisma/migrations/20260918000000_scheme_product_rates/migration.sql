-- Product-Quantity-Based schemes: per-product billing rates on the FIXED requirement products and the OPTIONS
-- eligible products. Additive + nullable → historical-safe; Value Based schemes leave them NULL. Rates are
-- snapshotted onto the dealer plan at conversion so later Scheme Master edits cannot change historical bills.
ALTER TABLE "SchemeRequirementProduct" ADD COLUMN "rateWithoutGST" DECIMAL(14,2);
ALTER TABLE "SchemeRequirementProduct" ADD COLUMN "rateWithGST"    DECIMAL(14,2);
ALTER TABLE "SchemeEligibleProduct"    ADD COLUMN "rateWithoutGST" DECIMAL(14,2);
ALTER TABLE "SchemeEligibleProduct"    ADD COLUMN "rateWithGST"    DECIMAL(14,2);
