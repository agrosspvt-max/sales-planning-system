-- AlterTable
ALTER TABLE "ApprovalAction" ADD COLUMN     "dealerTagRequestId" TEXT;

-- CreateTable
CREATE TABLE "DealerTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "markerType" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerTagAssignment" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerTagAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerTagRequest" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerTagRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealerTag_nameKey_key" ON "DealerTag"("nameKey");

-- CreateIndex
CREATE INDEX "DealerTagAssignment_tagId_isActive_idx" ON "DealerTagAssignment"("tagId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DealerTagAssignment_dealerId_tagId_key" ON "DealerTagAssignment"("dealerId", "tagId");

-- CreateIndex
CREATE INDEX "DealerTagRequest_requestedById_status_idx" ON "DealerTagRequest"("requestedById", "status");

-- CreateIndex
CREATE INDEX "DealerTagRequest_dealerId_tagId_idx" ON "DealerTagRequest"("dealerId", "tagId");

-- CreateIndex
CREATE INDEX "ApprovalAction_dealerTagRequestId_idx" ON "ApprovalAction"("dealerTagRequestId");

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_dealerTagRequestId_fkey" FOREIGN KEY ("dealerTagRequestId") REFERENCES "DealerTagRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerTagAssignment" ADD CONSTRAINT "DealerTagAssignment_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerTagAssignment" ADD CONSTRAINT "DealerTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "DealerTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerTagRequest" ADD CONSTRAINT "DealerTagRequest_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerTagRequest" ADD CONSTRAINT "DealerTagRequest_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "DealerTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerTagRequest" ADD CONSTRAINT "DealerTagRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only one unresolved operation for a dealer/tag; concurrent ADD/REVOKE requests cannot conflict.
CREATE UNIQUE INDEX "DealerTagRequest_pending_pair_key" ON "DealerTagRequest"("dealerId", "tagId")
  WHERE "status" IN ('PENDING_RM', 'PENDING_ADMIN');
ALTER TABLE "DealerTag" ADD CONSTRAINT "DealerTag_marker_type_check" CHECK ("markerType" IN ('TEXT','SYMBOL'));
ALTER TABLE "DealerTagRequest" ADD CONSTRAINT "DealerTagRequest_operation_check" CHECK ("operation" IN ('ADD','REVOKE'));
ALTER TABLE "DealerTagRequest" ADD CONSTRAINT "DealerTagRequest_status_check" CHECK ("status" IN ('PENDING_RM','PENDING_ADMIN','APPROVED','REJECTED'));
