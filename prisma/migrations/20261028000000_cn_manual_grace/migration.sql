-- Grace is now an explicit extension INCLUDED in cnExpiryDate. Preserve existing allowed deadlines.
-- Historical events remain unchanged; the conversion records its own system event without inventing an actor.
ALTER TABLE "CnExpiryEvent" ADD COLUMN "expiryIncludesGrace" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "requestKey" TEXT;
DROP INDEX "CnExpiryEvent_cnRequestId_cycleNo_kind_key";
CREATE UNIQUE INDEX "CnExpiryEvent_cnRequestId_cycleNo_kind_sequence_key" ON "CnExpiryEvent"("cnRequestId", "cycleNo", "kind", "sequence");
CREATE UNIQUE INDEX "CnExpiryEvent_requestKey_key" ON "CnExpiryEvent"("requestKey");
ALTER TABLE "CnExpiryEvent" DROP CONSTRAINT "CnExpiryEvent_kind_valid";
ALTER TABLE "CnExpiryEvent" ADD CONSTRAINT "CnExpiryEvent_kind_valid" CHECK ("kind" IN ('POLICY_SET', 'ENTERED_GRACE', 'EXPIRED', 'REOPENED', 'RETURNED', 'GRACE_GRANTED', 'GRACE_MIGRATED'));
ALTER TABLE "CnRequest" DROP CONSTRAINT "CnRequest_cnGraceDays_positive";
ALTER TABLE "CnRequest" ADD CONSTRAINT "CnRequest_cnGraceDays_positive" CHECK ("cnGraceDays" IS NULL OR "cnGraceDays" >= 0);
INSERT INTO "CnExpiryEvent" ("id", "cnRequestId", "cycleNo", "kind", "effectiveAt", "previousExpiryDate", "expiryDate", "graceDays", "note", "expiryIncludesGrace")
SELECT 'manual-grace-rollout:' || "id", "id", "cnPolicyCycle", 'GRACE_MIGRATED', CURRENT_TIMESTAMP, "cnExpiryDate", "cnExpiryDate" + "cnGraceDays", "cnGraceDays", 'Existing allowed deadline preserved; prior grace included in expiry date', true
FROM "CnRequest" WHERE "cnPolicyStage" IS NOT NULL AND "cnExpiryDate" IS NOT NULL AND "cnGraceDays" > 0;
UPDATE "CnRequest" SET "cnExpiryDate" = "cnExpiryDate" + "cnGraceDays", "cnPolicyStage" = CASE WHEN "cnPolicyStage" = 'EXPIRED' THEN 'EXPIRED' ELSE 'GRACE' END
WHERE "cnPolicyStage" IS NOT NULL AND "cnExpiryDate" IS NOT NULL AND "cnGraceDays" > 0;
