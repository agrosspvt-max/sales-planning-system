-- Territory Mapping: the dealer's District (nullable free text; imported from Excel or edited). Existing rows stay NULL.
ALTER TABLE "DealerMarketMapping" ADD COLUMN "district" TEXT;
