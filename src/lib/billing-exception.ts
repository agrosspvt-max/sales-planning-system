/**
 * Billing Exception — PURE rules (no DB, no React): the Billing Status derived from the report's Days, and the input validation shared by the
 * form (client) and the API (server). Informational only: nothing here blocks an invoice or changes another billing workflow.
 */

/** A dealer whose Days (today − last payment date) is MORE than this is billing-blocked. Exactly 45 is still Open. */
export const BILLING_BLOCK_DAYS = 45;

export type BillingStatus = "OPEN" | "BLOCKED" | "BILLING_EXCEPTION" | "UNAVAILABLE";
export const BILLING_STATUS_LABEL: Record<BillingStatus, string> = { OPEN: "Open", BLOCKED: "Blocked", BILLING_EXCEPTION: "Billing Exception", UNAVAILABLE: "Unavailable" };

/**
 * Billing Status from the report's own Days value and the dealer's number of CURRENT exceptions.
 *  - Days ≤ 45 → Open (an exception record never changes that).
 *  - Days > 45 → Billing Exception when at least one current exception exists, otherwise Blocked.
 *  - Days = null (no payment date) → Unavailable: a neutral, non-clickable state. A missing payment is never treated as 0 (Open) and never
 *    invented as blocked: no business rule defines how a dealer WITHOUT any payment is billed, so none is assumed.
 */
export function billingStatusOf(days: number | null | undefined, currentExceptions: number): BillingStatus {
  if (days === null || days === undefined || !Number.isFinite(days)) return "UNAVAILABLE";
  if (days <= BILLING_BLOCK_DAYS) return "OPEN";
  return currentExceptions > 0 ? "BILLING_EXCEPTION" : "BLOCKED";
}
/** Only Blocked and Billing Exception open the "Create a Billing Exception" action. */
export const billingStatusClickable = (status: BillingStatus): boolean => status === "BLOCKED" || status === "BILLING_EXCEPTION";

export const AUTH_PERSONS = ["Varun sir", "Tej Sir"] as const;
export type AuthPerson = (typeof AUTH_PERSONS)[number];
export const BILL_NO_MAX = 60;

export type ExceptionStatus = "CURRENT" | "RESOLVED";
export const RESOLUTION_PAYMENT_RECEIVED = "PAYMENT_RECEIVED";
export const RESOLUTION_LABEL: Record<string, string> = { [RESOLUTION_PAYMENT_RECEIVED]: "Payment received — Days fell to 45 or less" };

export type PaymentCondition = "YES" | "NO";
export const BILLING_AMOUNT_MAX = 1e12;
export interface BillingExceptionInput {
  dealerId: string; billingDate: string; billNo: string; authPerson: AuthPerson; requestId: string;
  /** The exception's own billing / payment-condition amount (positive, 2 decimals) — NOT the dealer's previous payment. */
  billingAmount: number;
  /** Explicit Yes / No. */
  paymentCondition: PaymentCondition;
  /** The promised recovery date: required for Yes, always null for No. */
  paymentDate: string | null;
  /** The PROMISED RECOVERY amount ("Payment"): required (positive, 2 decimals) for Yes — never defaulted from the billing amount — always null for No. */
  paymentAmount: number | null;
}
const isRealDate = (iso: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
};

