-- Per-product, per-bill quantities for Product-Quantity-Based schemes: SO planned qty + Admin actual qty,
-- with the product rate SNAPSHOTTED at conversion (historical integrity). Bill amounts are derived from these
-- and stored on DealerSchemeBill (the installment base is unchanged). Cascades with its bill. productId is a
-- plain column (no FK to Product) — application-enforced. Additive; existing schemes/bills are unaffected.
CREATE TABLE "DealerSchemeBillProduct" (
  "id"             TEXT NOT NULL,
  "billId"         TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "soQty"          DECIMAL(14,3),
  "adminQty"       DECIMAL(14,3),
  "rateWithoutGST" DECIMAL(14,2) NOT NULL,
  "rateWithGST"    DECIMAL(14,2) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealerSchemeBillProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealerSchemeBillProduct_billId_productId_key" ON "DealerSchemeBillProduct" ("billId", "productId");
CREATE INDEX "DealerSchemeBillProduct_billId_idx" ON "DealerSchemeBillProduct" ("billId");
CREATE INDEX "DealerSchemeBillProduct_productId_idx" ON "DealerSchemeBillProduct" ("productId");

ALTER TABLE "DealerSchemeBillProduct"
  ADD CONSTRAINT "DealerSchemeBillProduct_billId_fkey"
  FOREIGN KEY ("billId") REFERENCES "DealerSchemeBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
