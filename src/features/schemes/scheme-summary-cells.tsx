"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { TableCell, TableHead } from "@/components/ui/table";
import { L, useLabel } from "@/features/labels/label-ui";
import type { LabelKey } from "@/features/labels/labels";

/**
 * The eight shared Scheme-wise SUMMARY metric columns (View Plan → Scheme-wise), reused by the SO/RM table
 * (`SchemeWiseCollapsibleView`) and the Admin table (`SchemeReviewWorkspace`) so the calculation and the
 * presentation live in ONE place. Values come from the server aggregation (`schemeWiseSummary`) — this file
 * only renders them. Phase 1: display only (clickable detail + column filters arrive in Phase 2).
 */

/** The per-scheme metric fields this renderer needs (mirrors the server SchemeWiseSummaryRow). */
export interface SchemeSummaryMetrics {
  plannedDealers: number;
  plannedSchemes: number;
  soConvertedDealers: number;
  adminConvertedDealers: number;
  soConvertedUnits: number;
  adminConvertedUnits: number;
  totalAmount: number;
  bookingReceived: number;
  documentReceived: number;
  soBillingFilled: number;
  adminBillingFilled: number;
}

/** One summary row from `/api/scheme-plans/scheme-summary` (metrics + the scheme's officers/states).
 *  In groupByOfficer (All Plan View) mode there is one row per (officer, scheme) with `salesOfficerId` set
 *  and `activeDealers` = that officer's own active-dealer count. */
export interface SchemeSummaryRow extends SchemeSummaryMetrics {
  schemeId: string;
  schemeName: string;
  salesOfficerNames: string[];
  states: string[];
  salesOfficerId: string | null;
  salesOfficerName: string | null;
  activeDealers: number;
}
/** The summary API payload: per-scheme rows + the scope-level active-dealer denominator + filter options. */
export interface SchemeWiseSummaryPayload {
  rows: SchemeSummaryRow[];
  activeDealers: number;
  filterOptions: { states: string[]; officers: { id: string; name: string }[] };
}

/* --------------------------- Column filters (Phase 2) --------------------------- */

/** The four server-side Scheme-wise filter groups (all applied server-side; metrics recalculate). */
export interface SummaryFilters { states: string[]; officers: string[]; booking: string[]; documents: string[] }
export const EMPTY_SUMMARY_FILTERS: SummaryFilters = { states: [], officers: [], booking: [], documents: [] };
export const hasAnyFilter = (f: SummaryFilters) => f.states.length > 0 || f.officers.length > 0 || f.booking.length > 0 || f.documents.length > 0;

/** Comma-separated query string for the summary API (empty groups omitted). */
export function summaryFilterQuery(f: SummaryFilters): string {
  const p = new URLSearchParams();
  if (f.states.length) p.set("states", f.states.join(","));
  if (f.officers.length) p.set("officers", f.officers.join(","));
  if (f.booking.length) p.set("booking", f.booking.join(","));
  if (f.documents.length) p.set("documents", f.documents.join(","));
  return p.toString();
}

/** Fixed Admin-controlled enum options (mirrors SchemeBookingStatus / SchemeAdminDocStatus). */
export const BOOKING_OPTIONS = [
  { value: "RECEIVED", label: "Paid" },
  { value: "PARTIAL", label: "Partially paid" },
  { value: "NOT_RECEIVED", label: "Not paid" },
];
export const DOCUMENT_OPTIONS = [
  { value: "RECEIVED_SOFT", label: "Soft Copy" },
  { value: "RECEIVED_HARD", label: "Hard Copy" },
  { value: "NOT_RECEIVED", label: "Not Received" },
];

interface Opt { value: string; label: string }

/**
 * A clickable column header that opens a multiselect popover (checkboxes + Apply / Clear). Values combine
 * OR within the group; the host combines groups with AND and refetches the server summary on Apply, so the
 * displayed metrics reflect the filtered population. Built on the app's `<details>` popover pattern.
 */
