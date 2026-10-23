"use client";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLabel } from "@/features/labels/label-ui";
import {
  AGING_APPLY_DELAY_MS, agingAutoApply, paymentAgingLabel,
  type PaymentAgingDraft, type PaymentAgingFilter, type PaymentAgingOperator,
} from "@/lib/last-payment-report";


const draftOf = (filter: PaymentAgingFilter | null): PaymentAgingDraft =>
  !filter ? { operator: "gt", value: "", from: "", to: "" }
  : filter.operator === "between" ? { operator: "between", value: "", from: String(filter.from), to: String(filter.to) }
  : { operator: filter.operator, value: String(filter.value), from: "", to: "" };

/**
 * The Payment Aging filter for the Days column — a dropdown beside the (separate) Days sort button, in the same
 * dropdown style as the other column filters. A valid number / range is applied automatically after a short typing delay
 * (incomplete input is left alone, wrong input shows a message and is never applied); Clear removes the filter. The caller owns
 * the applied filter; the draft text lives here.
 */
export function PaymentAgingFilterControl({ value, onChange }: { value: PaymentAgingFilter | null; onChange: (next: PaymentAgingFilter | null) => void }) {
  // Display wording comes from the label system (Edit Labels); the operator VALUES ("lt" / "gt" / "eq" / "between") and the comparison logic never change.
  const OPERATORS: { value: PaymentAgingOperator; label: string }[] = [
    { value: "lt", label: useLabel("last_payment.aging.op_lt") },
    { value: "gt", label: useLabel("last_payment.aging.op_gt") },
    { value: "eq", label: useLabel("last_payment.aging.op_eq") },
    { value: "between", label: useLabel("last_payment.aging.op_between") },
  ];
  const valueLabel = useLabel("last_payment.aging.value");
  const T = { title: useLabel("last_payment.aging.title"), legend: useLabel("last_payment.aging.legend"), from: useLabel("last_payment.aging.from"), to: useLabel("last_payment.aging.to"), clear: useLabel("last_payment.aging.clear"),
    ariaFilter: useLabel("last_payment.aria.aging_filter"), ariaFrom: useLabel("last_payment.aria.aging_from"), ariaTo: useLabel("last_payment.aria.aging_to"), ariaValue: useLabel("last_payment.aria.aging_value") };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentAgingDraft>(draftOf(value));
  const active = value !== null;

  const status = agingAutoApply(draft);
  const error = status.kind === "invalid" ? status.error : null;
  const readyKey = status.kind === "ready" ? paymentAgingLabel(status.filter) : null;
  const currentKey = value ? paymentAgingLabel(value) : null;
  // Auto-apply: only while the menu is open (the user is editing), only for a valid value, only when it differs from what is applied.
  useEffect(() => {
    if (!open || status.kind !== "ready" || readyKey === currentKey) return;
    const timer = setTimeout(() => onChange(status.filter), AGING_APPLY_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, readyKey, currentKey]);
  const set = (patch: Partial<PaymentAgingDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      // Closing the menu inside the typing delay must not lose a valid value: apply it right away.
      if (!next && status.kind === "ready" && readyKey !== currentKey) onChange(status.filter);
      setOpen(next);
      if (next) setDraft(draftOf(value));
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={T.ariaFilter}
          className={`inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted ${active ? "text-primary" : ""}`}
        >
          {active && <span data-testid="aging-active">{paymentAgingLabel(value)}</span>}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[15rem] space-y-3 p-3 normal-case"
        onKeyDown={(event) => event.stopPropagation()} // typing digits must not trigger the menu's type-ahead
      >
        <div className="text-sm font-medium">{T.title}</div>
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-muted-foreground">{T.legend}</legend>
          {OPERATORS.map((op) => (
            <label key={op.value} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="payment-aging-operator" checked={draft.operator === op.value} onChange={() => set({ operator: op.value })} /> {op.label}
            </label>
          ))}
        </fieldset>
        {draft.operator === "between" ? (
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><span className="w-10">{T.from}</span>
              <Input inputMode="numeric" aria-label={T.ariaFrom} value={draft.from} onChange={(e) => set({ from: e.target.value })} /></label>
            <label className="flex items-center gap-2"><span className="w-10">{T.to}</span>
              <Input inputMode="numeric" aria-label={T.ariaTo} value={draft.to} onChange={(e) => set({ to: e.target.value })} /></label>
          </div>
        ) : (
          <label className="flex items-center gap-2 text-sm"><span className="w-10">{valueLabel}</span>
            <Input inputMode="numeric" aria-label={T.ariaValue} value={draft.value} onChange={(e) => set({ value: e.target.value })} /></label>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-start gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!active} onClick={() => { setDraft(draftOf(null)); onChange(null); setOpen(false); }}>{T.clear}</Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
