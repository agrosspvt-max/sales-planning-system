-- CalendarNote: personal per-day notes for the operational Calendar. CONVERSION calendar events are
-- projected at read time from DealerSchemePlan and are NOT stored here (no duplicate business data).
CREATE TABLE "CalendarNote" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarNote_ownerId_date_idx" ON "CalendarNote"("ownerId", "date");
CREATE INDEX "CalendarNote_date_idx" ON "CalendarNote"("date");

ALTER TABLE "CalendarNote" ADD CONSTRAINT "CalendarNote_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
