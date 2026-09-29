-- Keep historical Approx Amount and Payment Status data intact while new SO requests stop collecting them.
ALTER TABLE "CnRequest" ALTER COLUMN "paymentStatus" DROP NOT NULL;

-- Actual ledger amount is independent from the historical approximate amount.
ALTER TABLE "CnRequest" ADD COLUMN "postedAmount" DECIMAL(14,2);
