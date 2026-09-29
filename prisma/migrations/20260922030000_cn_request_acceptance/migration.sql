-- Admin CN Request acceptance metadata and the required CN working document. All fields are nullable so
-- existing accepted/history rows remain readable without inventing a reason or attachment.
ALTER TABLE "CnRequest"
  ADD COLUMN "acceptanceReason" TEXT,
  ADD COLUMN "acceptanceReasonDetails" TEXT,
  ADD COLUMN "cnWorkingDocument" TEXT,
  ADD COLUMN "cnWorkingFileName" TEXT,
  ADD COLUMN "cnWorkingMimeType" TEXT,
  ADD COLUMN "cnWorkingFileSize" INTEGER,
  ADD COLUMN "cnWorkingUploadedById" TEXT,
  ADD COLUMN "cnWorkingUploadedAt" TIMESTAMP(3);
