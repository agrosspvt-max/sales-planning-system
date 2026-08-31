"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { ChevronDown, ChevronRight, Copy, Download, MessageCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PillNav } from "@/features/planning/plan-list-ui";
import { L, useLabel } from "@/features/labels/label-ui";
import { type LabelKey } from "@/features/labels/labels";
import { schemeTable } from "./scheme-table-theme";
import { SchemePlanModeLinks } from "./scheme-officer-workspace";

/**
 * FOLLOW-UP PLANS (/planning/scheme/follow-up) — the recovery layer over enrolled schemes.
 *
 *   Follow-up Plans
 *     ├── Scheme Follow-up ── collapsible: scheme → its dealers
 *     └── Dealer Follow-up ── collapsible: dealer → their schemes
 *
 * STRICTLY READ-ONLY. Every panel is a GET against `scheme-follow-up.server.ts`, which never writes:
 * opening, filtering, expanding, downloading or sharing cannot create scheme instances or installment
 * rows, or touch billing / conversion / approval / enrollment state.
 *
 * The Month + Week selectors are a FINANCIAL SNAPSHOT (a cutoff), not an "activity in this period"
 * filter — a dealer with an unpaid March installment still appears when August is selected. Weeks are the
 * app's business weeks (W1 1–7, W2 8–14, W3 15–22, W4 23–end); there is never a Week 5. All figures come
 * from the server, which also enforces role scope (`getOfficerScope`) — the browser never filters for
 * security and never recomputes money.
 */

/* --------------------------------- API shapes (mirror the follow-up service) --------------------------------- */

interface Figures {
  schemeAmount: number;
  bookingAmount: number;
  totalDue: number;
  installmentsPaid: number;
  totalPaid: number;
  pending: number;
  pendingPct: number | null;
  monthDue: number | null;
  monthActual: number | null;
  weekDue: number | null;
  weekActual: number | null;
  installmentsTotal: number;
  installmentsReceived: number;
  overdueCount: number;
  nextDueDate: string | null;
  lastPaymentDate: string | null;
  status: string;
}
interface Period {
  month: string;
  week: string | number;
  monthLabel: string;
  weekLabel: string | null;
  weekFrom: string | null;
  weekTo: string | null;
  snapshotDate: string;
  dueCutoff: string;
}
interface MonthOption { value: string; label: string }
interface DealerSchemeFigures extends Figures { planId: string; schemeId: string; schemeName: string; instanceCount: number; numberOfSchemes: number; derivedSchedule: boolean }
interface DealerRow extends Figures {
  dealerId: string; dealerName: string; town: string | null; mobile: string | null; salesOfficerName: string; state: string | null;
  schemeCount: number; instanceCount: number; schemeNames: string[]; schemes: DealerSchemeFigures[];
}
interface DealerList { period: Period; months: MonthOption[]; rows: DealerRow[]; totals: Figures }
interface SchemeDealerFigures extends Figures { planId: string; dealerId: string; dealerName: string; town: string | null; mobile: string | null; salesOfficerName: string; instanceCount: number }
interface SchemeRow extends Figures { schemeId: string; schemeName: string; dealerCount: number; instanceCount: number; dealers: SchemeDealerFigures[] }
interface SchemeList { period: Period; months: MonthOption[]; rows: SchemeRow[]; totals: Figures }
interface InstallmentRow {
  key: string; instanceNumber: number; installmentNumber: number; plannedAmount: number; plannedDate: string | null;
  receivedAmount: number | null; receivedDate: string | null; status: string; daysLate: number | null; derived: boolean;
}
interface PaymentRow {
  key: string; schemeName: string; instanceNumber: number | null; kind: "BOOKING" | "INSTALLMENT"; installmentNumber: number | null;
  amount: number; paymentDate: string | null; dueDate: string | null; status: string; daysLate: number | null;
}
interface DealerDetail {
  period: Period;
  dealer: { id: string; name: string; town: string | null; village: string | null; tehsil: string | null; district: string | null; mobile: string | null; salesOfficerName: string; state: string | null };
  summary: Figures & { schemeCount: number; instanceCount: number };
  schemes: (DealerSchemeFigures & { installments: InstallmentRow[] })[];
  payments: PaymentRow[];
}

