-- Additive only. Existing masters/plans keep legacy rounding and global-booking fallback.
ALTER TABLE "Scheme" ADD COLUMN "installmentBalance" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SchemeOption" ADD COLUMN "bookingAmount" DECIMAL(14,2);
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionBookingAmount" DECIMAL(14,2),
    ADD COLUMN "installmentBalance" BOOLEAN NOT NULL DEFAULT false;
