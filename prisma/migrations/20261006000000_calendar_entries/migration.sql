-- CalendarEntry: Daily Task / Meeting / Reminder / Other entries for the operational Calendar. Additive only: a new table;
-- CalendarNote and every existing table are untouched, so existing Calendar data is unaffected.
CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "taskSection" TEXT,
    "dealerId" TEXT,
    "amount" DECIMAL(14,2),
    "entryType" TEXT,
    "schemeId" TEXT,
    "paymentMode" TEXT,
    "typedDealerName" TEXT,
    "marketName" TEXT,
    "dealerVisits" INTEGER,
    "newPartyVisits" INTEGER,
    "dailyWorkEntryId" TEXT,
    "dailyWorkContribution" DECIMAL(14,2),
    "materializedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarEntry_ownerId_date_idx" ON "CalendarEntry"("ownerId", "date");
CREATE INDEX "CalendarEntry_date_idx" ON "CalendarEntry"("date");
CREATE INDEX "CalendarEntry_dailyWorkEntryId_idx" ON "CalendarEntry"("dailyWorkEntryId");

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
