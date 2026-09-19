-- Booking-amount coverage: how many of a plan's proceeding scheme instances the Admin's Paid booking covers.
-- Additive and nullable → historical-safe: existing rows keep NULL (treated as "covers all schemes when Paid"
-- by the application). Coverage/validation/reporting only; it does NOT alter the SO conversion split, billing,
-- or installment generation.
ALTER TABLE "DealerSchemePlan" ADD COLUMN "adminBookingSchemeCount" INTEGER;
