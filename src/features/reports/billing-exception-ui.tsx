"use client";
import { useRef, useState } from "react";
import { formatDateTimeDMY, formatDMY } from "@/lib/date-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/select";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dealerStatusLabel } from "@/lib/dealer-status";
import { useLabel } from "@/features/labels/label-ui";
import {
  AUTH_PERSONS, BILLING_STATUS_LABEL, RESOLUTION_LABEL, billingStatusClickable, validateBillingExceptionInput,
  type BillingExceptionDetail, type BillingExceptionInput, type BillingStatus,
} from "@/lib/billing-exception";

/** Query-key prefixes the report page uses — a saved exception refreshes every one of them. */
export const BILLING_QUERY_KEYS = ["last-payment-report", "last-payment-report-options", "billing-exceptions", "billing-exceptions-options", "account-access", "calendar", "calendar-upcoming"] as const; // account-access: re-reads the signed-in account's permissions (e.g. creation just revoked)

const dash = <span className="text-muted-foreground">—</span>;
const TASK_STATUS = { SCHEDULED: "Scheduled", IN_DAILY_WORK: "In Daily Work", OVERDUE: "Overdue — pending" } as const;
/** The Daily Work business date (India) — only a hint for the client check; the server decides. */
const businessToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateLabel = (iso: string) => formatDMY(iso);

const STATUS_STYLE: Record<BillingStatus, { variant: "success" | "warning" | "muted"; className?: string }> = {
  OPEN: { variant: "success" },                                            // green
  BLOCKED: { variant: "warning" },                                        // yellow
  BILLING_EXCEPTION: { variant: "muted", className: "bg-purple-500/15 text-purple-700 dark:text-purple-300" }, // purple
  UNAVAILABLE: { variant: "muted" },                                      // neutral
};

/** The Billing Status of one report row. Open and Unavailable are plain text badges; Blocked / Billing Exception are buttons that open the action popup. */
/** `clickable` is false for a Custom Admin without the explicit create permission (presentation only — the server enforces it). */
export function BillingStatusCell({ status, party, onOpen, clickable = true }: { status: BillingStatus; party: string; onOpen: () => void; clickable?: boolean }) {
  const style = STATUS_STYLE[status];
  const badge = <Badge variant={style.variant} className={style.className}>{BILLING_STATUS_LABEL[status]}</Badge>;
  if (!clickable || !billingStatusClickable(status)) return <span data-billing-status={status}>{badge}</span>;
  return (
    <button type="button" data-billing-status={status} aria-label={`${BILLING_STATUS_LABEL[status]} — create a billing exception for ${party}`} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen}>
      {badge}
    </button>
  );
}