/* --------------------------------- Presentation helpers --------------------------------- */

type FollowUpTab = "scheme" | "dealer";

const TABS: { value: FollowUpTab; label: string }[] = [
  { value: "scheme", label: "Scheme Follow-up" },
  { value: "dealer", label: "Dealer Follow-up" },
];

// Business-week day ranges, matching the app's single definition (BUSINESS_WEEK_COUNT = 4).
const WEEK_OPTIONS = [
  { value: "all", label: "All weeks" },
  { value: "1", label: "Week 1 (1–7)" },
  { value: "2", label: "Week 2 (8–14)" },
  { value: "3", label: "Week 3 (15–22)" },
  { value: "4", label: "Week 4 (23–end)" },
];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-08" → "August 2026" — deterministic, and identical to the server's month label. */
const monthLabelOf = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const currentMonthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Period figures are null for All months / All weeks — never shown as a misleading zero. */
const cell = (n: number | null) => (n == null ? "—" : formatCurrency(n));
const pctCell = (p: number | null) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);

// Same status vocabulary as the Enrolled Scheme view (position statuses + installment statuses).
const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "muted" | "default"> = {
  Enrolled: "secondary", "Installment Pending": "secondary", "Installment Received": "default", Completed: "success", Overdue: "destructive",
  PENDING: "secondary", RECEIVED: "success", OVERDUE: "destructive",
};
const StatusBadge = ({ s }: { s: string }) => (
  <Badge variant={STATUS_VARIANT[s] ?? "muted"}>{s === "PENDING" ? "Pending" : s === "RECEIVED" ? "Received" : s === "OVERDUE" ? "Overdue" : s}</Badge>
);

const MONEY_COLS = 11;

/** The eleven money/status columns shared by all four follow-up tables. */
function MoneyHeads({ period }: { period: Period | null }) {
  const monthDue = period && period.month !== "all" ? `Due (${period.monthLabel})` : "Month Due";
  const weekDue = period?.weekLabel ? `${period.weekLabel} Due` : "Week Due";
  return (
    <>
      <TableHead className="text-right">Scheme Amount</TableHead>
      <TableHead className="text-right">Booking</TableHead>
      <TableHead className="text-right">Total Due</TableHead>
      <TableHead className="text-right">Total Paid</TableHead>
      <TableHead className="text-right">Pending</TableHead>
      <TableHead className="text-right">Pending %</TableHead>
      <TableHead className="text-right">{monthDue}</TableHead>
      <TableHead className="text-right">Month Actual</TableHead>
      <TableHead className="text-right">{weekDue}</TableHead>
      <TableHead className="text-right">Week Actual</TableHead>
      <TableHead>Status</TableHead>
    </>
  );
}

function MoneyCells({ f, hideStatus }: { f: Figures; hideStatus?: boolean }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatCurrency(f.schemeAmount)}</TableCell>
      <TableCell className="text-right tabular-nums">{f.bookingAmount > 0 ? formatCurrency(f.bookingAmount) : "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(f.totalDue)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(f.totalPaid)}</TableCell>
      <TableCell className={cn("text-right font-medium tabular-nums", f.pending > 0 && "text-destructive")}>{formatCurrency(f.pending)}</TableCell>
      <TableCell className="text-right tabular-nums">{pctCell(f.pendingPct)}</TableCell>
      <TableCell className="text-right tabular-nums">{cell(f.monthDue)}</TableCell>
      <TableCell className="text-right tabular-nums">{cell(f.monthActual)}</TableCell>
      <TableCell className="text-right tabular-nums">{cell(f.weekDue)}</TableCell>
      <TableCell className="text-right tabular-nums">{cell(f.weekActual)}</TableCell>
      <TableCell>{hideStatus ? <span className="text-muted-foreground">—</span> : <StatusBadge s={f.status} />}</TableCell>
    </>
  );
}

