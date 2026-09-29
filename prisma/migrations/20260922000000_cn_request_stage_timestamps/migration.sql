-- CN Request workflow-age timestamps. These nullable fields are additive and do not rewrite lifecycle states.
-- createdAt remains the authoritative submission time; updatedAt is deliberately never used for stage age.
ALTER TABLE "CnRequest"
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "postedAt"   TIMESTAMP(3);

-- Backfill only from exact CN workflow audit events. Missing audit evidence remains NULL rather than
-- fabricating a historical transition time from the generic CnRequest.updatedAt column.
UPDATE "CnRequest" AS request
SET "acceptedAt" = (
  SELECT MIN(audit."createdAt")
  FROM "AuditLog" AS audit
  WHERE audit."entity" = 'cnRequest'
    AND audit."entityId" = request."id"
    AND audit."summary" IN ('CN Request accepted by RM', 'CN Request accepted by Super Admin')
)
WHERE request."status" IN ('ACCEPTED_NOT_POSTED', 'POSTED_IN_LEDGER')
  AND EXISTS (
    SELECT 1 FROM "AuditLog" AS audit
    WHERE audit."entity" = 'cnRequest'
      AND audit."entityId" = request."id"
      AND audit."summary" IN ('CN Request accepted by RM', 'CN Request accepted by Super Admin')
  );

UPDATE "CnRequest" AS request
SET "rejectedAt" = (
  SELECT MIN(audit."createdAt")
  FROM "AuditLog" AS audit
  WHERE audit."entity" = 'cnRequest'
    AND audit."entityId" = request."id"
    AND audit."summary" IN ('CN Request rejected by RM', 'CN Request rejected by Super Admin')
)
WHERE request."status" = 'REJECTED'
  AND EXISTS (
    SELECT 1 FROM "AuditLog" AS audit
    WHERE audit."entity" = 'cnRequest'
      AND audit."entityId" = request."id"
      AND audit."summary" IN ('CN Request rejected by RM', 'CN Request rejected by Super Admin')
  );

UPDATE "CnRequest" AS request
SET "postedAt" = (
  SELECT MIN(audit."createdAt")
  FROM "AuditLog" AS audit
  WHERE audit."entity" = 'cnRequest'
    AND audit."entityId" = request."id"
    AND audit."summary" = 'CN Request marked as posted in ledger by Super Admin'
)
WHERE request."status" = 'POSTED_IN_LEDGER'
  AND EXISTS (
    SELECT 1 FROM "AuditLog" AS audit
    WHERE audit."entity" = 'cnRequest'
      AND audit."entityId" = request."id"
      AND audit."summary" = 'CN Request marked as posted in ledger by Super Admin'
  );

-- Historical compatibility: legacy ACCEPTED/APPROVED records display as Posted in Ledger. Use their exact
-- historical acceptance/final-approval audit time where present; otherwise postedAt intentionally stays NULL.
UPDATE "CnRequest" AS request
SET "postedAt" = (
  SELECT MIN(audit."createdAt")
  FROM "AuditLog" AS audit
  WHERE audit."entity" = 'cnRequest'
    AND audit."entityId" = request."id"
    AND (
      (request."status" = 'ACCEPTED' AND audit."summary" = 'CN Request accepted by RM')
      OR
      (request."status" = 'APPROVED' AND audit."summary" = 'CN Request approved by Super Admin')
    )
)
WHERE request."status" IN ('ACCEPTED', 'APPROVED')
  AND EXISTS (
    SELECT 1 FROM "AuditLog" AS audit
    WHERE audit."entity" = 'cnRequest'
      AND audit."entityId" = request."id"
      AND (
        (request."status" = 'ACCEPTED' AND audit."summary" = 'CN Request accepted by RM')
        OR
        (request."status" = 'APPROVED' AND audit."summary" = 'CN Request approved by Super Admin')
      )
  );