export function ColumnFilterHead({ labelKey, options, value, onApply, className }: {
  labelKey: LabelKey; options: Opt[]; value: string[]; onApply: (v: string[]) => void; className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  // Fixed viewport coordinates so the popover escapes the table/card overflow (no clipping). `placement`
  // flips it above the header when there isn't room below. `null` until measured → no first-frame flash.
  const [coords, setCoords] = useState<{ left: number; top: number; placement: "down" | "up" } | null>(null);
  const label = useLabel(labelKey);
  const toggle = (v: string) => setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]));
  const openMenu = () => { setDraft(value); setOpen(true); };
  const close = () => { setOpen(false); setCoords(null); };

  useEffect(() => {
    if (!open) return;
    const POP_W = 224; // w-56
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const needed = (popRef.current?.offsetHeight ?? 300) + 8;
      const up = spaceBelow < needed && r.top > spaceBelow; // flip up only when below is too small and above is roomier
      let left = r.right - POP_W; // right-align to the header, then clamp to the viewport
      left = Math.max(8, Math.min(left, window.innerWidth - POP_W - 8));
      setCoords({ left, top: up ? r.top - 4 : r.bottom + 4, placement: up ? "up" : "down" });
    };
    place();
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // `true` (capture) so the popover repositions even when an inner/table scroller — not just window — scrolls.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <TableHead className={className}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        className="flex cursor-pointer list-none items-center gap-1 font-normal normal-case text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {label}
        {value.length > 0 && <span className="rounded bg-primary/20 px-1 text-[10px] text-foreground">{value.length}</span>}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && coords && createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", left: coords.left, top: coords.top, transform: coords.placement === "up" ? "translateY(-100%)" : undefined }}
          className="z-50 w-56 rounded-md border bg-background p-2 text-left font-normal normal-case shadow-md"
        >
          <div className="max-h-56 overflow-auto">
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No options.</div>
            ) : options.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/60">
                <input type="checkbox" className="h-4 w-4" checked={draft.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
            <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => { setDraft([]); onApply([]); close(); }}>Clear</button>
            <button type="button" className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground" onClick={() => { onApply(draft); close(); }}>Apply</button>
          </div>
        </div>,
        document.body,
      )}
    </TableHead>
  );
}

/**
 * A metric value that opens a concise breakdown popover on click. Controlled: the parent row owns a single
 * `open` id (see `SchemeSummaryValueCells`) so at most one popover shows at a time. The cell stops click
 * propagation so opening a popover never toggles the expandable scheme row underneath it, and an outside
 * click (mousedown) closes it — which also collapses another row's open popover when you click a metric there.
 */
function MetricPopover({ open, onOpenChange, value, title, lines, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; value: ReactNode; title: string; lines: { label: string; value: string | number }[]; className?: string;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);
  return (
    <TableCell ref={ref} className={cn("text-right", className)} onClick={(e) => e.stopPropagation()}>
      <div className="relative inline-block text-left font-normal normal-case">
        <button type="button" className="cursor-pointer hover:underline" onClick={() => onOpenChange(!open)}>{value}</button>
        {open && (
          <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border bg-background p-2 text-xs shadow-md">
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
            {lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 py-0.5"><span className="text-muted-foreground">{l.label}</span><span className="tabular-nums font-medium">{l.value}</span></div>
            ))}
          </div>
        )}
      </div>
    </TableCell>
  );
}

/** The eight summary metric columns count — for colSpan math in the host tables. */
export const SUMMARY_METRIC_COLS = 8;

