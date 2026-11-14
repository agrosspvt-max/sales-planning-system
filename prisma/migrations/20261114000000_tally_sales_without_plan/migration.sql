-- AlterTable
ALTER TABLE "TallySalesSnapshot" ADD COLUMN     "actualDealerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "TallySalesActual" (
    "snapshotId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "TallySalesActual_pkey" PRIMARY KEY ("snapshotId","dealerId","productId")
);

-- CreateIndex
CREATE INDEX "TallySalesActual_dealerId_idx" ON "TallySalesActual"("dealerId");

-- AddForeignKey
ALTER TABLE "TallySalesActual" ADD CONSTRAINT "TallySalesActual_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "TallySalesSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesActual" ADD CONSTRAINT "TallySalesActual_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesActual" ADD CONSTRAINT "TallySalesActual_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
