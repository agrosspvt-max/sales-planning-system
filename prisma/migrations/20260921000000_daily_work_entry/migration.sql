-- Daily Work Template (Sales + Recovery): a Sales Officer's per-dealer, per-section, per-day execution row.
-- Additive only; no existing table/model is modified. Stores ONLY daily-execution data (Today's Plan,
-- Today's Actual, type, optional scheme ref) — it never duplicates monthly plans, actual sales, recovery
-- plans/actuals, or the Scheme Master. `workDate` is a pure DATE (no timezone). status: DRAFT | SUBMITTED.
CREATE TABLE "DailyWorkEntry" (
  "id"            TEXT NOT NULL,
  "officerId"     TEXT NOT NULL,
  "dealerId"      TEXT NOT NULL,
  "workDate"      DATE NOT NULL,
  "section"       TEXT NOT NULL,
  "todaysPlan"    DECIMAL(14,2),
  "todaysActual"  DECIMAL(14,2),
  "entryType"     TEXT NOT NULL DEFAULT 'REGULAR',
  "schemeId"      TEXT,
  "status"        TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyWorkEntry_pkey" PRIMARY KEY ("id")
);

-- One row per officer + date + section + dealer (blocks duplicate dealer rows at the DB level).
CREATE UNIQUE INDEX "DailyWorkEntry_officerId_workDate_section_dealerId_key"
  ON "DailyWorkEntry" ("officerId", "workDate", "section", "dealerId");
CREATE INDEX "DailyWorkEntry_officerId_idx" ON "DailyWorkEntry" ("officerId");
CREATE INDEX "DailyWorkEntry_dealerId_idx" ON "DailyWorkEntry" ("dealerId");
CREATE INDEX "DailyWorkEntry_schemeId_idx" ON "DailyWorkEntry" ("schemeId");
CREATE INDEX "DailyWorkEntry_workDate_idx" ON "DailyWorkEntry" ("workDate");

ALTER TABLE "DailyWorkEntry"
  ADD CONSTRAINT "DailyWorkEntry_officerId_fkey"
  FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyWorkEntry"
  ADD CONSTRAINT "DailyWorkEntry_dealerId_fkey"
  FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyWorkEntry"
  ADD CONSTRAINT "DailyWorkEntry_schemeId_fkey"
  FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
