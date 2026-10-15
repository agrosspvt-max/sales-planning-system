import "server-only";
import { NotificationType, Role, type Prisma } from "@prisma/client";
import { formatDMY } from "@/lib/date-format";
import { formatCurrency } from "@/lib/utils";
import { getCurrentManagerId, getCurrentOwnerByDealer } from "@/lib/scope";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { getResolvedLabels } from "@/features/labels/service.server";
import { notifyMany } from "./service.server";

/**
 * Persistent alerts for NEW automatic tasks and NEW Billing Exceptions. They use the existing Notification table (bell, list, unread count) and are
 * written inside the SAME transaction as the task / exception, so an alert exists exactly when its source record was committed — a retry, a double click
 * or a replay that finds the record already saved never reaches this code, and a calendar read or a Daily Work materialization never calls it
 * (those only LINK an existing task). Recipients are resolved here, from the database — never from anything the browser sent.
 */

export type AlertLabels = Record<LabelKey, string>;
type Db = Prisma.TransactionClient;

/** Resolved Edit Labels, falling back to the defaults: a label lookup problem must never block the operation it describes. */
export async function alertLabels(): Promise<AlertLabels> {
  try { return await getResolvedLabels(); } catch { return { ...DEFAULT_LABELS } as AlertLabels; }
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

export type AutoTaskSource = "BILLING_EXCEPTION" | "CN" | "CALENDAR";
export type AutoTaskSection = "RECOVERY" | "SALES" | "APPOINTMENT" | "VISITS" | "OTHERS";
const SOURCE_LABEL: Record<AutoTaskSource, LabelKey> = { BILLING_EXCEPTION: "notifications.source.billing_exception", CN: "notifications.source.cn", CALENDAR: "notifications.source.calendar" };
const SECTION_LABEL: Record<AutoTaskSection, LabelKey> = {
  RECOVERY: "notifications.section.recovery", SALES: "notifications.section.sales", APPOINTMENT: "notifications.section.appointment",
  VISITS: "notifications.section.visits", OTHERS: "notifications.section.others",
};

/**
 * Who hears about a task / exception: the concerned employee (the authoritative owner), that employee's Regional Manager (existing SO–RM relationship; none
 * for an RM-owned item or when the group has no active RM) and every active Super Admin. A Set removes duplicates, so nobody is notified twice.
 */
export async function alertRecipients(db: Db, ownerId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  if (ownerId) {
    const owner = await db.user.findUnique({ where: { id: ownerId }, select: { id: true, role: true, isActive: true, deletedAt: true } });
    if (owner && owner.isActive && !owner.deletedAt && (owner.role === Role.SALES_OFFICER || owner.role === Role.REGIONAL_MANAGER)) {
      ids.add(owner.id);
      if (owner.role === Role.SALES_OFFICER) {
        const manager = await getCurrentManagerId(owner.id, db);
        if (manager) ids.add(manager);
      }
    }
  }
  const admins = await db.user.findMany({ where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }, select: { id: true } });
  for (const a of admins) ids.add(a.id);
  return [...ids];
}

/** Dealer name and Market (the Territory Mapping market, or its temporary text override) for display. */
async function dealerContext(db: Db, dealerId: string | null): Promise<{ name: string | null; market: string | null }> {
  if (!dealerId) return { name: null, market: null };
  const [dealer, mapping] = await Promise.all([
    db.dealer.findUnique({ where: { id: dealerId }, select: { name: true } }),
    db.dealerMarketMapping.findUnique({ where: { dealerId }, select: { marketText: true, market: { select: { name: true } } } }),
  ]);
  return { name: dealer?.name ?? null, market: mapping?.marketText?.trim() || mapping?.market?.name || null };
}

export interface AutoTaskAlert {
  source: AutoTaskSource; section: AutoTaskSection; ownerId: string;
  dealerId?: string | null; dealerName?: string | null; marketName?: string | null;
  date: string; amount?: number | null;
  entityType: string; entityId: string;
}

