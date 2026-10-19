import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { hasAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { getOfficerScope } from "@/lib/scope";
import {
  SO_MIDNIGHT_POLICY, dailyReportDeadline, dailyWorkClock, isReportDeadlinePassed, isStrictDeadlinePassed, soMidnightDeadline,
} from "@/lib/daily-work";
import { checkReason } from "@/lib/task-outcome";
import { formatDateTimeDMY, isoDateToDMY } from "@/lib/date-format";
type ResolvedLabels = Record<string, string>;

/**
 * DAILY REPORT DEADLINES + LATE-SUBMISSION APPROVAL.
 *
 * Policy (covered plans only): a Sales Officer's report for work date D closes at 00:00 of D+1 (business timezone, Asia/Kolkata); the midnight instant is already outside the window.
 * A Regional Manager keeps the previous rule (12:00 noon of D+1), and so does every plan that was first submitted before the rollout. Coverage is decided ONCE — when the day's
 * plan is first submitted — and persisted (DailyReportPolicy), so a later deployment, role change or extra planning batch can never move a deadline. The deadline always follows the
 * report OWNER's stored policy, never the role of whoever is looking.
 *
 * A late-submission request is durable database state (LateReportRequest). An approval re-opens ONLY the reporting deadline of that one report, with no expiry, until the report is
 * finally submitted (then it is COMPLETED in the same transaction). Everything else — ownership, task integrity, financial rules, immutability of committed outcomes — is unchanged.
 */
export type PolicyDb = typeof prisma | Prisma.TransactionClient;

export interface LateRequestDto {
  id: string; officerId: string; officerName: string; territory: string | null; state: string | null;
  /** The report's WORK date (not the date permission was asked for). */
  workDate: string; deadline: string; reason: string; status: "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED"; requestedAt: string;
  decidedByName: string | null; decidedByRole: string | null; decidedAt: string | null; decisionReason: string | null; completedAt: string | null;
}
export interface ReportWindow {
  /** The persisted policy of the day (null → previous rules). */
  covered: boolean; deadline: Date; passed: boolean;
  /** An APPROVED, not yet completed late-submission request for this report. */
  approved: boolean;
  /** Normal window still open OR an approval is outstanding. */
  open: boolean;
}

export async function rolloutEffectiveAt(db: PolicyDb): Promise<Date | null> {
  const rows = await db.$queryRaw<{ effectiveAt: Date }[]>(Prisma.sql`SELECT "effectiveAt" FROM "DailyReportRollout" WHERE "id" = ${SO_MIDNIGHT_POLICY}`);
  return rows[0]?.effectiveAt ?? null;
}

/**
 * Called inside the plan-submission transaction. The FIRST submitted plan of a day by a Sales Officer after the rollout fixes that day's policy; later batches of the same date find it
 * (or, for a plan first submitted before the rollout, find no policy and keep the previous rules). Idempotent.
 */
export async function recordPolicyOnFirstSubmit(tx: Prisma.TransactionClient, officerId: string, role: Role, workDate: string, now: Date): Promise<void> {
  if (role !== Role.SALES_OFFICER) return;
  const prior = await tx.$queryRaw<{ n: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM "DailyWorkEntry" WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "planSubmittedAt" IS NOT NULL) AS "n"`);
  if (prior[0]?.n) return; // a plan of this day was already submitted: its policy (or its absence) stands
  const effective = await rolloutEffectiveAt(tx);
  if (!effective || now.getTime() < effective.getTime()) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DailyReportPolicy" ("id","officerId","workDate","version","deadline","createdAt")
    VALUES (${randomUUID()}, ${officerId}, ${workDate}::date, ${SO_MIDNIGHT_POLICY}, ${soMidnightDeadline(workDate)}, NOW())
    ON CONFLICT ("officerId","workDate") DO NOTHING`);
}

