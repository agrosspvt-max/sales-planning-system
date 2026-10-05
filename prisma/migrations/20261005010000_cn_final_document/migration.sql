-- Final CN document, uploaded when an Admin verifies a CN Working Shared request as Paid. Separate from the CN Working
-- document columns, which are never touched. All nullable; no backfill, so existing requests simply have no Final CN.
ALTER TABLE "CnRequest"
  ADD COLUMN "finalCnDocument" TEXT,
  ADD COLUMN "finalCnFileName" TEXT,
  ADD COLUMN "finalCnMimeType" TEXT,
  ADD COLUMN "finalCnFileSize" INTEGER,
  ADD COLUMN "finalCnUploadedById" TEXT,
  ADD COLUMN "finalCnUploadedAt" TIMESTAMP(3);
