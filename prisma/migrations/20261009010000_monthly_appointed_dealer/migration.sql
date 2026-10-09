-- Monthly Planning: Appointed creates a Dealer (same service as Dealer Alias → Create Dealer); keep the reference on the row and on its status event.
ALTER TABLE "PartyMonthlyPlan" ADD COLUMN "appointedDealerId" TEXT;
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_appointedDealerId_fkey" FOREIGN KEY ("appointedDealerId") REFERENCES "Dealer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlyStatusEvent" ADD COLUMN "dealerId" TEXT;