/** Persisted policy deadlines for many (officer, date) pairs at once (one query). */
export async function loadPolicyDeadlines(db: PolicyDb, officerIds: readonly string[], from: string, to: string): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (officerIds.length === 0) return out;
  const rows = await db.$queryRaw<{ officerId: string; workDate: string; deadline: Date }[]>(Prisma.sql`
    SELECT "officerId", "workDate"::text AS "workDate", "deadline" FROM "DailyReportPolicy" WHERE "officerId" IN (${Prisma.join(officerIds)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date`);
  for (const r of rows) out.set(`${r.officerId}|${r.workDate}`, r.deadline);
  return out;
}

/** The reporting window of ONE report, from the OWNER's persisted policy (never the viewer's role). */
export async function reportWindow(db: PolicyDb, officerId: string, workDate: string, now: Date = dailyWorkClock.now()): Promise<ReportWindow> {
  const rows = await db.$queryRaw<{ deadline: Date | null; approved: boolean }[]>(Prisma.sql`
    SELECT (SELECT p."deadline" FROM "DailyReportPolicy" p WHERE p."officerId" = ${officerId} AND p."workDate" = ${workDate}::date) AS "deadline",
           EXISTS (SELECT 1 FROM "LateReportRequest" r WHERE r."officerId" = ${officerId} AND r."workDate" = ${workDate}::date AND r."status" = 'APPROVED') AS "approved"`);
  const policy = rows[0]?.deadline ?? null;
  const deadline = policy ?? dailyReportDeadline(workDate);
  const passed = policy ? isStrictDeadlinePassed(policy, now) : isReportDeadlinePassed(workDate, now);
  const approved = rows[0]?.approved ?? false;
  return { covered: policy !== null, deadline, passed, approved, open: !passed || approved };
}

/** Every report write (draft results, section actions, outcomes, final submission) goes through this: the deadline is enforced on the server, not by disabled buttons. */
export async function assertReportWritable(db: PolicyDb, officerId: string, workDate: string, L: ResolvedLabels): Promise<ReportWindow> {
  const w = await reportWindow(db, officerId, workDate);
  if (!w.open) throw new ApiError(422, L["daily_work.validation.report_deadline_passed"].replace("{deadline}", formatDateTimeDMY(w.deadline)));
  return w;
}

/**
 * The Sales Officer's most recent SUBMITTED plan before `beforeDate` whose report is not finalized, when that day is covered by the new policy. Regardless of how many days ago it was
 * submitted. System-generated draft rows are not a submitted plan (planSubmittedAt is set only by an explicit submission). null → nothing outstanding.
 */
export async function outstandingReport(db: PolicyDb, officerId: string, beforeDate: string): Promise<{ date: string; deadline: Date } | null> {
  const rows = await db.$queryRaw<{ date: string; deadline: Date | null; finalized: boolean }[]>(Prisma.sql`
    SELECT l."workDate"::text AS "date", p."deadline" AS "deadline",
           EXISTS (SELECT 1 FROM "DailyWorkDay" d WHERE d."officerId" = l."officerId" AND d."workDate" = l."workDate" AND d."status" = 'FINALIZED') AS "finalized"
    FROM (SELECT e."officerId", e."workDate" FROM "DailyWorkEntry" e WHERE e."officerId" = ${officerId} AND e."planSubmittedAt" IS NOT NULL AND e."workDate" < ${beforeDate}::date
          GROUP BY e."officerId", e."workDate" ORDER BY e."workDate" DESC LIMIT 1) l
    LEFT JOIN "DailyReportPolicy" p ON p."officerId" = l."officerId" AND p."workDate" = l."workDate"`);
  const r = rows[0];
  if (!r || r.finalized || !r.deadline) return null; // finalized → released; no policy → the previous rules apply to that (earlier) plan
  return { date: r.date, deadline: r.deadline };
}

/** A blocked Sales Officer cannot create, edit, save or submit a new Daily Plan (server-side, in the locked transaction). RM behaviour is unchanged. */
export async function assertPlanWritable(db: PolicyDb, ctx: Pick<AuthContext, "userId" | "role">, workDate: string, L: ResolvedLabels): Promise<void> {
  if (ctx.role !== Role.SALES_OFFICER) return;
  const o = await outstandingReport(db, ctx.userId, workDate);
  if (o) throw new ApiError(423, L["daily_work.validation.outstanding_report"].replace("{date}", o.date));
}

