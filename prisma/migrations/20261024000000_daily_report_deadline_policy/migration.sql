-- Daily Report deadline policy + late-submission approval (additive).
-- 1) A persisted ROLLOUT CUTOFF: Daily Plans first submitted at or after `effectiveAt` follow the new policy; earlier plans keep the previous rules. It is set to the moment this
--    migration is applied (the deployment time) and can be changed only deliberately in the database.
CREATE TABLE "DailyReportRollout" (
  "id" TEXT NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyReportRollout_pkey" PRIMARY KEY ("id")
);
INSERT INTO "DailyReportRollout" ("id", "effectiveAt") VALUES ('SO_MIDNIGHT', CURRENT_TIMESTAMP);

-- 2) The policy that applies to ONE covered reporting day (written when the day's plan is first submitted; never changed afterwards, so later deployments or role changes
--    cannot move its deadline). Days without a row follow the previous rules (noon of the next day).
CREATE TABLE "DailyReportPolicy" (
  "id" TEXT NOT NULL,
  "officerId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "version" TEXT NOT NULL,
  "deadline" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyReportPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyReportPolicy_version_chk" CHECK ("version" IN ('SO_MIDNIGHT'))
);
CREATE UNIQUE INDEX "DailyReportPolicy_officer_date_key" ON "DailyReportPolicy"("officerId", "workDate");
ALTER TABLE "DailyReportPolicy" ADD CONSTRAINT "DailyReportPolicy_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) Late Report Submission requests. PENDING → APPROVED | REJECTED (one decision, atomically); APPROVED → COMPLETED when the report is finally submitted. History is kept: a rejected
--    request may be followed by a new one. At most ONE open (PENDING or APPROVED) request exists per officer and report date.
CREATE TABLE "LateReportRequest" (
  "id" TEXT NOT NULL,
  "officerId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "deadline" TIMESTAMPTZ(3) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedByName" TEXT,
  "decidedByRole" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LateReportRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LateReportRequest_status_chk" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED')),
  CONSTRAINT "LateReportRequest_shape_chk" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "completedAt" IS NULL) OR
    ("status" = 'REJECTED' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "decisionReason" IS NOT NULL AND length(btrim("decisionReason")) > 0 AND "completedAt" IS NULL) OR
    ("status" = 'COMPLETED' AND "decidedAt" IS NOT NULL AND "completedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "LateReportRequest_one_open_key" ON "LateReportRequest"("officerId", "workDate") WHERE "status" IN ('PENDING', 'APPROVED');
CREATE UNIQUE INDEX "LateReportRequest_one_completed_key" ON "LateReportRequest"("officerId", "workDate") WHERE "status" = 'COMPLETED';
CREATE INDEX "LateReportRequest_status_requestedAt_idx" ON "LateReportRequest"("status", "requestedAt");
CREATE INDEX "LateReportRequest_officer_date_idx" ON "LateReportRequest"("officerId", "workDate");
ALTER TABLE "LateReportRequest" ADD CONSTRAINT "LateReportRequest_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
