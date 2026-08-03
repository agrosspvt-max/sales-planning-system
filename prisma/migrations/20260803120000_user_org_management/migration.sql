-- User & Organization Management: soft-delete + session invalidation + user groups.
-- Reuses the existing User/Dealer models; no parallel systems.

CREATE TABLE "UserGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserGroup_name_key" ON "UserGroup"("name");

ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "sessionValidAfter" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "groupId" TEXT;
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
CREATE INDEX "User_groupId_idx" ON "User"("groupId");
ALTER TABLE "User" ADD CONSTRAINT "User_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Dealer" ADD COLUMN "deletedAt" TIMESTAMP(3);