/** The final submission succeeded: complete the approval (no further use). Called inside the finalization transaction. */
export async function completeLateRequest(tx: Prisma.TransactionClient, officerId: string, workDate: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`UPDATE "LateReportRequest" SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW() WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'APPROVED'`);
}

/* ------------------------------------------------ requests ------------------------------------------------ */

type RequestRow = { id: string; officerId: string; officerName: string; territory: string | null; stateName: string | null; workDate: string; deadline: Date; reason: string; status: LateRequestDto["status"]; requestedAt: Date; decidedByName: string | null; decidedByRole: string | null; decidedAt: Date | null; decisionReason: string | null; completedAt: Date | null };
const toDto = (r: RequestRow): LateRequestDto => ({
  id: r.id, officerId: r.officerId, officerName: r.officerName, territory: r.territory, state: r.stateName, workDate: r.workDate, deadline: r.deadline.toISOString(), reason: r.reason, status: r.status,
  requestedAt: r.requestedAt.toISOString(), decidedByName: r.decidedByName, decidedByRole: r.decidedByRole, decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason, completedAt: r.completedAt?.toISOString() ?? null,
});

/** Lightweight approval refresh: one indexed read, bound to the authenticated SO (never a supplied officer id). */
export async function ownLateReportRequestStatus(ctx: AuthContext, workDate: string | null): Promise<{ id: string; status: LateRequestDto["status"] } | null> {
  if (ctx.role !== Role.SALES_OFFICER) throw new ApiError(403, "Only a Sales Officer can read their own late-report request status.");
  if (!workDate || !isoDateToDMY(workDate)) throw new ApiError(422, "A valid report date is required.");
  const rows = await prisma.$queryRaw<{ id: string; status: LateRequestDto["status"] }[]>(Prisma.sql`
    SELECT "id", "status" FROM "LateReportRequest" WHERE "officerId" = ${ctx.userId} AND "workDate" = ${workDate}::date
    ORDER BY "requestedAt" DESC, "id" DESC LIMIT 1`);
  return rows[0] ?? null;
}
const REQUEST_SELECT = Prisma.sql`SELECT r."id", r."officerId", u."name" AS "officerName", u."territory", g."name" AS "stateName", r."workDate"::text AS "workDate", r."deadline", r."reason", r."status", r."requestedAt",
  r."decidedByName", r."decidedByRole", r."decidedAt", r."decisionReason", r."completedAt"
  FROM "LateReportRequest" r JOIN "User" u ON u."id" = r."officerId" LEFT JOIN "UserGroup" g ON g."id" = u."groupId"`;

/** The caller's own requests for one report date (newest first) — the Sales Officer's status view. */
export async function myLateRequests(db: PolicyDb, officerId: string, workDate: string): Promise<LateRequestDto[]> {
  const rows = await db.$queryRaw<RequestRow[]>(Prisma.sql`${REQUEST_SELECT} WHERE r."officerId" = ${officerId} AND r."workDate" = ${workDate}::date ORDER BY r."requestedAt" DESC, r."id" DESC`);
  return rows.map(toDto);
}

/**
 * A Sales Officer asks to submit THEIR OWN overdue report: it must have an actual submitted plan under the new policy, be past its deadline and not finalized. Skipped dates (no plan),
 * other employees' reports and finalized reports are refused. One open request per report; a rejected one can be followed by a revised one (history is kept).
 */
