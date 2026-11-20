ALTER TABLE "TallyDaybookJob" ADD COLUMN "manifest" JSONB;

CREATE TABLE "TallyDaybookChunk" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    CONSTRAINT "TallyDaybookChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TallyDaybookChunk_jobId_sequence_key" ON "TallyDaybookChunk"("jobId", "sequence");

ALTER TABLE "TallyDaybookChunk" ADD CONSTRAINT "TallyDaybookChunk_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TallyDaybookJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
