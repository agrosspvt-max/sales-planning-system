-- Admin manual lock/unlock overrides for recovery-plan business weeks. A row explicitly sets a week's
-- editability and takes priority over automatic date-based locking; no row = automatic behaviour.
CREATE TABLE "RecoveryWeekLock" (
  "id"             TEXT NOT NULL,
  "recoveryPlanId" TEXT NOT NULL,
  "weekNo"         INTEGER NOT NULL,
  "locked"         BOOLEAN NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecoveryWeekLock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryWeekLock_recoveryPlanId_weekNo_key" ON "RecoveryWeekLock"("recoveryPlanId", "weekNo");
CREATE INDEX "RecoveryWeekLock_recoveryPlanId_idx" ON "RecoveryWeekLock"("recoveryPlanId");

ALTER TABLE "RecoveryWeekLock"
  ADD CONSTRAINT "RecoveryWeekLock_recoveryPlanId_fkey"
  FOREIGN KEY ("recoveryPlanId") REFERENCES "RecoveryPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