export function buildAutoTaskMessage(L: AlertLabels, t: { source: AutoTaskSource; section: AutoTaskSection; dealer?: string | null; employee: string; date: string; market?: string | null; amount?: number | null }) {
  return {
    title: L["notifications.auto_task.title"],
    message: fill(L["notifications.auto_task.message"], { source: L[SOURCE_LABEL[t.source]], section: L[SECTION_LABEL[t.section]], dealer_part: t.dealer ? fill(L["notifications.auto_task.dealer_part"], { dealer: t.dealer }) : "", employee: t.employee, date: formatDMY(t.date) })
      + (t.market ? fill(L["notifications.auto_task.market_part"], { market: t.market }) : "")
      + (t.amount != null ? fill(L["notifications.auto_task.amount_part"], { amount: formatCurrency(t.amount) }) : ""),
  };
}

/** One alert per recipient for a newly created / assigned automatic task (future-dated included — it does not wait for the scheduled day). */
export async function notifyAutoTaskCreated(tx: Db, L: AlertLabels, t: AutoTaskAlert): Promise<void> {
  const [owner, ctx, recipients] = await Promise.all([
    tx.user.findUnique({ where: { id: t.ownerId }, select: { name: true } }),
    t.dealerName !== undefined ? Promise.resolve({ name: t.dealerName, market: t.marketName ?? null }) : dealerContext(tx, t.dealerId ?? null),
    alertRecipients(tx, t.ownerId),
  ]);
  const { title, message } = buildAutoTaskMessage(L, {
    source: t.source, section: t.section, dealer: ctx.name, employee: owner?.name ?? "—", date: t.date, market: t.marketName ?? ctx.market, amount: t.amount,
  });
  await notifyMany(recipients, { type: NotificationType.SYSTEM, title, message, relatedEntityType: t.entityType, relatedEntityId: t.entityId }, tx);
}

export interface BillingExceptionAlert {
  exceptionId: string; dealerId: string; dealerName: string; billNo: string; billingDate: string; billingAmount: number | null; authPerson: string;
  paymentCondition: boolean; paymentDate: string | null; paymentAmount: number | null; taskOfficerId: string | null;
}

export function buildExceptionMessage(L: AlertLabels, e: { dealer: string; billNo: string; billingDate: string; billingAmount: number | null; authPerson: string; paymentCondition: boolean; paymentDate: string | null; paymentAmount: number | null; employee: string | null }) {
  const withTask = e.paymentCondition && !!e.employee;
  return {
    title: L[withTask ? "notifications.exception.title_with_task" : "notifications.exception.title"],
    message: fill(L["notifications.exception.message"], {
      dealer: e.dealer, billNo: e.billNo, billingDate: formatDMY(e.billingDate), billingAmount: e.billingAmount == null ? "—" : formatCurrency(e.billingAmount), authPerson: e.authPerson,
      condition: L[e.paymentCondition ? "notifications.exception.condition_yes" : "notifications.exception.condition_no"],
    }) + (withTask ? fill(L["notifications.exception.promise_part"], { amount: e.paymentAmount == null ? "—" : formatCurrency(e.paymentAmount), date: formatDMY(e.paymentDate), employee: e.employee! }) : ""),
  };
}

/**
 * ONE alert per recipient for a newly saved Billing Exception — also when the payment condition is No and no task exists. When the exception generated a
 * Recovery task, the same alert carries the task's details (employee, promised date, PROMISED payment amount — never the Billing Amount), so a single save
 * never produces two near-identical messages. The concerned employee is the dealer's authoritative current owner (the task's officer when there is one).
 */
export async function notifyBillingExceptionCreated(tx: Db, L: AlertLabels, e: BillingExceptionAlert): Promise<void> {
  const ownerId = e.taskOfficerId ?? (await getCurrentOwnerByDealer([e.dealerId], tx)).get(e.dealerId) ?? null;
  const [recipients, taskOwner] = await Promise.all([
    alertRecipients(tx, ownerId),
    e.taskOfficerId ? tx.user.findUnique({ where: { id: e.taskOfficerId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const { title, message } = buildExceptionMessage(L, {
    dealer: e.dealerName, billNo: e.billNo, billingDate: e.billingDate, billingAmount: e.billingAmount, authPerson: e.authPerson,
    paymentCondition: e.paymentCondition, paymentDate: e.paymentDate, paymentAmount: e.paymentAmount, employee: taskOwner?.name ?? null,
  });
  await notifyMany(recipients, { type: NotificationType.SYSTEM, title, message, relatedEntityType: "BillingException", relatedEntityId: e.exceptionId }, tx);
}
