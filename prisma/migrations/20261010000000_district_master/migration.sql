-- District master (per State = UserGroup) + a nullable standard-district link on Territory Mapping.
-- Additive only: DealerMarketMapping.district (legacy text) is kept untouched, no existing row changes, nothing is dropped.
CREATE TABLE "District" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DistrictAlias" (
    "id" TEXT NOT NULL,
    "districtId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DistrictAlias_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DealerMarketMapping" ADD COLUMN "districtId" TEXT;

CREATE UNIQUE INDEX "District_groupId_nameKey_key" ON "District"("groupId", "nameKey");
CREATE INDEX "District_groupId_isActive_idx" ON "District"("groupId", "isActive");
CREATE UNIQUE INDEX "DistrictAlias_groupId_aliasKey_key" ON "DistrictAlias"("groupId", "aliasKey");
CREATE INDEX "DistrictAlias_districtId_idx" ON "DistrictAlias"("districtId");
CREATE INDEX "DealerMarketMapping_districtId_idx" ON "DealerMarketMapping"("districtId");

ALTER TABLE "District" ADD CONSTRAINT "District_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DistrictAlias" ADD CONSTRAINT "DistrictAlias_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealerMarketMapping" ADD CONSTRAINT "DealerMarketMapping_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;
