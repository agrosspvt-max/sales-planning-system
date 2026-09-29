import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";

/**
 * Party Planning (Phase 1) — a minimal Sales Officer planning module with a Draft → Submit → Admin Approval
 * workflow. Status flow (plain-string convention, mirroring CnRequest):
 *   DRAFT → PENDING_APPROVAL → APPROVED | REJECTED
 * A rejected plan becomes owner-editable again (the app's Returned/Rejected → editable convention), i.e. it
 * re-appears in Create Plan. Access is raw SQL because the generated Prisma client is not regenerated in this
 * environment; all queries are parameterized. No calendar/notification behaviour exists in Phase 1.
 */

export const PARTY_STATUS = { DRAFT: "DRAFT", PENDING: "PENDING_APPROVAL", APPROVED: "APPROVED", REJECTED: "REJECTED" } as const;
// Statuses the owner may still edit / re-submit (Create Plan).
const EDITABLE_STATUSES = [PARTY_STATUS.DRAFT, PARTY_STATUS.REJECTED];

// A business date "YYYY-MM-DD" with no timezone. Optional for a Draft; Submit enforces presence.
const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
  .refine((v) => { const d = new Date(v + "T00:00:00.000Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "Enter a valid calendar date");

const rowInput = z.object({
  id: z.string().min(1).optional(),
  partyName: z.string().trim().max(200).optional().default(""),
  marketName: z.string().trim().max(200).optional().default(""),
  appointmentDate: z.union([dateStr, z.literal("")]).optional().default(""),
});
const saveSchema = z.object({ rows: z.array(rowInput).max(200) });
const actSchema = z.object({ action: z.enum(["approve", "reject"]), remarks: z.string().max(500).optional() });

export interface PartyPlanRow {
  id: string;
  salesOfficerId: string;
  employeeName: string;
  partyName: string | null;
  marketName: string | null;
  appointmentDate: string | null; // "YYYY-MM-DD" (no timezone)
  status: string;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
}
type RawRow = {
  id: string; salesOfficerId: string; employeeName: string; partyName: string | null; marketName: string | null;
  appointmentDate: string | null; status: string; remarks: string | null; createdAt: Date; updatedAt: Date;
};
const toRow = (r: RawRow): PartyPlanRow => ({
  id: r.id, salesOfficerId: r.salesOfficerId, employeeName: r.employeeName,
  partyName: r.partyName, marketName: r.marketName, appointmentDate: r.appointmentDate,
  status: r.status, remarks: r.remarks, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

/** Only a Sales Officer or Regional Manager may create/edit party plans (both are planning roles). */
function assertPlanner(ctx: AuthContext) {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) {
    throw new ApiError(403, "Only a Sales Officer or Regional Manager can create party plans");
  }
}

/**
 * Persist the owner's editable set of party plans in ONE atomic operation. `status` is DRAFT (Save Draft) or
 * PENDING_APPROVAL (Submit). Semantics: the payload is the complete editable set — a meaningful row is one
 * with a Party Name; blank rows are dropped, and any previously-editable (DRAFT/REJECTED) plan of the owner
 * that is not in the payload is deleted, so add/edit/remove all persist together. On Submit every meaningful
 * row must have Party Name, Market Name and a valid Date (server-authoritative validation).
 */
async function persistOwnerPlans(ctx: AuthContext, raw: unknown, status: string): Promise<{ count: number }> {
  assertPlanner(ctx);
  const { rows } = saveSchema.parse(raw);
  const meaningful = rows.filter((r) => (r.partyName ?? "").trim().length > 0);
  const submitting = status === PARTY_STATUS.PENDING;

  if (submitting) {
    if (meaningful.length === 0) throw new ApiError(422, "Add at least one party plan before submitting");
    for (const r of meaningful) {
      if (!r.marketName?.trim()) throw new ApiError(422, "Market Name is required");
      if (!r.appointmentDate) throw new ApiError(422, "Date of Appointment is required");
    }
  }

  const ownerId = ctx.userId;
  const providedIds = meaningful.map((r) => r.id).filter((v): v is string => !!v);

  return prisma.$transaction(async (tx) => {
    // Any provided id must be an editable plan owned by the caller (never touch another's or an approved plan).
    if (providedIds.length > 0) {
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "PartyPlan"
        WHERE "id" IN (${Prisma.join(providedIds)}) AND "salesOfficerId" = ${ownerId} AND "status" IN (${Prisma.join(EDITABLE_STATUSES)})`;
      const ownedSet = new Set(owned.map((o) => o.id));
      for (const id of providedIds) if (!ownedSet.has(id)) throw new ApiError(403, "You can only edit your own draft or rejected plans");
    }

    // Delete the owner's editable rows no longer present (add/remove is part of one submission).
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "PartyPlan"
      WHERE "salesOfficerId" = ${ownerId} AND "status" IN (${Prisma.join(EDITABLE_STATUSES)})
      ${providedIds.length > 0 ? Prisma.sql`AND "id" NOT IN (${Prisma.join(providedIds)})` : Prisma.empty}`);

    for (const r of meaningful) {
      const date = r.appointmentDate ? Prisma.sql`${r.appointmentDate}::date` : Prisma.sql`NULL`;
      const market = r.marketName?.trim() || null;
      if (r.id) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "PartyPlan" SET
            "partyName" = ${r.partyName!.trim()}, "marketName" = ${market}, "appointmentDate" = ${date},
            "status" = ${status}, "remarks" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${r.id} AND "salesOfficerId" = ${ownerId} AND "status" IN (${Prisma.join(EDITABLE_STATUSES)})`);
      } else {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "PartyPlan" ("id","salesOfficerId","partyName","marketName","appointmentDate","status","createdAt","updatedAt")
          VALUES (${randomUUID()}, ${ownerId}, ${r.partyName!.trim()}, ${market}, ${date}, ${status}, NOW(), NOW())`);
      }
    }
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "partyPlan", entityId: ownerId, summary: submitting ? `Submitted ${meaningful.length} party plan(s)` : `Saved ${meaningful.length} party plan draft(s)` }, tx);
    return { count: meaningful.length };
  });
}

