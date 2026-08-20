-- Free-text detail for a recovery dealer's No-Plan reason, captured only when the reason is "Other".
ALTER TABLE "RecoveryPlanDealer" ADD COLUMN "noPlanReasonDetail" TEXT;
