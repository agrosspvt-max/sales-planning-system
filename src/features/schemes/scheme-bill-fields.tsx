"use client";
import type { SchemePlan } from "./scheme-detail-dialog";
import { SchemeDateInput, FormattedNumberInput } from "./scheme-form-inputs";
import { NativeSelect } from "@/components/ui/select";
import { formatSchemeDate, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { allowedSchemeBillCounts, combinedPresetValueErrors, splitBillAmount } from "@/lib/scheme-bills";
import { effectiveProductQuantityTarget } from "@/lib/scheme-plan-quantity";
import { useLabel } from "@/features/labels/label-ui";
export interface BillEditor {
  billCount: number; amountWithoutGST: string; amountWithGST: string;
  bills: { partNumber: number; soBillDate: string; adminBillDate: string; amountWithoutGST: string; amountWithGST: string; products?: { productId: string; qty: string }[] }[];
}
const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 1000) / 1000;
const quantityFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

/** Apply a plan segment's proceeding units to per-scheme Product Quantity targets. Historical bill snapshots
 * have no per-scheme field and are therefore left untouched. */
export function productBillingForProceedingUnits(
  billing: NonNullable<SchemePlan["productBilling"]>,
  proceedingUnits: number,
): NonNullable<SchemePlan["productBilling"]> {
  if (billing.mode !== "QUANTITY_TARGET") return billing;
  return {
    ...billing,
    products: billing.products.map((product) => product.perSchemeCommittedQty == null
      ? product
      : { ...product, committedQty: effectiveProductQuantityTarget(product.perSchemeCommittedQty, proceedingUnits) }),
  };
}

/** Compact read-only Scheme Master target reference for the SO conversion modal. Value Based schemes have
 * no predefined product quantity, so they intentionally return no quantity summary. */
export function schemeTargetQuantitySummary(plan: SchemePlan): string | null {
  const billing = plan.productBilling;
  if (!billing?.active || billing.mode !== "QUANTITY_TARGET") return null;
  const products = billing.products.flatMap((product) => product.committedQty == null
    ? []
    : [`${product.name} ${quantityFormat.format(product.committedQty)}`]);
  return products.length > 0 ? products.join(", ") : null;
}

/** Recompute a Product-Quantity billing editor from its per-bill quantities: fills the SO final bill with the
 *  per-product remainder, then derives every bill's amounts (Σ qty × rate) and the combined total. */
function pqRecompute(row: BillEditor, pb: NonNullable<SchemePlan["productBilling"]>, admin: boolean): BillEditor {
  const n = row.billCount;
  const bills = Array.from({ length: n }, (_, i) => {
    const existing = row.bills[i];
    const products = pb.products.map((p) => ({ productId: p.productId, qty: existing?.products?.find((x) => x.productId === p.productId)?.qty ?? "" }));
    return { partNumber: i + 1, soBillDate: existing?.soBillDate ?? "", adminBillDate: existing?.adminBillDate ?? "", amountWithoutGST: "", amountWithGST: "", products };
  });
  if (!admin && pb.mode === "QUANTITY_TARGET") {
    for (const p of pb.products) {
      let earlier = 0;
      for (let i = 0; i < n - 1; i++) earlier += Number(bills[i].products.find((x) => x.productId === p.productId)?.qty) || 0;
      const last = bills[n - 1].products.find((x) => x.productId === p.productId);
      if (last) last.qty = String(round3((p.committedQty ?? 0) - earlier));
    }
  }
  let totWo = 0, totW = 0;
  for (const b of bills) {
    let wo = 0, w = 0;
    for (const p of pb.products) { const q = Number(b.products.find((x) => x.productId === p.productId)?.qty) || 0; wo += q * p.rateWithoutGST; w += q * p.rateWithGST; }
    b.amountWithoutGST = round2(wo).toFixed(2); b.amountWithGST = round2(w).toFixed(2); totWo += wo; totW += w;
  }
  return { ...row, amountWithoutGST: round2(totWo).toFixed(2), amountWithGST: round2(totW).toFixed(2), bills };
}
export function recomputeProductBillEditor(row: BillEditor, pb: NonNullable<SchemePlan["productBilling"]>, admin: boolean): BillEditor {
  return pqRecompute(row, pb, admin);
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
      ...(b.products ? { products: b.products.map(p => ({ productId: p.productId, qty: Number(p.qty) || 0 })) } : {}),
      ...(admin ? { adminBillDate: b.adminBillDate || null } : { soBillDate: b.soBillDate }) })) };
}
/** Seed a Product-Quantity editor: per-bill product quantities from the saved snapshot (soQty for SO,
 *  adminQty falling back to soQty for Admin reference), then recompute amounts/remainder. */