export async function saveDraft(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  return persistOwnerPlans(ctx, raw, PARTY_STATUS.DRAFT);
}
export async function submitDraft(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  return persistOwnerPlans(ctx, raw, PARTY_STATUS.PENDING);
}

/**
 * Scoped list for one view:
 *   editable  → the caller's OWN Draft + Rejected plans (Create Plan).
 *   submitted → PENDING_APPROVAL, scoped (SO own, RM team, Admin all).
 *   approved  → APPROVED, scoped.
 */
export async function listPartyPlans(ctx: AuthContext, view: "editable" | "submitted" | "approved"): Promise<PartyPlanRow[]> {
  const scope = await getOfficerScope(ctx);
  const select = Prisma.sql`
    SELECT p."id", p."salesOfficerId", u."name" AS "employeeName", p."partyName", p."marketName",
           p."appointmentDate"::text AS "appointmentDate", p."status", p."remarks", p."createdAt", p."updatedAt"
    FROM "PartyPlan" p JOIN "User" u ON u."id" = p."salesOfficerId"`;

  let where: Prisma.Sql;
  if (view === "editable") {
    // Create Plan is always the caller's own editable set (never another officer's), regardless of role.
    where = Prisma.sql`WHERE p."salesOfficerId" = ${ctx.userId} AND p."status" IN (${Prisma.join(EDITABLE_STATUSES)})`;
  } else {
    const status = view === "submitted" ? PARTY_STATUS.PENDING : PARTY_STATUS.APPROVED;
    const scopeClause = scope.all
      ? Prisma.empty
      : scope.ids.length > 0
        ? Prisma.sql`AND p."salesOfficerId" IN (${Prisma.join(scope.ids)})`
        : Prisma.sql`AND FALSE`;
    where = Prisma.sql`WHERE p."status" = ${status} ${scopeClause}`;
  }
  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`${select} ${where} ORDER BY p."appointmentDate" ASC NULLS LAST, p."createdAt" DESC`);
  return rows.map(toRow);
}

/** Admin approves or rejects a submitted party plan. Super Admin only (a Sales Officer can never approve). */
export async function actOnPartyPlan(ctx: AuthContext, id: string, raw: unknown): Promise<{ status: string }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can approve or reject party plans");
  const { action, remarks } = actSchema.parse(raw);
  const rows = await prisma.$queryRaw<{ status: string }[]>`SELECT "status" FROM "PartyPlan" WHERE "id" = ${id}`;
  if (rows.length === 0) throw new ApiError(404, "Party plan not found");
  if (rows[0].status !== PARTY_STATUS.PENDING) throw new ApiError(409, "Only a submitted party plan can be approved or rejected");
  const next = action === "approve" ? PARTY_STATUS.APPROVED : PARTY_STATUS.REJECTED;
  await prisma.$executeRaw`UPDATE "PartyPlan" SET "status" = ${next}, "remarks" = ${action === "reject" ? remarks?.trim() || null : null}, "updatedAt" = NOW() WHERE "id" = ${id}`;
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "partyPlan", entityId: id, summary: `Party plan ${action === "approve" ? "approved" : "rejected"} by Super Admin` });
  return { status: next };
}