/** Small popup shown after clicking Blocked / Billing Exception: its one action opens the exception form. */
export function BillingExceptionActionDialog({ dealerId, party, onClose }: { dealerId: string; party: string; onClose: () => void }) {
  const [step, setStep] = useState<"action" | "form">("action");
  const create = useLabel("billing_exception.action.create");
  if (step === "form") return <BillingExceptionForm dealerId={dealerId} party={party} onClose={onClose} />;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xs">
        <DialogHeader><DialogTitle>{party}</DialogTitle></DialogHeader>
        <Button onClick={() => setStep("form")}>{create}</Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The exception form. The dealer comes from the clicked row (read-only; its id is what is sent). `requestId` identifies THIS logical Save: it is created when the
 * form opens and re-sent unchanged on every retry / double click, so the server can tell a re-delivery from a deliberate second exception (a new form = a new id).
 */
function BillingExceptionForm({ dealerId, party, onClose }: { dealerId: string; party: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [requestId] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`));
  const [billingDate, setBillingDate] = useState("");
  const [billNo, setBillNo] = useState("");
  const [authPerson, setAuthPerson] = useState("");
  const [billingAmount, setBillingAmount] = useState("");
  const [condition, setCondition] = useState<"" | "YES" | "NO">(""); // required, mutually exclusive
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // synchronous guard: two clicks in the same tick cannot both pass (state alone updates a render later)
  const refresh = () => { for (const key of BILLING_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] }); };
  const save = useMutation({
    mutationFn: (body: BillingExceptionInput) => api.post("/api/reports/last-payment/billing-exceptions", body),
    onSettled: () => { inFlight.current = false; },
    onSuccess: () => { refresh(); onClose(); },
    onError: (e) => { setError((e as Error).message || "Could not save the Billing Exception."); refresh(); }, // entered values are kept; a stale Save also refreshes the report
  });
  const submit = () => {
    if (save.isPending || inFlight.current) return; // no repeated Save while a request is in flight
    const checked = validateBillingExceptionInput({ dealerId, billingDate, billNo, authPerson, requestId, billingAmount, paymentCondition: condition, paymentDate: condition === "YES" ? paymentDate : null, paymentAmount: condition === "YES" ? paymentAmount : null }, businessToday());
    if ("error" in checked) { setError(checked.error); return; }
    setError(null);
    inFlight.current = true;
    save.mutate(checked.value);
  };
  const L = {
    title: useLabel("billing_exception.form.title"), dealer: useLabel("billing_exception.form.dealer"), billingDate: useLabel("billing_exception.form.billing_date"), billNo: useLabel("billing_exception.form.bill_no"),
    authPerson: useLabel("billing_exception.form.auth_person"), authPlaceholder: useLabel("billing_exception.form.auth_placeholder"), amount: useLabel("billing_exception.form.amount"),
    amountPlaceholder: useLabel("billing_exception.form.amount_placeholder"), amountHint: useLabel("billing_exception.form.amount_hint"), condition: useLabel("billing_exception.form.condition"),
    yes: useLabel("billing_exception.form.yes"), no: useLabel("billing_exception.form.no"), paymentDate: useLabel("billing_exception.form.payment_date"),
    paymentAmount: useLabel("billing_exception.form.payment_amount"), paymentAmountPlaceholder: useLabel("billing_exception.form.payment_amount_placeholder"), paymentHint: useLabel("billing_exception.form.payment_hint"),
    cancel: useLabel("billing_exception.form.cancel"), save: useLabel("billing_exception.form.save"), saving: useLabel("billing_exception.form.saving"),
  };
  const plain = (label: string) => label.replace(/\s*\*\s*$/, ""); // accessible name without the required marker
  const rupee = <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden>₹</span>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto" data-testid="billing-exception-form">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        {/* Two equal columns from the small breakpoint up; one column (stacked) on narrow phones. Every label is bound to its control. */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="be-dealer">{L.dealer}</Label><Input id="be-dealer" value={party} readOnly aria-readonly="true" /></div>
          <div className="min-w-0 space-y-1.5"><Label htmlFor="be-date">{L.billingDate}</Label><DateInputDMY id="be-date" aria-label={plain(L.billingDate)} value={billingDate} onChange={setBillingDate} /></div>
          <div className="min-w-0 space-y-1.5"><Label htmlFor="be-bill">{L.billNo}</Label><Input id="be-bill" value={billNo} maxLength={60} onChange={(e) => setBillNo(e.target.value)} /></div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="be-auth">{L.authPerson}</Label>
            <NativeSelect id="be-auth" value={authPerson} placeholder={L.authPlaceholder} options={AUTH_PERSONS.map((p) => ({ value: p, label: p }))} onChange={(e) => setAuthPerson(e.target.value)} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="be-amount">{L.amount}</Label>
            <div className="relative">{rupee}<Input id="be-amount" className="pl-7" inputMode="decimal" placeholder={L.amountPlaceholder} value={billingAmount} onChange={(e) => setBillingAmount(e.target.value)} aria-describedby="be-amount-hint" /></div>
          </div>
          <p id="be-amount-hint" className="text-xs text-muted-foreground sm:col-span-2">{L.amountHint}</p>
          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="text-sm font-medium leading-none">{L.condition}</legend>
            <div className="flex gap-6 pt-1" role="radiogroup" aria-label={plain(L.condition)}>
              {(["YES", "NO"] as const).map((v) => (
                <label key={v} htmlFor={`be-condition-${v}`} className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input id={`be-condition-${v}`} type="radio" name="be-condition" value={v} checked={condition === v} onChange={() => { setCondition(v); if (v === "NO") { setPaymentDate(""); setPaymentAmount(""); } }} className="h-4 w-4 accent-primary" />
                  {v === "YES" ? L.yes : L.no}
                </label>
              ))}
            </div>
          </fieldset>
          {condition === "YES" && (
            <>
              <div className="min-w-0 space-y-1.5"><Label htmlFor="be-pay-date">{L.paymentDate}</Label><DateInputDMY id="be-pay-date" aria-label={plain(L.paymentDate)} value={paymentDate} onChange={setPaymentDate} /></div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="be-pay-amount">{L.paymentAmount}</Label>
                <div className="relative">{rupee}<Input id="be-pay-amount" className="pl-7" inputMode="decimal" placeholder={L.paymentAmountPlaceholder} value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} aria-describedby="be-pay-hint" /></div>
              </div>
              <p id="be-pay-hint" className="text-xs text-muted-foreground sm:col-span-2">{L.paymentHint}</p>
            </>
          )}
          {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>{L.cancel}</Button>
          <Button onClick={submit} disabled={save.isPending} aria-busy={save.isPending}>{save.isPending ? L.saving : L.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Details of EXACTLY the selected exception (by its id): dealer, billing date, bill no, auth person, created, creator, lifecycle, and the creation snapshot. */
export function BillingExceptionInfoDialog({ exceptionId, onClose }: { exceptionId: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<BillingExceptionDetail>({
    queryKey: ["billing-exception-detail", exceptionId],
    queryFn: () => api.get(`/api/reports/last-payment/billing-exceptions/${exceptionId}`),
  });
  const L = {
    title: useLabel("billing_exception.info.title"), dealer: useLabel("billing_exception.info.dealer"), billingDate: useLabel("billing_exception.info.billing_date"), billNo: useLabel("billing_exception.info.bill_no"),
    authPerson: useLabel("billing_exception.info.auth_person"), billingAmount: useLabel("billing_exception.info.billing_amount"), condition: useLabel("billing_exception.info.condition"),
    promisedDate: useLabel("billing_exception.info.promised_date"), promisedAmount: useLabel("billing_exception.info.promised_amount"), task: useLabel("billing_exception.info.task"),
    notRecorded: useLabel("billing_exception.info.not_recorded"), close: useLabel("billing_exception.info.close"), yes: useLabel("billing_exception.form.yes"), no: useLabel("billing_exception.form.no"),
  };
  const field = (label: string, value: React.ReactNode) => <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-32 w-full" /> : error || !data ? <p role="alert" className="text-sm text-destructive">{(error as Error | null)?.message || "Could not load this Billing Exception."}</p> : (
          <dl data-testid="exception-info">
            {field(L.dealer, data.party)}
            {field(L.billingDate, dateLabel(data.billingDate))}
            {field(L.billNo, data.billNo)}
            {field(L.authPerson, data.authPerson)}
            {field(L.billingAmount, data.billingAmount !== null ? formatCurrency(data.billingAmount) : <span className="text-muted-foreground">{L.notRecorded}</span>)}
            {field(L.condition, data.paymentCondition === "YES" ? L.yes : data.paymentCondition === "NO" ? L.no : <span className="text-muted-foreground">{L.notRecorded}</span>)}
            {data.paymentCondition === "YES" && field(L.promisedDate, data.paymentDate ? dateLabel(data.paymentDate) : dash)}
            {/* The promised recovery amount — a separate value from the Billing Amount above (exceptions saved before it existed show "Not recorded"). */}
            {data.paymentCondition === "YES" && field(L.promisedAmount, data.paymentAmount !== null ? formatCurrency(data.paymentAmount) : <span className="text-muted-foreground">{L.notRecorded}</span>)}
            {data.task && field(L.task, `${data.task.officerName} · ${TASK_STATUS[data.task.status]}${data.task.taskDate !== data.task.promisedDate ? ` (now ${dateLabel(data.task.taskDate)})` : ""}`)}
            {field("Created", formatDateTimeDMY(data.createdAt))}
            {field("Created by", data.createdByName)}
            {field("Exception", <Badge variant={data.exceptionStatus === "CURRENT" ? "warning" : "muted"}>{data.exceptionStatus === "CURRENT" ? "Current" : "Resolved"}</Badge>)}
            {data.exceptionStatus === "RESOLVED" && field("Resolved", data.resolvedAt ? formatDateTimeDMY(data.resolvedAt) : dash)}
            {data.exceptionStatus === "RESOLVED" && field("Resolution", data.resolutionReason ? RESOLUTION_LABEL[data.resolutionReason] ?? data.resolutionReason : dash)}
            {data.exceptionStatus === "RESOLVED" && data.resolvedDays !== null && field("Days at resolution", data.resolvedDays)}
            <div className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">At creation</div>
            {field("Days", data.snapshot.days)}
            {field("Last Payment Date", data.snapshot.lastPaymentDate ? dateLabel(data.snapshot.lastPaymentDate) : dash)}
            {field("Amount", data.snapshot.amount !== null ? formatCurrency(data.snapshot.amount) : dash)}
            {field("Status", dealerStatusLabel(data.snapshot.status))}
          </dl>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