export async function createLateReportRequest(ctx: AuthContext, raw: unknown, L: ResolvedLabels): Promise<LateRequestDto> {
  if (ctx.role !== Role.SALES_OFFICER) throw new ApiError(403, L["daily_work.late.error.owner_only"]);
  const input = (raw ?? {}) as Record<string, unknown>;
  const workDate = typeof input.workDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.workDate) ? input.workDate : "";
  if (!workDate) throw new ApiError(422, L["daily_work.late.error.date_required"]);
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  const check = checkReason(reason);
  if (check !== "ok") throw new ApiError(422, L[`daily_work.late.error.${check}`] ?? L["daily_work.late.error.reason_required"]);
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize with the day's other writers (final submission, outcomes) for this one report.
      await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "DailyWorkDay" WHERE "officerId" = ${ctx.userId} AND "workDate" = ${workDate}::date FOR UPDATE`);
      const facts = await tx.$queryRaw<{ deadline: Date | null; planned: boolean; finalized: boolean }[]>(Prisma.sql`
        SELECT (SELECT p."deadline" FROM "DailyReportPolicy" p WHERE p."officerId" = ${ctx.userId} AND p."workDate" = ${workDate}::date) AS "deadline",
               EXISTS (SELECT 1 FROM "DailyWorkEntry" e WHERE e."officerId" = ${ctx.userId} AND e."workDate" = ${workDate}::date AND e."planSubmittedAt" IS NOT NULL) AS "planned",
               EXISTS (SELECT 1 FROM "DailyWorkDay" d WHERE d."officerId" = ${ctx.userId} AND d."workDate" = ${workDate}::date AND d."status" = 'FINALIZED') AS "finalized"`);
      const f = facts[0];
      if (!f?.planned) throw new ApiError(422, L["daily_work.late.error.no_plan"]); // a skipped date has no report obligation and cannot be reopened
      if (f.finalized) throw new ApiError(409, L["daily_work.late.error.already_finalized"]);
      if (!f.deadline) throw new ApiError(422, L["daily_work.late.error.not_required"]); // previous rules: no late permission exists for that report
      if (!isStrictDeadlinePassed(f.deadline, dailyWorkClock.now())) throw new ApiError(422, L["daily_work.late.error.not_overdue"]);
      const open = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`SELECT "status" FROM "LateReportRequest" WHERE "officerId" = ${ctx.userId} AND "workDate" = ${workDate}::date AND "status" IN ('PENDING','APPROVED')`);
      if (open[0]) throw new ApiError(409, open[0].status === "APPROVED" ? L["daily_work.late.error.already_approved"] : L["daily_work.late.error.already_pending"]);
      const id = randomUUID();
      await tx.$executeRaw(Prisma.sql`INSERT INTO "LateReportRequest" ("id","officerId","workDate","reason","status","deadline","requestedAt","createdAt","updatedAt") VALUES (${id}, ${ctx.userId}, ${workDate}::date, ${reason}, 'PENDING', ${f.deadline}, NOW(), NOW(), NOW())`);
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "lateReportRequest", entityId: id, summary: `Requested late submission of the ${workDate} Daily Report` }, tx);
      return (await myLateRequests(tx, ctx.userId, workDate)).find((r) => r.id === id)!;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ApiError(409, L["daily_work.late.error.already_pending"]);
    throw e;
  }
}

/** Who may see / decide requests: an RM for the Sales Officers of their own group; Super Admin for everyone; a Custom Admin only through their stored Performance permissions. */
async function reviewerScope(ctx: AuthContext, action: "read" | "decide"): Promise<{ all: boolean; ids: string[] }> {
  if (ctx.role === Role.REGIONAL_MANAGER) { const s = await getOfficerScope(ctx); return { all: false, ids: s.ids.filter((id) => id !== ctx.userId) }; }
  if (isAdministrativeRole(ctx.role) && hasAdminPermission(ctx, "performance", action === "read" ? "read" : "lateReports")) return { all: true, ids: [] };
  return { all: false, ids: [] };
}
export async function canReviewLateRequests(ctx: AuthContext): Promise<boolean> {
  if (ctx.role === Role.REGIONAL_MANAGER) return true;
  return isAdministrativeRole(ctx.role) && hasAdminPermission(ctx, "performance", "read");
}

/** Pending requests (default) or the history (everything decided), within the reviewer's authorized scope, newest first. One query. */
export async function listLateRequests(ctx: AuthContext, view: "pending" | "history", L: ResolvedLabels): Promise<LateRequestDto[]> {
  if (!(await canReviewLateRequests(ctx))) throw new ApiError(403, L["daily_work.late.error.forbidden"]);
  const scope = await reviewerScope(ctx, "read");
  if (!scope.all && scope.ids.length === 0) return [];
  const who = scope.all ? Prisma.empty : Prisma.sql`AND r."officerId" IN (${Prisma.join(scope.ids)})`;
  const rows = await prisma.$queryRaw<RequestRow[]>(Prisma.sql`${REQUEST_SELECT} WHERE ${view === "pending" ? Prisma.sql`r."status" = 'PENDING'` : Prisma.sql`r."status" <> 'PENDING'`} ${who}
    ORDER BY r."requestedAt" DESC, r."id" DESC LIMIT 500`);
  return rows.map(toDto);
}

/**
 * Approve or reject. The FIRST valid decision resolves the pending request in ONE conditional update (`WHERE status = 'PENDING'`); a stale second decision matches nothing and is refused,
 * so it can never overwrite the first. Either the responsible RM or an authorized admin may decide; one approval is enough. A rejection needs an explanation.
 */
export async function decideLateReportRequest(ctx: AuthContext, id: string, raw: unknown, L: ResolvedLabels): Promise<LateRequestDto> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const action = input.action === "approve" || input.action === "reject" ? input.action : null;
  if (!action) throw new ApiError(422, L["daily_work.late.error.action_required"]);
  const scope = await reviewerScope(ctx, "decide");
  const target = await prisma.$queryRaw<{ officerId: string }[]>(Prisma.sql`SELECT "officerId" FROM "LateReportRequest" WHERE "id" = ${id}`);
  if (!target[0] || (!scope.all && !scope.ids.includes(target[0].officerId))) throw new ApiError(target[0] ? 403 : 404, target[0] ? L["daily_work.late.error.forbidden"] : L["daily_work.late.error.not_found"]);
  const note = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  if (action === "reject" && note.length < 5) throw new ApiError(422, L["daily_work.late.error.rejection_reason_required"]);
  return prisma.$transaction(async (tx) => {
    const actor = (await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? ctx.username ?? ctx.userId;
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "LateReportRequest" SET "status" = ${action === "approve" ? "APPROVED" : "REJECTED"}, "decidedById" = ${ctx.userId}, "decidedByName" = ${actor}, "decidedByRole" = ${ctx.role}, "decidedAt" = NOW(),
        "decisionReason" = ${action === "reject" ? note : null}, "updatedAt" = NOW()
      WHERE "id" = ${id} AND "status" = 'PENDING'`);
    if (Number(updated) !== 1) throw new ApiError(409, L["daily_work.late.error.already_decided"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "lateReportRequest", entityId: id, summary: `${action === "approve" ? "Approved" : "Rejected"} late report submission${action === "reject" ? `: ${note}` : ""}` }, tx);
    const rows = await tx.$queryRaw<RequestRow[]>(Prisma.sql`${REQUEST_SELECT} WHERE r."id" = ${id}`);
    return toDto(rows[0]!);
  });
}

/** For Performance: the late-submission facts of many (officer, date) pairs in ONE query. */
export async function loadLateRequestFacts(db: PolicyDb, officerIds: readonly string[], from: string, to: string): Promise<Map<string, { open: "PENDING" | "APPROVED" | null; completed: boolean }>> {
  const out = new Map<string, { open: "PENDING" | "APPROVED" | null; completed: boolean }>();
  if (officerIds.length === 0) return out;
  const rows = await db.$queryRaw<{ officerId: string; workDate: string; status: string }[]>(Prisma.sql`
    SELECT "officerId", "workDate"::text AS "workDate", "status" FROM "LateReportRequest" WHERE "officerId" IN (${Prisma.join(officerIds)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date AND "status" IN ('PENDING','APPROVED','COMPLETED')`);
  for (const r of rows) {
    const k = `${r.officerId}|${r.workDate}`;
    const cur = out.get(k) ?? { open: null, completed: false };
    if (r.status === "COMPLETED") cur.completed = true; else cur.open = r.status as "PENDING" | "APPROVED";
    out.set(k, cur);
  }
  return out;
}