/** A "numerator / denominator" ratio. Denominator 0 renders as an em dash (nothing to divide by). */
function Ratio({ num, den }: { num: number; den: number }) {
  if (den === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums"><span className="font-medium">{num}</span><span className="text-muted-foreground">/{den}</span></span>;
}

interface FilterCtl { value: string[]; onApply: (v: string[]) => void }

/** The eight metric header cells. When `booking`/`documents` controllers are passed those two become
 *  clickable multiselect filter headers; the rest stay plain label-driven headers. */
export function SchemeSummaryHeads({ booking, documents }: { booking?: FilterCtl; documents?: FilterCtl } = {}) {
  return (
    <>
      <TableHead className="text-right"><L k="scheme_planning.col.planned_dealers" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.col.converted_dealers" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.col.planned_schemes" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.col.converted_schemes" /></TableHead>
      <TableHead className="text-right"><L k="scheme_planning.col.total_amount" /></TableHead>
      {booking
        ? <ColumnFilterHead labelKey="scheme_planning.col.booking_amount" options={BOOKING_OPTIONS} value={booking.value} onApply={booking.onApply} className="text-right" />
        : <TableHead className="text-right"><L k="scheme_planning.col.booking_amount" /></TableHead>}
      {documents
        ? <ColumnFilterHead labelKey="scheme_planning.col.document_status" options={DOCUMENT_OPTIONS} value={documents.value} onApply={documents.onApply} className="text-right" />
        : <TableHead className="text-right"><L k="scheme_planning.col.document_status" /></TableHead>}
      <TableHead className="text-right"><L k="scheme_planning.col.billing_status" /></TableHead>
    </>
  );
}

/**
 * The eight metric value cells for one scheme row.
 * - Planned Dealers  = planned / active (scope active-dealer denominator)
 * - Converted Dealers= admin-confirmed / SO-converted (dealers)
 * - Planned Schemes  = Σ numberOfSchemes
 * - Converted Schemes= admin-confirmed / SO-converted (units)
 * - Total Amount     = Σ authoritative amount over Admin-confirmed converted only
 * - Booking Amount   = booking-Received / SO-converted
 * - Document Status  = Admin-received / SO-converted
 * - Billing Status   = Admin billing filled / SO billing filled
 */
export function SchemeSummaryValueCells({ m, activeDealers }: { m: SchemeSummaryMetrics; activeDealers: number }) {
  // A single "which popover is open" id per row → at most one breakdown visible at a time. Clicking a metric
  // in another row closes this one via MetricPopover's outside-click handler.
  const [openId, setOpenId] = useState<string | null>(null);
  const pop = (id: string) => ({ open: openId === id, onOpenChange: (o: boolean) => setOpenId(o ? id : null) });
  return (
    <>
      <MetricPopover {...pop("plannedDealers")} value={<Ratio num={m.plannedDealers} den={activeDealers} />} title="Planned Dealers"
        lines={[{ label: "Planned", value: m.plannedDealers }, { label: "Active dealers", value: activeDealers }, { label: "Not planned", value: Math.max(0, activeDealers - m.plannedDealers) }]} />
      <MetricPopover {...pop("convertedDealers")} value={<Ratio num={m.adminConvertedDealers} den={m.soConvertedDealers} />} title="Converted Dealers"
        lines={[{ label: "SO Converted", value: m.soConvertedDealers }, { label: "Admin Confirmed", value: m.adminConvertedDealers }, { label: "Remaining", value: Math.max(0, m.soConvertedDealers - m.adminConvertedDealers) }]} />
      <MetricPopover {...pop("plannedSchemes")} value={<span className="tabular-nums">{m.plannedSchemes}</span>} title="Planned Schemes"
        lines={[{ label: "Scheme units", value: m.plannedSchemes }, { label: "Dealers", value: m.plannedDealers }]} />
      <MetricPopover {...pop("convertedSchemes")} value={<Ratio num={m.adminConvertedUnits} den={m.soConvertedUnits} />} title="Converted Schemes"
        lines={[{ label: "SO Converted (units)", value: m.soConvertedUnits }, { label: "Admin Confirmed (units)", value: m.adminConvertedUnits }, { label: "Remaining", value: Math.max(0, m.soConvertedUnits - m.adminConvertedUnits) }]} />
      <MetricPopover {...pop("totalAmount")} value={<span className="tabular-nums">{formatCurrency(m.totalAmount)}</span>} title="Total Amount"
        lines={[{ label: "Admin-confirmed dealers", value: m.adminConvertedDealers }, { label: "Amount", value: formatCurrency(m.totalAmount) }]} />
      <MetricPopover {...pop("bookingAmount")} value={<Ratio num={m.bookingReceived} den={m.soConvertedDealers} />} title="Booking Amount"
        lines={[{ label: "Received", value: m.bookingReceived }, { label: "SO Converted", value: m.soConvertedDealers }, { label: "Not received / other", value: Math.max(0, m.soConvertedDealers - m.bookingReceived) }]} />
      <MetricPopover {...pop("documentStatus")} value={<Ratio num={m.documentReceived} den={m.soConvertedDealers} />} title="Document Status"
        lines={[{ label: "Admin received", value: m.documentReceived }, { label: "SO Converted", value: m.soConvertedDealers }, { label: "Not received", value: Math.max(0, m.soConvertedDealers - m.documentReceived) }]} />
      <MetricPopover {...pop("billingStatus")} value={<Ratio num={m.adminBillingFilled} den={m.soBillingFilled} />} title="Billing Status"
        lines={[{ label: "SO billing filled", value: m.soBillingFilled }, { label: "Admin billing filled", value: m.adminBillingFilled }, { label: "Remaining", value: Math.max(0, m.soBillingFilled - m.adminBillingFilled) }]} />
    </>
  );
}

/** Zero metrics for a scheme with no summary row (defensive; the two data sources come from the same plans). */
export const ZERO_METRICS: SchemeSummaryMetrics = {
  plannedDealers: 0, plannedSchemes: 0, soConvertedDealers: 0, adminConvertedDealers: 0,
  soConvertedUnits: 0, adminConvertedUnits: 0, totalAmount: 0, bookingReceived: 0, documentReceived: 0, soBillingFilled: 0, adminBillingFilled: 0,
};
