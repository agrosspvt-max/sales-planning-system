-- Clearance flag + quantity on the Group Product Catalogue (group-specific, display-only — never affects
-- any amount/NBV calculation).
ALTER TABLE "GroupProductCatalogue" ADD COLUMN "isClearance" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GroupProductCatalogue" ADD COLUMN "clearanceQty" INTEGER;
