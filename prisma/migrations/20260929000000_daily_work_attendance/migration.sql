-- Phase 4: Performance attendance for one Sales Officer on one business date. Independent of Daily Work
-- submission. Absence of a row means Present (the default), so no historical back-fill is needed and only
-- explicit Super Admin overrides are persisted. One row per (officer, date).
CREATE TABLE "DailyWorkAttendance" (
    "id" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailyWorkAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyWorkAttendance_officerId_workDate_key" ON "DailyWorkAttendance"("officerId", "workDate");
CREATE INDEX "DailyWorkAttendance_workDate_idx" ON "DailyWorkAttendance"("workDate");

ALTER TABLE "DailyWorkAttendance" ADD CONSTRAINT "DailyWorkAttendance_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
