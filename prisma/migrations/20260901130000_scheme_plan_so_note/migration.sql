-- Optional per-dealer Sales Officer note on a scheme plan. Additive & nullable — existing rows are unaffected.
ALTER TABLE "DealerSchemePlan" ADD COLUMN "soNote" TEXT;