const SkeletonRow = ({ cols }: { cols: number }) => <TableRow><TableCell colSpan={cols}><Skeleton className="h-6 w-full" /></TableCell></TableRow>;
const EmptyRow = ({ cols, text }: { cols: number; text: string }) => <TableRow><TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">{text}</TableCell></TableRow>;

/* --------------------------------- WhatsApp / copy sharing --------------------------------- */

/**
 * wa.me deep link for a plain-text statement — no WhatsApp API, no server-side messaging: the browser
 * hands the pre-filled message to WhatsApp and the user sends it. Dealers are stored as bare 10-digit
 * mobiles, so those are prefixed with 91; anything else is passed through as its digits. Returns null when
 * there is no usable number — the Copy fallback covers that case.
 */
function waLink(mobile: string | null, text: string): string | null {
  const digits = (mobile ?? "").replace(/\D/g, "");
  const num = digits.length === 10 ? `91${digits}` : digits.length === 11 && digits.startsWith("0") ? `91${digits.slice(1)}` : digits;
  if (num.length < 10) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

/** Plain-text payment statement — it only restates the figures already shown on screen. */
function paymentStatement(
  name: string,
  place: string | null,
  period: Period | null,
  f: Figures,
  schemes: { schemeName: string; totalDue: number; totalPaid: number; pending: number }[],
): string {
  const out: string[] = ["Scheme Payment Follow-up", `Dealer: ${name}${place ? ` (${place})` : ""}`];
  if (period) out.push(`Position as at: ${formatDate(period.snapshotDate)}`);
  out.push("", `Total Due: ${formatCurrency(f.totalDue)}`, `Amount Received: ${formatCurrency(f.totalPaid)}`);
  if (f.bookingAmount > 0) out.push(`(includes booking amount ${formatCurrency(f.bookingAmount)})`);
  out.push(`Pending: ${formatCurrency(f.pending)}`);
  if (f.nextDueDate) out.push(`Next installment due: ${formatDate(f.nextDueDate)}`);
  if (schemes.length > 0) {
    out.push("", "Scheme-wise:");
    for (const s of schemes) out.push(`- ${s.schemeName}: due ${formatCurrency(s.totalDue)}, received ${formatCurrency(s.totalPaid)}, pending ${formatCurrency(s.pending)}`);
  }
  out.push("", f.pending > 0 ? "Kindly arrange the pending payment." : "No pending amount as on this date. Thank you.");
  return out.join("\n");
}

interface ShareTarget { title: string; mobile: string | null; text: string }

/**
 * Share sheet — shows the exact message, then either opens WhatsApp (wa.me deep link) or copies it.
 * Purely client-side; sharing changes no data.
 */
function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = waLink(target.mobile, target.text);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(target.text);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked — the text area below stays selectable as the fallback
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Share payment statement — {target.title}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label>Message</Label>
          <Textarea readOnly value={target.text} rows={12} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <p className="text-xs text-muted-foreground">
            {link
              ? "Opens WhatsApp with this message ready to send — nothing is sent automatically."
              : "This dealer has no mobile number on record, so WhatsApp cannot be opened. Copy the message instead."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={copy}><Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy summary"}</Button>
          {link ? (
            <Button asChild><a href={link} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" /> Open WhatsApp</a></Button>
          ) : (
            <Button disabled><MessageCircle className="h-4 w-4" /> Open WhatsApp</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ShareButton = ({ onClick }: { onClick: () => void }) => (
  <Button size="sm" variant="ghost" onClick={onClick} title="Share payment statement on WhatsApp"><MessageCircle className="h-4 w-4" /> Share</Button>
);

/* --------------------------------- Page shell + role entry points --------------------------------- */

/**
 * RM/Admin entry to the Scheme Planning sections — the manager counterpart of the SO's
 * `SchemePlanModeLinks`, and role-shaped because the two roles do not have the same sections:
 *
 *   Super Admin      → [Create Plan] [View Plan] [Follow-up Plans]   (mirrors the Sales Officer's three-way
 *                       structure: Create Plan is the reused Scheme Master, View Plan is the org-wide
 *                       Scheme-wise / Dealer-wise / Enrolled Scheme workspace)
 *   Regional Manager → [Scheme Planning] [Follow-up Plans]           (unchanged — an RM has no Scheme Master
 *                       authority, so there is no Create Plan section to link to)
 *
 * `active="planning"` is the first item in both bars, so the RM bar renders exactly as it always has.
 */
export function SchemeManagerModeLinks({ active, role }: { active: "planning" | "view" | "followup"; role: Role }) {
  // Both manager roles now use the three-section bar. RM gained Create Plan / View Plans (the SO-style
  // planning workflow) alongside the existing Review (a flip inside View Plans) and Follow-up.
  const items: { key: "planning" | "view" | "followup"; href: string; labelKey: LabelKey }[] = [
    { key: "planning", href: "/planning/scheme", labelKey: "scheme_planning.nav.create_plan" },
    { key: "view", href: "/planning/scheme/plans", labelKey: "scheme_planning.nav.view_plan" },
    { key: "followup", href: "/planning/scheme/follow-up", labelKey: "scheme_planning.nav.follow_up" },
  ];
  void role;
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          className={cn("rounded px-3 py-1.5 font-medium", active === i.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          <L k={i.labelKey} />
        </Link>
      ))}
    </div>
  );
}

/** Follow-up Plans page — role-aware only in its navigation; the data itself is scoped server-side. */
export function SchemeFollowUpPage({ role }: { role: Role }) {
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  // RM Follow-up scope: My Schemes (own) / Team Schemes (one Sales Officer). Admin/SO have no selector.
  const [scope, setScope] = useState<"self" | "team">("self");
  const [officerId, setOfficerId] = useState("");
  const myLbl = useLabel("scheme_planning.view.my_schemes");
  const teamLbl = useLabel("scheme_planning.view.team_schemes");
  const { data: officers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["scheme-team-officers"], queryFn: () => api.get("/api/schemes/team-officers"), enabled: isManager,
  });
  const effOfficer = isManager ? (scope === "team" ? officerId : undefined) : undefined;
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={
          isOfficer
            ? [{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Scheme Planning" }, { label: "Follow-up Plans" }]
            : [{ label: "Planning" }, { label: "Scheme Planning", href: "/planning/scheme" }, { label: "Follow-up Plans" }]
        }
        title="Follow-up Plans"
        subtitle="Recovery position on enrolled schemes — due, received and pending. Read-only: nothing is created or changed here."
      />

      {/* Level 1 — SO: Create New Plan | View Plans | Follow-up Plans. Admin/RM: Create Plan | View Plan | Follow-up Plans. */}
      {isOfficer ? <SchemePlanModeLinks mode="followup" /> : <SchemeManagerModeLinks active="followup" role={role} />}

      {isManager && (
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scope</div>
          <div className="flex flex-wrap items-center gap-3">
            <PillNav value={scope} onChange={(v) => { setScope(v); setOfficerId(""); }} items={[{ value: "self", label: myLbl }, { value: "team", label: teamLbl }]} />
            {scope === "team" && (
              <NativeSelect className="w-56" placeholder="Select a Sales Officer…" value={officerId} onChange={(e) => setOfficerId(e.target.value)} options={officers.map((o) => ({ value: o.id, label: o.name }))} />
            )}
          </div>
          {scope === "team" && officers.length === 0 && <p className="text-xs text-muted-foreground">No Sales Officers on your team yet.</p>}
        </div>
      )}

      {isManager && scope === "team" && !officerId ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">Select a Sales Officer to view their follow-up.</div>
      ) : (
        <FollowUpWorkspace key={effOfficer ?? "self"} officerId={effOfficer} />
      )}
    </div>
  );
}

/* --------------------------------- Workspace (filters + tables) --------------------------------- */

function FollowUpWorkspace({ officerId }: { officerId?: string } = {}) {
  const [tab, setTab] = useState<FollowUpTab>("scheme");
  const [month, setMonth] = useState<string>(currentMonthKey); // default: the current month's snapshot
  const [week, setWeek] = useState<string>("all");
  const [drillDealer, setDrillDealer] = useState<string | null>(null);
  const [share, setShare] = useState<ShareTarget | null>(null);

  const officerParam = officerId ? `&officerId=${encodeURIComponent(officerId)}` : "";
  const params = `month=${encodeURIComponent(month)}&week=${encodeURIComponent(week)}${officerParam}`;
  const officerKey = officerId ?? "all";
  const dealers = useQuery<DealerList>({
    queryKey: ["scheme-follow-up", "dealers", month, week, officerKey],
    queryFn: () => api.get(`/api/scheme-follow-up/dealers?${params}`),
    enabled: tab === "dealer",
  });
  const schemes = useQuery<SchemeList>({
    queryKey: ["scheme-follow-up", "schemes", month, week, officerKey],
    queryFn: () => api.get(`/api/scheme-follow-up/schemes?${params}`),
    enabled: tab === "scheme",
  });

  const meta: DealerList | SchemeList | undefined = tab === "dealer" ? dealers.data : schemes.data;
  const period = meta?.period ?? null;
  const isLoading = tab === "dealer" ? dealers.isLoading : schemes.isLoading;
  const error = (tab === "dealer" ? dealers.error : schemes.error) as Error | null;

  const monthOptions = useMemo(() => {
    const fromServer = meta?.months ?? [];
    const base = fromServer.length ? fromServer : [{ value: currentMonthKey(), label: monthLabelOf(currentMonthKey()) }];
    // Keep the current selection selectable even if it has no activity of its own.
    const withSelected = base.some((m) => m.value === month) || month === "all" ? base : [{ value: month, label: monthLabelOf(month) }, ...base];
    return [{ value: "all", label: "All months" }, ...withSelected];
  }, [meta, month]);

  const onMonth = (v: string) => { setMonth(v); if (v === "all") setWeek("all"); }; // a week only means something inside a month
  const exportHref = `/api/scheme-follow-up/export?view=${tab}&${params}`;

  return (
    <div className="space-y-5">
      {/* Level 2 — Scheme Follow-up | Dealer Follow-up, plus the snapshot filters. */}
      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">View</div>
        <div className="flex flex-wrap items-center gap-3">
          <PillNav value={tab} onChange={setTab} items={TABS} />
        </div>
        <div className="flex flex-wrap items-end gap-3 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="fu-month">Month</Label>
            <NativeSelect id="fu-month" className="w-44" options={monthOptions} value={month} onChange={(e) => onMonth(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fu-week">Week</Label>
            <NativeSelect id="fu-week" className="w-40" options={WEEK_OPTIONS} value={week} disabled={month === "all"} onChange={(e) => setWeek(e.target.value)} />
          </div>
          {period && (
            <p className="pb-1.5 text-xs text-muted-foreground">
              Position as at <span className="font-medium">{formatDate(period.snapshotDate)}</span>
              {period.weekFrom && period.weekTo && <> · {period.weekLabel}: {formatDate(period.weekFrom)} – {formatDate(period.weekTo)}</>}
              <br />
              Total Due is cumulative up to {formatDate(period.dueCutoff)}; Month/Week columns show that period only.
            </p>
          )}
          <div className="ml-auto pb-1">
            <Button asChild variant="outline" size="sm">
              <a href={exportHref}><Download className="h-4 w-4" /> Export to Excel</a>
            </Button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {tab === "dealer" ? (
        <DealerCollapsibleView data={dealers.data} period={period} isLoading={isLoading} onOpen={setDrillDealer} onShare={setShare} />
      ) : (
        <SchemeCollapsibleView data={schemes.data} period={period} isLoading={isLoading} onOpen={setDrillDealer} onShare={setShare} />
      )}

      {drillDealer && <DealerDetailDialog dealerId={drillDealer} month={month} week={week} onClose={() => setDrillDealer(null)} onShare={setShare} />}
      {share && <ShareDialog target={share} onClose={() => setShare(null)} />}
    </div>
  );
}

const dealerShareTarget = (r: DealerRow, period: Period | null): ShareTarget => ({
  title: r.dealerName,
  mobile: r.mobile,
  text: paymentStatement(r.dealerName, r.town, period, r, r.schemes.map((s) => ({ schemeName: s.schemeName, totalDue: s.totalDue, totalPaid: s.totalPaid, pending: s.pending }))),
});

/* --------------------------------- Dealer Follow-up --------------------------------- */

/**
 * Dealer parent row → the dealer's schemes nested, using the app's one collapsible pattern.
 * One row per enrolled dealer. Fully settled dealers stay listed; pending-first ordering is the server's.
 */
function DealerCollapsibleView({ data, period, isLoading, onOpen, onShare }: {
  data: DealerList | undefined; period: Period | null; isLoading: boolean;
  onOpen: (dealerId: string) => void; onShare: (t: ShareTarget) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const COLS = 1 + 3 + MONEY_COLS + 1;
  return (
    <div className={schemeTable.outer}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Dealer</TableHead>
            <TableHead>Sales Officer</TableHead>
            <TableHead className="text-right">Schemes</TableHead>
            <MoneyHeads period={period} />
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading || !data ? (
            <SkeletonRow cols={COLS} />
          ) : data.rows.length === 0 ? (
            <EmptyRow cols={COLS} text="No enrolled dealers to follow up." />
          ) : (
            data.rows.map((r) => {
              const open = expanded.has(r.dealerId);
              return (
                <Fragment key={r.dealerId}>
                  <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(r.dealerId)}>
                    <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                    <TableCell className="font-semibold">{r.dealerName}{r.town && <span className="ml-2 text-xs font-normal text-muted-foreground">{r.town}</span>}</TableCell>
                    <TableCell>{r.salesOfficerName}</TableCell>
                    <TableCell className="text-right">{r.schemeCount}</TableCell>
                    <MoneyCells f={r} />
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <ShareButton onClick={() => onShare(dealerShareTarget(r, period))} />
                    </TableCell>
                  </TableRow>
                  {open && (
                    <TableRow>
                      <TableCell colSpan={COLS} className={schemeTable.nestedCell}>
                        <div className={schemeTable.nestedInset}>
                          <div className={schemeTable.nestedShell}>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Scheme</TableHead>
                                  <TableHead className="text-right">Schemes Enrolled</TableHead>
                                  <MoneyHeads period={period} />
                                  <TableHead className="text-right">Details</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {r.schemes.map((s) => (
                                  <TableRow key={s.planId}>
                                    <TableCell className="font-medium">{s.schemeName}</TableCell>
                                    <TableCell className="text-right">{s.instanceCount}</TableCell>
                                    <MoneyCells f={s} />
                                    <TableCell className="text-right">
                                      <Button size="sm" variant="ghost" onClick={() => onOpen(r.dealerId)}>Open</Button>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/* --------------------------------- Scheme Follow-up --------------------------------- */

/**
 * Scheme parent row → the scheme's enrolled dealers nested, with per-dealer share and drill-down.
 * One row per scheme — the same snapshot maths rolled up across the scheme's enrolled dealers.
 */
function SchemeCollapsibleView({ data, period, isLoading, onOpen, onShare }: {
  data: SchemeList | undefined; period: Period | null; isLoading: boolean;
  onOpen: (dealerId: string) => void; onShare: (t: ShareTarget) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const COLS = 1 + 2 + MONEY_COLS;
  return (
    <div className={schemeTable.outer}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Scheme</TableHead>
            <TableHead className="text-right">Enrolled Dealers</TableHead>
            <MoneyHeads period={period} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading || !data ? (
            <SkeletonRow cols={COLS} />
          ) : data.rows.length === 0 ? (
            <EmptyRow cols={COLS} text="No enrolled schemes to follow up." />
          ) : (
            data.rows.map((r) => {
              const open = expanded.has(r.schemeId);
              return (
                <Fragment key={r.schemeId}>
                  <TableRow className={cn("cursor-pointer", schemeTable.parentRow, open && schemeTable.parentRowOpen)} onClick={() => toggle(r.schemeId)}>
                    <TableCell>{open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                    <TableCell className="font-semibold">{r.schemeName}</TableCell>
                    <TableCell className="text-right">{r.dealerCount}</TableCell>
                    <MoneyCells f={r} />
                  </TableRow>
                  {open && (
                    <TableRow>
                      <TableCell colSpan={COLS} className={schemeTable.nestedCell}>
                        <div className={schemeTable.nestedInset}>
                          <div className={schemeTable.nestedShell}>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Dealer</TableHead>
                                  <TableHead>Town</TableHead>
                                  <TableHead>Sales Officer</TableHead>
                                  <MoneyHeads period={period} />
                                  <TableHead className="text-right">Share</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {r.dealers.map((d) => (
                                  <TableRow key={d.planId}>
                                    <TableCell className="font-medium">
                                      <button type="button" className="text-left text-primary hover:underline" onClick={() => onOpen(d.dealerId)}>{d.dealerName}</button>
                                    </TableCell>
                                    <TableCell>{d.town ?? "—"}</TableCell>
                                    <TableCell>{d.salesOfficerName}</TableCell>
                                    <MoneyCells f={d} />
                                    <TableCell className="text-right">
                                      <ShareButton
                                        onClick={() => onShare({
                                          title: d.dealerName,
                                          mobile: d.mobile,
                                          text: paymentStatement(d.dealerName, d.town, period, d, [{ schemeName: r.schemeName, totalDue: d.totalDue, totalPaid: d.totalPaid, pending: d.pending }]),
                                        })}
                                      />
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/* --------------------------------- Dealer drill-down --------------------------------- */

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
);

const place = (d: DealerDetail["dealer"]) => [d.town, d.village, d.tehsil, d.district].filter(Boolean).join(", ") || "—";

/**
 * Dealer drill-down — dealer info, the snapshot summary, the scheme-wise breakdown with every installment,
 * and the payment report. Read-only: schedules with no persisted installment rows are DERIVED from the
 * scheme's installment rules for display and are flagged as such; opening this never generates them.
 */
function DealerDetailDialog({ dealerId, month, week, onClose, onShare }: {
  dealerId: string; month: string; week: string; onClose: () => void; onShare: (t: ShareTarget) => void;
}) {
  const { data, isLoading, error } = useQuery<DealerDetail>({
    queryKey: ["scheme-follow-up", "dealer", dealerId, month, week],
    queryFn: () => api.get(`/api/scheme-follow-up/dealers/${dealerId}?month=${encodeURIComponent(month)}&week=${encodeURIComponent(week)}`),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader><DialogTitle>{data?.dealer.name ?? "Dealer follow-up"}</DialogTitle></DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-x-8 md:grid-cols-2">
              <div className="space-y-0.5">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dealer</p>
                <Row label="Location" value={place(data.dealer)} />
                <Row label="Mobile" value={data.dealer.mobile ?? "—"} />
                <Row label="Sales Officer" value={data.dealer.salesOfficerName} />
                <Row label="State" value={data.dealer.state ?? "—"} />
                <Row label="Enrolled Schemes" value={`${data.summary.schemeCount} (${data.summary.instanceCount} scheme unit${data.summary.instanceCount === 1 ? "" : "s"})`} />
              </div>
              <div className="space-y-0.5">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position as at {formatDate(data.period.snapshotDate)}</p>
                <Row label="Scheme Amount" value={formatCurrency(data.summary.schemeAmount)} />
                <Row label="Booking Amount (Admin confirmed)" value={data.summary.bookingAmount > 0 ? formatCurrency(data.summary.bookingAmount) : "—"} />
                <Row label="Total Due" value={formatCurrency(data.summary.totalDue)} />
                <Row label="Total Paid" value={formatCurrency(data.summary.totalPaid)} />
                <Row label="Pending" value={<span className={cn(data.summary.pending > 0 && "text-destructive")}>{formatCurrency(data.summary.pending)}{data.summary.pendingPct != null && ` (${pctCell(data.summary.pendingPct)})`}</span>} />
                <Row label="Next Installment Due" value={data.summary.nextDueDate ? formatDate(data.summary.nextDueDate) : "—"} />
                <Row label="Last Payment" value={data.summary.lastPaymentDate ? formatDate(data.summary.lastPaymentDate) : "—"} />
                <Row label="Status" value={<StatusBadge s={data.summary.status} />} />
              </div>
            </div>

            {data.schemes.map((s) => (
              <div key={s.planId} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{s.schemeName} <span className="font-normal text-muted-foreground">· {s.instanceCount} scheme unit{s.instanceCount === 1 ? "" : "s"}</span></p>
                  <p className="text-xs text-muted-foreground">
                    Due {formatCurrency(s.totalDue)} · Paid {formatCurrency(s.totalPaid)} · Pending <span className={cn(s.pending > 0 && "text-destructive")}>{formatCurrency(s.pending)}</span>
                  </p>
                </div>
                {s.derivedSchedule && (
                  <p className="text-xs text-muted-foreground">
                    Schedule shown from the scheme&rsquo;s installment rules — installment records have not been generated for every scheme unit yet.
                  </p>
                )}
                <div className="overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Scheme Unit</TableHead>
                        <TableHead>Installment</TableHead>
                        <TableHead className="text-right">Planned Amount</TableHead>
                        <TableHead>Planned Date</TableHead>
                        <TableHead className="text-right">Received Amount</TableHead>
                        <TableHead>Actual Date</TableHead>
                        <TableHead className="text-right">Days Late</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.installments.length === 0 ? (
                        <EmptyRow cols={8} text="No installment rules on this scheme." />
                      ) : (
                        s.installments.map((i) => (
                          <TableRow key={i.key}>
                            <TableCell>Scheme {i.instanceNumber}</TableCell>
                            <TableCell className="font-medium">{ordinal(i.installmentNumber)} Installment</TableCell>
                            <TableCell className="text-right tabular-nums">{formatCurrency(i.plannedAmount)}</TableCell>
                            <TableCell>{i.plannedDate ? formatDate(i.plannedDate) : "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{i.receivedAmount == null ? "—" : formatCurrency(i.receivedAmount)}</TableCell>
                            <TableCell>{i.receivedDate ? formatDate(i.receivedDate) : "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{i.daysLate == null ? "—" : i.daysLate}</TableCell>
                            <TableCell><StatusBadge s={i.status} /></TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}

            <div className="space-y-2">
              <p className="text-sm font-semibold">Payment Report</p>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Scheme</TableHead>
                      <TableHead>Against</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Due Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.payments.length === 0 ? (
                      <EmptyRow cols={6} text="No payments recorded up to this date." />
                    ) : (
                      data.payments.map((p) => (
                        <TableRow key={p.key}>
                          <TableCell>{p.paymentDate ? formatDate(p.paymentDate) : "—"}</TableCell>
                          <TableCell>{p.schemeName}</TableCell>
                          <TableCell>{p.kind === "BOOKING" ? "Booking" : `Scheme ${p.instanceNumber} · ${ordinal(p.installmentNumber ?? 0)} Installment`}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(p.amount)}</TableCell>
                          <TableCell>{p.dueDate ? formatDate(p.dueDate) : "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{p.status}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {data && (
            <Button
              variant="outline"
              onClick={() => onShare({
                title: data.dealer.name,
                mobile: data.dealer.mobile,
                text: paymentStatement(data.dealer.name, data.dealer.town, data.period, data.summary, data.schemes.map((s) => ({ schemeName: s.schemeName, totalDue: s.totalDue, totalPaid: s.totalPaid, pending: s.pending }))),
              })}
            >
              <MessageCircle className="h-4 w-4" /> Share statement
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
