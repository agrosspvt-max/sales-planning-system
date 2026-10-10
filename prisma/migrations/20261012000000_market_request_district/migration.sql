-- Vacant-Market requests record the District they are for. Additive and nullable: existing requests keep NULL (shown as "—", never backfilled).
ALTER TABLE "MarketRequest" ADD COLUMN "districtId" TEXT;
CREATE INDEX "MarketRequest_districtId_idx" ON "MarketRequest"("districtId");
ALTER TABLE "MarketRequest" ADD CONSTRAINT "MarketRequest_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
