"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildPaymentAging, paymentAgingLabel,
  type PaymentAgingDraft, type PaymentAgingFilter, type PaymentAgingOperator,
} from "@/lib/last-payment-report";

const OPERATORS: { value: PaymentAgingOperator; label: string }[] = [
  { value: "lt", label: "Less than" },
  { value: "gt", label: "Greater than" },
  { value: "eq", label: "Exactly" },
  { value: "between", label: "Between" },
];

const draftOf = (filter: PaymentAgingFilter | null): PaymentAgingDraft =>
  !filter ? { operator: "gt", value: "", from: "", to: "" }
  : filter.operator === "between" ? { operator: "between", value: "", from: String(filter.from), to: String(filter.to) }
  : { operator: filter.operator, value: String(filter.value), from: "", to: "" };

/**
 * The Payment Aging filter for the Days column — a dropdown beside the (separate) Days sort button, in the same
 * dropdown style as the other column filters. Apply validates the numbers; "All" clears the filter. The caller owns
 * the applied filter; the draft text lives here until Apply.
 */
export function PaymentAgingFilterControl({ value, onChange }: { value: PaymentAgingFilter | null; onChange: (next: PaymentAgingFilter | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentAgingDraft>(draftOf(value));
  const [error, setError] = useState<string | null>(null);
  const active = value !== null;

  const apply = () => {
    const built = buildPaymentAging(draft);
    if ("error" in built) { setError(built.error); return; }
    setError(null);
    onChange(built.filter);
    setOpen(false);
  };
  const set = (patch: Partial<PaymentAgingDraft>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) { setDraft(draftOf(value)); setError(null); } }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filter by Payment Aging"
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
        <div className="text-sm font-medium">Payment Aging</div>
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-muted-foreground">Show dealers with Days:</legend>
          {OPERATORS.map((op) => (
            <label key={op.value} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="payment-aging-operator" checked={draft.operator === op.value} onChange={() => set({ operator: op.value })} /> {op.label}
            </label>
          ))}
        </fieldset>
        {draft.operator === "between" ? (
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><span className="w-10">From</span>
              <Input inputMode="numeric" aria-label="Payment Aging from" value={draft.from} onChange={(e) => set({ from: e.target.value })} /></label>
            <label className="flex items-center gap-2"><span className="w-10">To</span>
              <Input inputMode="numeric" aria-label="Payment Aging to" value={draft.to} onChange={(e) => set({ to: e.target.value })} /></label>
          </div>
        ) : (
          <label className="flex items-center gap-2 text-sm"><span className="w-10">Value</span>
            <Input inputMode="numeric" aria-label="Payment Aging value" value={draft.value} onChange={(e) => set({ value: e.target.value })} /></label>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!active} onClick={() => { setError(null); onChange(null); setOpen(false); }}>Clear</Button>
          <Button type="button" size="sm" onClick={apply}>Apply</Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
