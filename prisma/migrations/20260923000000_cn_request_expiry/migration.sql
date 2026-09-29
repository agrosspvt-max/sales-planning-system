-- Inclusive CN follow-up scheduling window selected by Admin for new Accepted, Not Posted requests.
-- Nullable so historical accepted requests keep their existing behavior without an invented expiry.
ALTER TABLE "CnRequest" ADD COLUMN "cnExpiryDays" INTEGER;
