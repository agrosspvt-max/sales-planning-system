-- Group-wise Product Catalogue: a per-(group, product) overlay on the Master Product. Master remains the
-- single product identity (no product duplication).
CREATE TABLE "GroupProductCatalogue" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "priceIsInitial" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GroupProductCatalogue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GroupProductCatalogue_groupId_productId_key" ON "GroupProductCatalogue"("groupId", "productId");
CREATE INDEX "GroupProductCatalogue_groupId_idx" ON "GroupProductCatalogue"("groupId");
CREATE INDEX "GroupProductCatalogue_productId_idx" ON "GroupProductCatalogue"("productId");
ALTER TABLE "GroupProductCatalogue"
  ADD CONSTRAINT "GroupProductCatalogue_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupProductCatalogue"
  ADD CONSTRAINT "GroupProductCatalogue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historical-safety groundwork: freeze the rate/NBV% every EXISTING plan line computes with today onto the
-- line itself (PlanLine.rateSnapshot / nbvPercentSnapshot). Once calculations read the snapshot (next
-- slice), historical plan amounts can never move when Master or Group prices change. Behaviour-preserving:
-- it copies the CURRENT Master price (exactly what those lines already use), and only fills empty snapshots.
UPDATE "PlanLine" pl
SET "rateSnapshot" = p."rate",
    "nbvPercentSnapshot" = p."nbvPercent"
FROM "Product" p
WHERE pl."productId" = p."id"
  AND pl."rateSnapshot" IS NULL;
