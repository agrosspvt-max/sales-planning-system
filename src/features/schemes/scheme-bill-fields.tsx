"use client";
import type { SchemePlan } from "./scheme-detail-dialog";
import { SchemeDateInput, FormattedNumberInput } from "./scheme-form-inputs";
import { NativeSelect } from "@/components/ui/select";
import { formatSchemeDate, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { combinedPresetValueErrors, splitBillAmount } from "@/lib/scheme-bills";
import { useLabel } from "@/features/labels/label-ui";
export interface BillEditor {
  billCount: number; amountWithoutGST: string; amountWithGST: string;
  bills: { partNumber: number; soBillDate: string; adminBillDate: string; amountWithoutGST: string; amountWithGST: string }[];
}
const iso = (v: string | null | undefined) => v?.slice(0,10) ?? "";
export function rebalanceBills(row: BillEditor, patch: Partial<Pick<BillEditor, "billCount" | "amountWithoutGST" | "amountWithGST">>): BillEditor {
  const next = { ...row, ...patch };
  const amounts = (v: string) => { try { return splitBillAmount(v, next.billCount); } catch { return Array<string>(next.billCount).fill(""); } };
  const without = amounts(next.amountWithoutGST), withGST = amounts(next.amountWithGST);
  return { ...next, bills: Array.from({ length: next.billCount }, (_, i) => ({ partNumber: i+1, soBillDate: row.bills[i]?.soBillDate ?? "", adminBillDate: row.bills[i]?.adminBillDate ?? "", amountWithoutGST: without[i], amountWithGST: withGST[i] })) };
}
export function initialBillEditor(plan: SchemePlan, admin: boolean): BillEditor {
  const billing = plan.billing;
  const billCount = (admin ? billing?.adminBillCount ?? billing?.soBillCount : billing?.soBillCount) ?? 1;
  const row = rebalanceBills({ billCount, amountWithoutGST: (admin ? billing?.amountWithoutGST ?? billing?.soAmountWithoutGST : billing?.soAmountWithoutGST) ?? billing?.defaultAmountWithoutGST ?? "", amountWithGST: (admin ? billing?.amountWithGST ?? billing?.soAmountWithGST : billing?.soAmountWithGST) ?? billing?.defaultAmountWithGST ?? "", bills: [] }, {});
  return { ...row, bills: row.bills.map(b => { const saved = billing?.bills.find(x => x.partNumber === b.partNumber); return { ...b,
    soBillDate: iso(saved?.soBillDate), adminBillDate: iso(saved?.adminBillDate),
    amountWithoutGST: (admin ? saved?.amountWithoutGST : saved?.soAmountWithoutGST) ?? b.amountWithoutGST,
    amountWithGST: (admin ? saved?.amountWithGST : saved?.soAmountWithGST) ?? b.amountWithGST,
  }; }) };
}
export function billEditorPayload(row: BillEditor, admin: boolean) {
  return { billCount: row.billCount, amountWithoutGST: row.amountWithoutGST, amountWithGST: row.amountWithGST,
    bills: row.bills.map(b => ({ partNumber: b.partNumber, amountWithoutGST: b.amountWithoutGST, amountWithGST: b.amountWithGST,
      ...(admin ? { adminBillDate: b.adminBillDate || null } : { soBillDate: b.soBillDate }) })) };
}
export function SchemeBillFields({ plan, rows: row, onChange, admin, disabled = false }: { plan: SchemePlan; rows: BillEditor; onChange: (v: BillEditor) => void; admin: boolean; disabled?: boolean }) {
  const countLabel = useLabel("scheme_bills.count"), withoutLabel = useLabel("scheme_master.form.value_without_gst"), withLabel = useLabel("scheme_master.form.value_with_gst"), soDateLabel = useLabel("scheme_bills.so_date"), adminDateLabel = useLabel("scheme_bills.admin_date");
  const locked = plan.billing?.locked ?? false;
  const minimumErrors = admin || !plan.billing ? [] : combinedPresetValueErrors(row, { amountWithoutGST: plan.billing.defaultAmountWithoutGST, amountWithGST: plan.billing.defaultAmountWithGST });
  return <section className="space-y-3 rounded-md border p-3">
    <h4 className="font-semibold">Combined Billing</h4>
    <p className="text-sm text-muted-foreground">{plan.numberOfSchemes || 1} scheme instance{(plan.numberOfSchemes || 1) === 1 ? "" : "s"} · One combined plan value</p>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm">{admin ? "Admin combined total" : "Combined total"} — {withoutLabel}<FormattedNumberInput disabled={locked} value={row.amountWithoutGST} onValueChange={v => onChange(rebalanceBills(row, { amountWithoutGST: v }))} /></label>
      <label className="text-sm">{admin ? "Admin combined total" : "Combined total"} — {withLabel}<FormattedNumberInput disabled={locked} value={row.amountWithGST} onValueChange={v => onChange(rebalanceBills(row, { amountWithGST: v }))} /></label>
    </div>
    {minimumErrors.map(message => <p key={message} className="text-xs text-destructive">{message}</p>)}
    {admin && <p className="text-xs text-muted-foreground">SO combined total: {formatCurrency(plan.billing?.soAmountWithoutGST ?? 0)} Without GST / {formatCurrency(plan.billing?.soAmountWithGST ?? 0)} With GST · SO bills: {plan.billing?.soBillCount ?? "—"}</p>}
    <label className="flex items-center gap-3 text-sm">{countLabel}<NativeSelect aria-label={countLabel} className="w-20" disabled={locked} value={String(row.billCount)} options={[1,2,3,4,5].map(n => ({ value: String(n), label: String(n) }))} onChange={e => onChange(rebalanceBills(row, { billCount: Number(e.target.value) }))} /></label>
    {locked && <p className="text-xs text-muted-foreground">Combined totals, bill count and booking are locked because a schedule exists.</p>}
    {row.bills.map((b,j) => { const old = plan.billing?.bills.find(x => x.partNumber === b.partNumber); const patch = (value: Partial<typeof b>) => onChange({ ...row, bills: row.bills.map((x,k) => k === j ? { ...x, ...value } : x) }); return <div key={b.partNumber} className="space-y-2 rounded border p-2">
      <div className="font-medium">Part Bill {b.partNumber} {old?.verified && <span className="text-emerald-600">✓ Verified billing</span>}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {admin ? <><div className="text-sm">{soDateLabel}: {formatSchemeDate(old?.soBillDate)}</div><label className="text-sm">{adminDateLabel}<SchemeDateInput disabled={disabled || old?.verified} value={b.adminBillDate} onValueChange={v => patch({ adminBillDate: v })} /></label></> : <label className="text-sm">{soDateLabel}<SchemeDateInput disabled={locked} value={b.soBillDate} onValueChange={v => patch({ soBillDate: v })} /></label>}
        <label className="text-sm">{withoutLabel}<FormattedNumberInput disabled={admin ? old?.verified : locked} value={b.amountWithoutGST} onValueChange={v => patch({ amountWithoutGST: v })} /></label>
        <label className="text-sm">{withLabel}<FormattedNumberInput disabled={admin ? old?.verified : locked} value={b.amountWithGST} onValueChange={v => patch({ amountWithGST: v })} /></label>
      </div>
    </div>; })}
    <p className="text-xs text-muted-foreground">Bill amounts must equal the combined total. Changing the total or bill count divides it equally, with any paise remainder in the final bill.{admin && ` Leave pending dates blank. Booking is deducted once, from the final installment of Part Bill ${row.billCount}.`}</p>
  </section>;
}
