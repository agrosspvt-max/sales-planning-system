-- Backfill group membership for Regional Managers that were configured through the legacy
-- RM Assignments flow (which recorded an RmAssignment row but never set User.groupId).
--
-- RM data scope and approval routing are now GROUP-based (User.groupId): an RM with no group sees no
-- approvals and their officers' plans route straight to the Super Admin. This sets each such RM's group
-- to the group of the officers they currently manage — but ONLY when that is unambiguous (all their
-- active officers share ONE group) and that group has no other active RM (one RM per group).

UPDATE "User" AS rm
SET "groupId" = sub.gid
FROM (
  SELECT ra."managerId"        AS mid,
         MIN(o."groupId")       AS gid,
         COUNT(DISTINCT o."groupId") AS ngroups
  FROM "RmAssignment" ra
  JOIN "User" o ON o.id = ra."officerId"
  WHERE ra."effectiveTo" IS NULL
    AND o."groupId" IS NOT NULL
  GROUP BY ra."managerId"
) AS sub
WHERE rm.id = sub.mid
  AND rm.role = 'REGIONAL_MANAGER'
  AND rm."groupId" IS NULL          -- never override an RM that already has a group
  AND sub.ngroups = 1               -- only when their managed officers are all in ONE group
  AND NOT EXISTS (                  -- respect one-RM-per-group
    SELECT 1 FROM "User" other
    WHERE other.role = 'REGIONAL_MANAGER'
      AND other."groupId" = sub.gid
      AND other."deletedAt" IS NULL
      AND other.id <> rm.id
  );
