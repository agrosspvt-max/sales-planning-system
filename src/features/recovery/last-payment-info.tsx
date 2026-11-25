"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { formatDMY } from "@/lib/date-format";
import type { ReceiptPoint } from "@/lib/last-payment";

const currency = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);

export interface PaymentHistory {
  dealerName: string;
  payments: readonly ReceiptPoint[];
  throughDate: string | null;
  unavailableReason?: string | null;
}

export function PaymentHistoryContent({ payments, unavailableReason }: Pick<PaymentHistory, "payments" | "unavailableReason">) {
  const dateLabel = useLabel("recovery.paymentHistory.date");
  const amountLabel = useLabel("recovery.paymentHistory.amount");
  const totalLabel = useLabel("recovery.paymentHistory.total");
  const emptyLabel = useLabel("recovery.paymentHistory.empty");
  const shown = payments.filter(payment => payment.kind !== "snapshot").slice(0, 5);
  const total = shown.reduce((sum, payment) => sum + Math.round(payment.amount * 100), 0) / 100;
  if (!shown.length) return <p className="py-2 text-sm text-muted-foreground">{unavailableReason ?? emptyLabel}</p>;
  return <table className="w-full text-sm" data-testid="recent-payments">
    <thead><tr className="border-b text-muted-foreground"><th scope="col" className="py-2 text-left font-medium">{dateLabel}</th><th scope="col" className="py-2 text-right font-medium">{amountLabel}</th></tr></thead>
    <tbody>{shown.map((payment, index) => <tr key={`${payment.date}-${index}`} className="border-b">
      <td className="py-2 pr-4 tabular-nums">{formatDMY(payment.date)}</td>
      <td className="py-2 text-right tabular-nums">{currency(payment.amount)}</td>
    </tr>)}</tbody>
    <tfoot><tr><th scope="row" className="pt-3 text-left font-semibold">{totalLabel} ({shown.length})</th><td className="pt-3 text-right font-semibold tabular-nums">{currency(total)}</td></tr></tfoot>
  </table>;
}

/** Hover/focus gives a portal preview above the scrolling grid; click opens an accessible, persistent dialog. */
export function LastPaymentInfo({ dealerName, payments, throughDate, unavailableReason }: PaymentHistory) {
  const title = useLabel("recovery.paymentHistory.title");
  const throughLabel = useLabel("recovery.paymentHistory.through");
  const previewId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ top: number; left: number; width: number; maxHeight: number; transform?: string } | null>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const hideSoon = () => { cancelClose(); closeTimer.current = setTimeout(() => setPreview(null), 150); };
  const show = () => {
    cancelClose();
    if (open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const flip = below < 390 && above > below;
    setPreview({
      top: flip ? rect.top - 8 : rect.bottom + 8,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), width,
      maxHeight: Math.max(80, flip ? above : below),
      transform: flip ? "translateY(-100%)" : undefined,
    });
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!preview) return;
    const hide = () => setPreview(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", escape);
    };
  }, [preview]);
  const subtitle = throughDate ? `${throughLabel} ${formatDMY(throughDate)}` : null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><button ref={button} type="button" aria-label={`${title}: ${dealerName}`} aria-haspopup="dialog" aria-expanded={open}
      aria-describedby={preview ? previewId : undefined}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={() => setPreview(null)}
      onClick={() => { cancelClose(); setPreview(null); }}>
      <Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button></DialogTrigger>
    {preview && !open && createPortal(<div id={previewId} role="tooltip" style={preview}
      className="fixed z-[70] max-h-[calc(100vh-16px)] overflow-auto rounded-lg border bg-popover p-4 text-left text-popover-foreground shadow-xl"
      onMouseEnter={cancelClose} onMouseLeave={hideSoon}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 break-words text-xs text-muted-foreground">{dealerName}</p>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      <PaymentHistoryContent payments={payments} unavailableReason={unavailableReason} />
    </div>, document.body)}
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{dealerName}{subtitle && <span className="mt-1 block">{subtitle}</span>}</DialogDescription></DialogHeader>
      <PaymentHistoryContent payments={payments} unavailableReason={unavailableReason} />
    </DialogContent>
  </Dialog>;
}
