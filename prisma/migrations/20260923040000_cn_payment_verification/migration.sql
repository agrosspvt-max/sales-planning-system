-- Admin verification of the CN payment status. SO-reported statuses are provisional (unverified → gray pill);
-- Admin verification is authoritative (verified → green pill). An SO report resets it back to false.
-- Additive with a safe default; no historical row is backfilled or reinterpreted.
ALTER TABLE "CnRequest" ADD COLUMN "paymentVerified" BOOLEAN NOT NULL DEFAULT false;
