-- Enforce at most one ACTIVE Regional Manager per group at the database level.
-- Partial unique index: only rows that are REGIONAL_MANAGER, have a group, and are not soft-deleted
-- participate, so multiple Sales Officers per group and unassigned/deleted RMs are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_rm_per_group"
  ON "User" ("groupId")
  WHERE "role" = 'REGIONAL_MANAGER' AND "groupId" IS NOT NULL AND "deletedAt" IS NULL;
