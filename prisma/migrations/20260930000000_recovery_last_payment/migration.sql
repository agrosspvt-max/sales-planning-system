-- "Last Payment" (Recovery Planning Month View): the latest Day Book RECEIPT voucher per dealer — its date
-- and that same row's Credit Amount. Populated by the existing Day Book upload; informational only, it never
-- affects any recovery calculation. Nullable, no default (a dealer with no Receipt shows "—").

ALTER TABLE "RecoveryPlanDealer"
  ADD COLUMN "lastReceiptDate" DATE,
  ADD COLUMN "lastReceiptAmount" DECIMAL(14,2);
