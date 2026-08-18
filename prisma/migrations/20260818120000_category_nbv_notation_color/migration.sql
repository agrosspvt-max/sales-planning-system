-- Enrich Category so it owns an NBV% (fraction) plus a display notation + color. Products are auto-mapped
-- to the category whose nbvPercent matches theirs; there is no manual product↔category assignment.
-- Brand is intentionally left untouched (still used by Reports / price import).
ALTER TABLE "Category" ADD COLUMN "nbvPercent" DECIMAL(6,4);
ALTER TABLE "Category" ADD COLUMN "notation" TEXT;
ALTER TABLE "Category" ADD COLUMN "color" TEXT;

-- One category per NBV% so the product→category mapping is deterministic.
CREATE UNIQUE INDEX "Category_nbvPercent_key" ON "Category"("nbvPercent");
