-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'REGIONAL_MANAGER', 'SALES_OFFICER');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'PENDING_RM', 'PENDING_ADMIN', 'APPROVED', 'RETURNED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('SUBMIT', 'RECALL', 'APPROVE', 'RETURN', 'REJECT', 'REQUEST_REVISION', 'AUTHORIZE_REVISION');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PLAN_SUBMITTED', 'PLAN_APPROVED', 'PLAN_RETURNED', 'REVISION_AUTHORIZED', 'ANNOUNCEMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('COMPLETED', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "technicalName" TEXT,
    "rate" DECIMAL(12,2) NOT NULL,
    "nbvPercent" DECIMAL(6,4) NOT NULL,
    "categoryId" TEXT,
    "brandId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dealer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "town" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dealer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonMonth" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "SeasonMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audienceRole" "Role",
    "targetUserId" TEXT,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerAssignment" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RmAssignment" (
    "id" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RmAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPlan" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "isActiveVersion" BOOLEAN NOT NULL DEFAULT false,
    "supersedesId" TEXT,
    "revisionRequested" BOOLEAN NOT NULL DEFAULT false,
    "revisionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanDealer" (
    "id" TEXT NOT NULL,
    "seasonPlanId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,

    CONSTRAINT "PlanDealer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanLine" (
    "id" TEXT NOT NULL,
    "planDealerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "rateSnapshot" DECIMAL(12,2),
    "nbvPercentSnapshot" DECIMAL(6,4),

    CONSTRAINT "PlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanLinePack" (
    "id" TEXT NOT NULL,
    "planLineId" TEXT NOT NULL,
    "packSizeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlanLinePack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyEntry" (
    "id" TEXT NOT NULL,
    "planLineId" TEXT NOT NULL,
    "seasonMonthId" TEXT NOT NULL,
    "planQty" INTEGER NOT NULL DEFAULT 0,
    "saleQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalAction" (
    "id" TEXT NOT NULL,
    "seasonPlanId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "ApprovalActionType" NOT NULL,
    "fromStatus" "PlanStatus",
    "toStatus" "PlanStatus",
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackSize" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerImportRecord" (
    "id" TEXT NOT NULL,
    "importedById" TEXT NOT NULL,
    "workbookName" TEXT NOT NULL,
    "dealerCount" INTEGER NOT NULL DEFAULT 0,
    "createdDealers" INTEGER NOT NULL DEFAULT 0,
    "reassignedDealers" INTEGER NOT NULL DEFAULT 0,
    "skippedDealers" INTEGER NOT NULL DEFAULT 0,
    "officersCreated" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportStatus" NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerImportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementReadStatus" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementReadStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- CreateIndex
CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");

-- CreateIndex
CREATE INDEX "Dealer_isActive_idx" ON "Dealer"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Season_name_year_key" ON "Season"("name", "year");

-- CreateIndex
CREATE INDEX "SeasonMonth_seasonId_idx" ON "SeasonMonth"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonMonth_seasonId_order_key" ON "SeasonMonth"("seasonId", "order");

-- CreateIndex
CREATE INDEX "Announcement_isActive_idx" ON "Announcement"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE INDEX "DealerAssignment_dealerId_idx" ON "DealerAssignment"("dealerId");

-- CreateIndex
CREATE INDEX "DealerAssignment_officerId_idx" ON "DealerAssignment"("officerId");

-- CreateIndex
CREATE INDEX "DealerAssignment_effectiveFrom_idx" ON "DealerAssignment"("effectiveFrom");

-- CreateIndex
CREATE INDEX "RmAssignment_officerId_idx" ON "RmAssignment"("officerId");

-- CreateIndex
CREATE INDEX "RmAssignment_managerId_idx" ON "RmAssignment"("managerId");

-- CreateIndex
CREATE INDEX "RmAssignment_effectiveFrom_idx" ON "RmAssignment"("effectiveFrom");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_idx" ON "AuditLog"("entity");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SeasonPlan_officerId_idx" ON "SeasonPlan"("officerId");

-- CreateIndex
CREATE INDEX "SeasonPlan_seasonId_idx" ON "SeasonPlan"("seasonId");

-- CreateIndex
CREATE INDEX "SeasonPlan_status_idx" ON "SeasonPlan"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPlan_seasonId_officerId_version_key" ON "SeasonPlan"("seasonId", "officerId", "version");

-- CreateIndex
CREATE INDEX "PlanDealer_seasonPlanId_idx" ON "PlanDealer"("seasonPlanId");

-- CreateIndex
CREATE INDEX "PlanDealer_dealerId_idx" ON "PlanDealer"("dealerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanDealer_seasonPlanId_dealerId_key" ON "PlanDealer"("seasonPlanId", "dealerId");

-- CreateIndex
CREATE INDEX "PlanLine_planDealerId_idx" ON "PlanLine"("planDealerId");

-- CreateIndex
CREATE INDEX "PlanLine_productId_idx" ON "PlanLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanLine_planDealerId_productId_key" ON "PlanLine"("planDealerId", "productId");

-- CreateIndex
CREATE INDEX "PlanLinePack_planLineId_idx" ON "PlanLinePack"("planLineId");

-- CreateIndex
CREATE INDEX "PlanLinePack_packSizeId_idx" ON "PlanLinePack"("packSizeId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanLinePack_planLineId_packSizeId_key" ON "PlanLinePack"("planLineId", "packSizeId");

-- CreateIndex
CREATE INDEX "MonthlyEntry_planLineId_idx" ON "MonthlyEntry"("planLineId");

-- CreateIndex
CREATE INDEX "MonthlyEntry_seasonMonthId_idx" ON "MonthlyEntry"("seasonMonthId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyEntry_planLineId_seasonMonthId_key" ON "MonthlyEntry"("planLineId", "seasonMonthId");

-- CreateIndex
CREATE INDEX "ApprovalAction_seasonPlanId_idx" ON "ApprovalAction"("seasonPlanId");

-- CreateIndex
CREATE INDEX "ApprovalAction_actorId_idx" ON "ApprovalAction"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "PackSize_name_key" ON "PackSize"("name");

-- CreateIndex
CREATE INDEX "PackSize_isActive_idx" ON "PackSize"("isActive");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "DealerImportRecord_createdAt_idx" ON "DealerImportRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AnnouncementReadStatus_userId_idx" ON "AnnouncementReadStatus"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReadStatus_announcementId_userId_key" ON "AnnouncementReadStatus"("announcementId", "userId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonMonth" ADD CONSTRAINT "SeasonMonth_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAssignment" ADD CONSTRAINT "DealerAssignment_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAssignment" ADD CONSTRAINT "DealerAssignment_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RmAssignment" ADD CONSTRAINT "RmAssignment_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RmAssignment" ADD CONSTRAINT "RmAssignment_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPlan" ADD CONSTRAINT "SeasonPlan_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPlan" ADD CONSTRAINT "SeasonPlan_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanDealer" ADD CONSTRAINT "PlanDealer_seasonPlanId_fkey" FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanDealer" ADD CONSTRAINT "PlanDealer_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLine" ADD CONSTRAINT "PlanLine_planDealerId_fkey" FOREIGN KEY ("planDealerId") REFERENCES "PlanDealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLine" ADD CONSTRAINT "PlanLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLinePack" ADD CONSTRAINT "PlanLinePack_planLineId_fkey" FOREIGN KEY ("planLineId") REFERENCES "PlanLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLinePack" ADD CONSTRAINT "PlanLinePack_packSizeId_fkey" FOREIGN KEY ("packSizeId") REFERENCES "PackSize"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyEntry" ADD CONSTRAINT "MonthlyEntry_planLineId_fkey" FOREIGN KEY ("planLineId") REFERENCES "PlanLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyEntry" ADD CONSTRAINT "MonthlyEntry_seasonMonthId_fkey" FOREIGN KEY ("seasonMonthId") REFERENCES "SeasonMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_seasonPlanId_fkey" FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerImportRecord" ADD CONSTRAINT "DealerImportRecord_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReadStatus" ADD CONSTRAINT "AnnouncementReadStatus_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReadStatus" ADD CONSTRAINT "AnnouncementReadStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
