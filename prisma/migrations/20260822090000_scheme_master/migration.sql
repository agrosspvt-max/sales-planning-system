-- Phase 1: Scheme Master. State is represented by the existing UserGroup master.
CREATE TYPE "SchemeStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SchemeBenefit" AS ENUM ('DOMESTIC_TOUR', 'DOMESTIC_COUPLE_TOUR', 'FOREIGN_TOUR', 'CREDIT_NOTE', 'OTHER');

CREATE TABLE "Scheme" (
    "id" TEXT NOT NULL,
    "schemeName" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "bookingLastDate" TIMESTAMP(3) NOT NULL,
    "schemeValue" DECIMAL(14,2) NOT NULL,
    "schemeBenefit" "SchemeBenefit" NOT NULL,
    "allowMultipleSchemes" BOOLEAN NOT NULL DEFAULT false,
    "documentUrl" TEXT,
    "status" "SchemeStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Scheme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SchemeState" (
    "schemeId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    CONSTRAINT "SchemeState_pkey" PRIMARY KEY ("schemeId", "groupId")
);

CREATE INDEX "Scheme_status_idx" ON "Scheme"("status");
CREATE INDEX "Scheme_startDate_endDate_idx" ON "Scheme"("startDate", "endDate");
CREATE INDEX "Scheme_createdById_idx" ON "Scheme"("createdById");
CREATE INDEX "SchemeState_groupId_idx" ON "SchemeState"("groupId");

ALTER TABLE "Scheme" ADD CONSTRAINT "Scheme_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchemeState" ADD CONSTRAINT "SchemeState_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeState" ADD CONSTRAINT "SchemeState_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
