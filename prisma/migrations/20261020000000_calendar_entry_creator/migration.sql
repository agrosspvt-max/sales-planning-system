-- Calendar: record WHO created an entry when it differs from its owner (Admin assigning a Manual Task / Reminder to a Sales Officer).
-- Additive and nullable: every existing row keeps NULL (= created by its owner); nothing is rewritten, no ownership changes.
ALTER TABLE "CalendarEntry" ADD COLUMN "createdById" TEXT;
CREATE INDEX "CalendarEntry_createdById_idx" ON "CalendarEntry"("createdById");
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
