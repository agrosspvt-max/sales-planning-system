ALTER TYPE "Role" ADD VALUE 'CUSTOM_ADMIN';
ALTER TABLE "User" ADD COLUMN "designation" TEXT,
                   ADD COLUMN "adminPermissions" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "AuditLog" ADD COLUMN "actorDesignation" TEXT;
ALTER TABLE "ApprovalAction" ADD COLUMN "actorDesignation" TEXT;
ALTER TABLE "CnPaymentEvent" ADD COLUMN "actorDesignation" TEXT;
CREATE TABLE "AccountManagementOwner" (
  "id" TEXT NOT NULL DEFAULT 'primary',
  "userId" TEXT NOT NULL,
  CONSTRAINT "AccountManagementOwner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountManagementOwner_singleton" CHECK ("id" = 'primary'),
  CONSTRAINT "AccountManagementOwner_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountManagementOwner_userId_key" ON "AccountManagementOwner"("userId");
-- Verified by SELECT-only production inspection: the sole existing Super Admin.
-- No username/name/creation-order inference. Other environments remain closed until an
-- independently verified owner is explicitly provisioned; no automatic fallback.
INSERT INTO "AccountManagementOwner" ("id", "userId")
SELECT 'primary', "id" FROM "User"
WHERE "id" = 'cms7ic4rj0000x82oim91juta' AND "role" = 'SUPER_ADMIN'
  AND "isActive" = true AND "deletedAt" IS NULL;