/** Validate the form values (what the client checks before Save and the server checks again). No date-range rule is invented. */
export const PAYMENT_DATE_PAST_MESSAGE = "Date of Payment cannot be before today: Daily Work only plans today and later days, and submitted days are never rewritten.";
/** A positive amount with at most two decimals (the monetary precision used everywhere: Decimal(14,2)). */
export function parseBillingAmount(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/,/g, "") : "";
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n < BILLING_AMOUNT_MAX ? n : null;
}
export function validateBillingExceptionInput(raw: unknown, today?: string): { value: BillingExceptionInput } | { error: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const dealerId = typeof o.dealerId === "string" ? o.dealerId.trim() : "";
  if (!dealerId) return { error: "Select a dealer." };
  const billingDate = typeof o.billingDate === "string" ? o.billingDate.trim() : "";
  if (!billingDate) return { error: "Date of Billing is required." };
  if (!isRealDate(billingDate)) return { error: "Enter a valid Date of Billing." };
  const billNo = typeof o.billNo === "string" ? o.billNo.trim().replace(/\s+/g, " ") : "";
  if (!billNo) return { error: "Bill No is required." };
  if (billNo.length > BILL_NO_MAX) return { error: `Bill No can be at most ${BILL_NO_MAX} characters.` };
  if (typeof o.authPerson !== "string" || !(AUTH_PERSONS as readonly string[]).includes(o.authPerson)) return { error: "Select the Auth Person." };
  const requestId = typeof o.requestId === "string" ? o.requestId.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return { error: "Missing request identity. Close the form and try again." };
  const billingAmount = parseBillingAmount(o.billingAmount);
  if (billingAmount === null) return { error: o.billingAmount === undefined || o.billingAmount === "" || o.billingAmount === null ? "Amount is required." : "Enter a positive Amount with at most two decimals." };
  const condition = o.paymentCondition === true ? "YES" : o.paymentCondition === false ? "NO" : o.paymentCondition;
  if (condition !== "YES" && condition !== "NO") return { error: "Select Yes or No for the payment condition." };
  let paymentDate: string | null = null, paymentAmount: number | null = null;
  if (condition === "YES") {
    paymentDate = typeof o.paymentDate === "string" ? o.paymentDate.trim() : "";
    if (!paymentDate) return { error: "Date of Payment is required when there is a payment condition." };
    if (!isRealDate(paymentDate)) return { error: "Enter a valid Date of Payment." };
    if (today && paymentDate < today) return { error: PAYMENT_DATE_PAST_MESSAGE };
    paymentAmount = parseBillingAmount(o.paymentAmount);
    if (paymentAmount === null) return { error: o.paymentAmount === undefined || o.paymentAmount === "" || o.paymentAmount === null ? "Payment is required when there is a payment condition." : "Enter a positive Payment with at most two decimals." };
  } // No: any date / payment sent is ignored — a "No" never carries either (so Yes → No can never leave a task behind)
  return { value: { dealerId, billingDate, billNo, authPerson: o.authPerson as AuthPerson, requestId, billingAmount, paymentCondition: condition, paymentDate, paymentAmount } };
}

/* ------------------------------ exception rows (Current / History) ------------------------------ */

/** One row of Billing Exception → Current / History: the report's eight columns + the exception's own identity. */
/* ------------------------------ summary panel (Total Ex. Bills / Dealers / Top Dealers / Top SO) ------------------------------ */

export interface ExceptionRankEntry {
  /** Stable id (dealer id / Sales Officer id) — the grouping key; the name is display only. */
  id: string; name: string; bills: number;
  /** Sum of the exceptions' OWN saved Billing Amounts. Exceptions without one add nothing (never an invented amount). */
  amount: number;
  /** True when at least one of this entry's exceptions has no saved Billing Amount (legacy) — the amount is then a lower bound. */
  incomplete: boolean;
}
export interface ExceptionRanking { byBills: ExceptionRankEntry[]; byAmount: ExceptionRankEntry[] }
export interface ExceptionSummary {
  totalBills: number; dealers: number;
  topDealers: ExceptionRanking; topOfficers: ExceptionRanking;
  /** Some exception in the section has no saved Billing Amount — displayed amount totals are incomplete. */
  amountsIncomplete: boolean;
}
export const TOP_DEALERS_LIMIT = 5, TOP_OFFICERS_LIMIT = 3;
export interface SummarySource { exceptionId: string; dealerId: string; party: string; officerId: string | null; officerName: string | null; billingAmount: number | null }

const cents = (n: number) => Math.round(n * 100);
function rank(entries: ExceptionRankEntry[], limit: number): ExceptionRanking {
  // Stable ordering: the chosen metric (desc), then the other metric (desc), then name (A→Z), then id — so ties never reshuffle between requests.
  const tail = (a: ExceptionRankEntry, b: ExceptionRankEntry) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return {
    byBills: [...entries].sort((a, b) => b.bills - a.bills || cents(b.amount) - cents(a.amount) || tail(a, b)).slice(0, limit),
    byAmount: [...entries].sort((a, b) => cents(b.amount) - cents(a.amount) || b.bills - a.bills || tail(a, b)).slice(0, limit),
  };
}
/**
 * PURE. The panel's numbers over the COMPLETE filtered set of exception rows (one source row per exception; duplicates of an exception id are ignored).
 * Dealers and Sales Officers are grouped by id; an exception without an assigned Sales Officer counts in the totals but is left out of the officer ranking.
 * Each ranking is recomputed from all entries for its metric — never a re-sort of another metric's top few.
 */
