-- Optional metadata on Recovery Daily Work rows. No backfill or historical changes.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "paymentMode" TEXT;
ALTER TABLE "DailyWorkEntry" ADD CONSTRAINT "DailyWorkEntry_paymentMode_check"
  CHECK ("paymentMode" IN ('CHEQUE', 'UPI', 'NEFT_RTGS', 'CASH'));
