ALTER TABLE "TallyDaybookDealerMonth"
    ADD COLUMN "liveRecovery" DECIMAL(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "srCr" DECIMAL(14,2) NOT NULL DEFAULT 0;
UPDATE "TallyDaybookDealerMonth" m SET "liveRecovery" =
    COALESCE((SELECT SUM(value::numeric) FROM jsonb_each_text(m."receiptDays")), 0);
UPDATE "TallyDaybookDealerMonth" m SET "srCr" = d."srCr"
    FROM "RecoveryPlanDealer" d
    WHERE d."dealerId" = m."dealerId" AND d."recoveryPlanId" = m."recoveryPlanId";