export function summarizeExceptions(items: readonly SummarySource[]): ExceptionSummary {
  const seen = new Set<string>();
  const dealers = new Map<string, ExceptionRankEntry>(), officers = new Map<string, ExceptionRankEntry>();
  let totalBills = 0, amountsIncomplete = false;
  const add = (map: Map<string, ExceptionRankEntry>, id: string, name: string, amount: number | null) => {
    const e = map.get(id) ?? { id, name, bills: 0, amount: 0, incomplete: false };
    e.bills++;
    if (amount === null) e.incomplete = true; else e.amount = (cents(e.amount) + cents(amount)) / 100;
    map.set(id, e);
  };
  for (const it of items) {
    if (seen.has(it.exceptionId)) continue;
    seen.add(it.exceptionId);
    totalBills++;
    const amount = it.billingAmount !== null && Number.isFinite(it.billingAmount) ? it.billingAmount : null;
    if (amount === null) amountsIncomplete = true;
    add(dealers, it.dealerId, it.party, amount);
    if (it.officerId) add(officers, it.officerId, it.officerName ?? "—", amount);
  }
  return { totalBills, dealers: dealers.size, topDealers: rank([...dealers.values()], TOP_DEALERS_LIMIT), topOfficers: rank([...officers.values()], TOP_OFFICERS_LIMIT), amountsIncomplete };
}
export const EMPTY_EXCEPTION_SUMMARY: ExceptionSummary = summarizeExceptions([]);

export interface BillingExceptionRow {
  exceptionId: string;
  dealerId: string;
  party: string;
  status: string;
  state: string | null;
  territory: string | null;
  salesOfficer: string | null;
  lastPaymentDate: string | null;
  amount: number | null;
  /** Current: the dealer's RUNNING Days (drives sorting, filters, status and resolution). History: the frozen snapshot. */
  days: number | null;
  /** The Days frozen on THIS exception when it was created (its own snapshot; null only if unavailable). Display only — never decides Current / Resolved. */
  frozenDays: number | null;
  billingDate: string;
  billNo: string;
  authPerson: string;
  exceptionStatus: ExceptionStatus;
  createdAt: string;
  /** The exception's own billing amount (null for exceptions recorded before it existed) — distinct from the last-payment Amount above. */
  billingAmount: number | null;
  /** "YES" | "NO" | null (recorded before the question existed). */
  paymentCondition: PaymentCondition | null;
  paymentDate: string | null;
  /** The promised recovery amount (null = No condition, or recorded before the field existed). Not the billing amount. */
  paymentAmount: number | null;
}
export type ExceptionView = "current" | "history";
export const parseExceptionView = (value: string | null | undefined): ExceptionView => (value === "history" ? "history" : "current");

export interface BillingTaskSummary {
  id: string; officerName: string; amount: number; promisedDate: string; taskDate: string; rescheduled: boolean;
  /** SCHEDULED = waiting for its day · IN_DAILY_WORK = added to a Recovery plan · OVERDUE = its day has passed and it is still waiting (still shown at the next editable day). */
  status: "SCHEDULED" | "IN_DAILY_WORK" | "OVERDUE"; confirmed: boolean;
}
export interface BillingExceptionDetail {
  id: string; dealerId: string; party: string; billingDate: string; billNo: string; authPerson: string;
  createdAt: string; createdByName: string; exceptionStatus: ExceptionStatus;
  resolvedAt: string | null; resolutionReason: string | null; resolvedDays: number | null;
  /** Billing Amount / payment condition / promised date (null = recorded before they were collected) and the related Recovery task. */
  billingAmount: number | null; paymentCondition: PaymentCondition | null; paymentDate: string | null; paymentAmount: number | null;
  task: BillingTaskSummary | null;
  snapshot: { days: number; lastPaymentDate: string | null; amount: number | null; status: string; state: string | null; territory: string | null; salesOfficer: string | null };
}

/** Export columns of the two exception views (the report's eight + the exception's own fields). */
export const EXCEPTION_EXPORT_COLUMNS: readonly { key: string; label: string; format: "text" | "number" | "currency" | "date" }[] = [
  { key: "party", label: "Party", format: "text" }, { key: "status", label: "Status", format: "text" }, { key: "state", label: "State", format: "text" },
  { key: "territory", label: "Territory", format: "text" }, { key: "salesOfficer", label: "Sales Officer", format: "text" },
  { key: "lastPaymentDate", label: "Last Payment Date", format: "date" }, { key: "amount", label: "Amount", format: "currency" }, { key: "days", label: "Days", format: "number" }, { key: "frozenDays", label: "Days at Exception Creation", format: "number" },
  { key: "billingDate", label: "Billing Date", format: "date" }, { key: "billNo", label: "Bill No", format: "text" }, { key: "authPerson", label: "Authorized By", format: "text" },
  { key: "exceptionStatus", label: "Exception", format: "text" },
  { key: "billingAmount", label: "Billing Amount", format: "currency" }, { key: "paymentCondition", label: "Payment Condition", format: "text" }, { key: "paymentDate", label: "Promised Date of Payment", format: "date" }, { key: "paymentAmount", label: "Promised Payment Amount", format: "currency" },
];
