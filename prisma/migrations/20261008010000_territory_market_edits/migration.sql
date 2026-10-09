-- Territory Mapping: temporary manual Market edit (free-text override) + its append-only history. Existing rows stay NULL.
ALTER TABLE "DealerMarketMapping" ADD COLUMN "marketText" TEXT;

CREATE TABLE "TerritoryMarketEdit" (
  "id" TEXT NOT NULL,
  "dealerId" TEXT NOT NULL,
  "previousMarket" TEXT,
  "newMarket" TEXT NOT NULL,
  "editedById" TEXT NOT NULL,
  "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TerritoryMarketEdit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TerritoryMarketEdit_dealerId_editedAt_idx" ON "TerritoryMarketEdit"("dealerId", "editedAt");
ALTER TABLE "TerritoryMarketEdit" ADD CONSTRAINT "TerritoryMarketEdit_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TerritoryMarketEdit" ADD CONSTRAINT "TerritoryMarketEdit_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: history can be INSERTed into, never rewritten or erased.
CREATE FUNCTION "territory_market_edit_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TerritoryMarketEdit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TerritoryMarketEdit_no_update" BEFORE UPDATE ON "TerritoryMarketEdit" FOR EACH ROW EXECUTE FUNCTION "territory_market_edit_append_only"();
CREATE TRIGGER "TerritoryMarketEdit_no_delete" BEFORE DELETE ON "TerritoryMarketEdit" FOR EACH ROW EXECUTE FUNCTION "territory_market_edit_append_only"();