export function initialProductBillEditor(plan: SchemePlan, admin: boolean): BillEditor {
  const pb = plan.productBilling!;
  const base = initialBillEditor(plan, admin);
  const seeded: BillEditor = { ...base, bills: base.bills.map((b) => ({ ...b, products: pb.products.map((p) => {
    const saved = pb.bills.find((x) => x.partNumber === b.partNumber && x.productId === p.productId);
    const q = admin ? (saved?.adminQty ?? saved?.soQty) : saved?.soQty;
    return { productId: p.productId, qty: q != null ? String(q) : "" };
  }) })) };
  return recomputeProductBillEditor(seeded, pb, admin);
}
export function SchemeBillFields({ plan, rows: row, onChange, admin, disabled = false }: { plan: SchemePlan; rows: BillEditor; onChange: (v: BillEditor) => void; admin: boolean; disabled?: boolean }) {
  const countLabel = useLabel("scheme_bills.count"), withoutLabel = useLabel("scheme_master.form.value_without_gst"), withLabel = useLabel("scheme_master.form.value_with_gst"), soDateLabel = useLabel("scheme_bills.so_date"), adminDateLabel = useLabel("scheme_bills.admin_date");
  const locked = plan.billing?.locked ?? false;
  const pb = plan.productBilling;
  const targetQuantitySummary = schemeTargetQuantitySummary(plan);
  // Admin verification retains its existing 1–5 correction range. The Scheme Master ceiling governs the SO
  // conversion choice; a saved historical SO count remains visible so existing data is never discarded.
  const billCountOptions = admin
    ? [1, 2, 3, 4, 5]
    : allowedSchemeBillCounts(plan.maxBillCount, plan.billing?.soBillCount);
  if (pb?.active) {
    // Product-rate billing: the SO/Admin enter quantities per product per bill; amounts are derived from the
    // historical rate snapshot and remain read-only. Quantity-target schemes retain their final-bill remainder;
    // Value Based schemes have no predefined product quantity, so every bill quantity remains editable.
    const setQty = (billIdx: number, productId: string, qty: string) => onChange(pqRecompute({ ...row, bills: row.bills.map((b, k) => k === billIdx ? { ...b, products: (b.products ?? pb.products.map((p) => ({ productId: p.productId, qty: "" }))).map((x) => x.productId === productId ? { ...x, qty } : x) } : b) }, pb, admin));
    const soQtyRef = (partNumber: number, productId: string) => pb.bills.find((x) => x.partNumber === partNumber && x.productId === productId)?.soQty;
    return <section className="space-y-3 rounded-md border p-3">
      {admin ? <>
        <h4 className="font-semibold">Combined Billing</h4>
        <p className="text-sm text-muted-foreground">Product billing — amounts are calculated from quantity × the scheme&apos;s historical product rate.</p>
      </> : <>
        <h4 className="font-semibold">Scheme Details</h4>
        {targetQuantitySummary && <p className="break-words text-sm leading-relaxed text-muted-foreground">{targetQuantitySummary}</p>}
      </>}
      <label className="flex items-center gap-3 text-sm">{countLabel}<NativeSelect aria-label={countLabel} className="w-20" disabled={locked} value={String(row.billCount)} options={billCountOptions.map(n => ({ value: String(n), label: String(n) }))} onChange={e => onChange(pqRecompute({ ...row, billCount: Number(e.target.value) }, pb, admin))} /></label>
      {locked && <p className="text-xs text-muted-foreground">Bill count and quantities are locked because a schedule exists.</p>}
      {row.bills.map((b, j) => { const old = plan.billing?.bills.find(x => x.partNumber === b.partNumber); const isFinal = b.partNumber === row.billCount; const patchDate = (value: Partial<typeof b>) => onChange({ ...row, bills: row.bills.map((x,k) => k === j ? { ...x, ...value } : x) }); return <div key={b.partNumber} className="space-y-2 rounded border p-2">
        <div className="font-medium">Part Bill {b.partNumber} {old?.verified && <span className="text-emerald-600">✓ Verified billing</span>}</div>
        {admin ? <div className="text-sm">{soDateLabel}: {formatSchemeDate(old?.soBillDate)} · <label className="inline-flex items-center gap-1">{adminDateLabel}<SchemeDateInput disabled={disabled || old?.verified} value={b.adminBillDate} onValueChange={v => patchDate({ adminBillDate: v })} /></label></div>
          : <label className="text-sm">{soDateLabel}<SchemeDateInput disabled={locked} value={b.soBillDate} onValueChange={v => patchDate({ soBillDate: v })} /></label>}
        <table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="py-1">Product</th>{admin && <th className="py-1 text-right">SO Qty</th>}<th className="py-1 text-right">{admin ? "Actual Qty" : "Qty"}</th><th className="py-1 text-right">{withoutLabel}</th><th className="py-1 text-right">{withLabel}</th></tr></thead>
          <tbody>{pb.products.map((p) => { const q = b.products?.find((x) => x.productId === p.productId)?.qty ?? ""; const qn = Number(q) || 0; const roQty = !admin && pb.mode === "QUANTITY_TARGET" && isFinal; return <tr key={p.productId}>
            <td className="py-1">{p.name}</td>
            {admin && <td className="py-1 text-right tabular-nums text-muted-foreground">{soQtyRef(b.partNumber, p.productId) ?? "—"}</td>}
            <td className="py-1 text-right"><FormattedNumberInput className="w-24" disabled={locked || (admin ? old?.verified : false) || roQty} value={q} onValueChange={(v) => setQty(j, p.productId, v)} /></td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(round2(qn * p.rateWithoutGST))}</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(round2(qn * p.rateWithGST))}</td>
          </tr>; })}</tbody></table>
        <div className="text-right text-xs text-muted-foreground">Bill total: {formatCurrency(Number(b.amountWithoutGST) || 0)} / {formatCurrency(Number(b.amountWithGST) || 0)}</div>
      </div>; })}
      <div className="rounded border bg-muted/20 p-2 text-sm font-medium">Verified Combined Total: {formatCurrency(Number(row.amountWithoutGST) || 0)} Without GST / {formatCurrency(Number(row.amountWithGST) || 0)} With GST</div>
      <p className="text-xs text-muted-foreground">{admin ? "Actual quantities are authoritative; the verified amounts above are the installment base." : pb.mode === "QUANTITY_TARGET" ? "The final bill receives each product's remaining committed quantity automatically." : "The combined calculated value must meet the selected Option's monetary target."}</p>
    </section>;
  }
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
    <label className="flex items-center gap-3 text-sm">{countLabel}<NativeSelect aria-label={countLabel} className="w-20" disabled={locked} value={String(row.billCount)} options={billCountOptions.map(n => ({ value: String(n), label: String(n) }))} onChange={e => onChange(rebalanceBills(row, { billCount: Number(e.target.value) }))} /></label>
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
