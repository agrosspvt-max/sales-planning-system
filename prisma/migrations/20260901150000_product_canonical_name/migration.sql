-- Optional Canonical Name on Product, used only for Tally Sales Upload matching. Additive & nullable;
-- does not touch Product.name, its unique constraint, IDs, prices, or any references.
ALTER TABLE "Product" ADD COLUMN "canonicalName" TEXT;
