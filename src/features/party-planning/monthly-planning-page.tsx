"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { OPTION_STATUSES, STATUS_LABEL, type OptionStatus } from "@/lib/monthly-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { PartyPlanModeLinks } from "./party-planning-page";

/* ------------------------------------------- DTOs (mirror monthly.server.ts) ------------------------------------------- */

interface EligiblePlan { id: string; marketName: string; marketPotential: string | null; type: string | null; partyName: string }
interface MonthlySheetDetail {
  sheet: { id: string; seasonName: string; seasonOpen: boolean; monthLabel: string; ownerName: string; status: string; own: boolean };
  season: { id: string; name: string; year: number; period: string | null };
  month: { id: string; name: string; label: string; key: string };
  seasonalPlans: EligiblePlan[];
  plans: Plan[];
}
interface DocInfo { documents: boolean; checks: boolean; other: boolean; otherDetails: string | null }
interface TimelineEvent { id: string; eventType: string; fromStatus: OptionStatus | null; toStatus: OptionStatus; actorName: string; actorRole: string; details: Record<string, unknown> | null; createdAt: string }
interface Option {
  id: string; optionNo: 1 | 2; partyName: string | null; status: OptionStatus; statusLabel: string; statusChangedAt: string;
  sentInfo: DocInfo | null; sentByName: string | null; sentAt: string | null; receivedInfo: DocInfo | null; receivedByName: string | null; receivedAt: string | null;
  actualPartyName: string | null; actualAppointedOn: string | null; rejectionReason: string | null; allowed: OptionStatus[]; events: TimelineEvent[];
}
interface Plan { id: string; monthLabel: string; monthKey: string; ownerName: string; marketName: string; marketPotential: string | null; planDate: string | null; canManage: boolean; options: Option[] }

const STATUS_VARIANT: Record<OptionStatus, "muted" | "secondary" | "success" | "destructive" | "warning"> = {
  PENDING: "muted", DOC_SENT: "secondary", DOC_RECEIVED: "secondary", SD_DELAYED_BY_SO: "warning", SD_BOUNCE: "warning", APPOINTED: "success", PART_REJECTED: "destructive",
};
const dash = <span className="text-muted-foreground">—</span>;
const dateText = (v: string | null) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString("en-IN", { dateStyle: "medium" }) : null);
const dateTimeText = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const docText = (d: DocInfo | null) => (d ? [d.documents && "Documents", d.checks && "Checks", d.other && `Other${d.otherDetails ? `: ${d.otherDetails}` : ""}`].filter(Boolean).join(" · ") : "—");

/**
 * ONE Monthly Plan (a season month's market rows), opened by its id from the list. Season, month and rows are loaded from that plan — never
 * from the "current season / month". The market choices are the owner's APPROVED Seasonal Plan markets of this plan's season that are still free.
 */
export function MonthlyPlanDetailPage({ role, sheetId }: { role: Role; sheetId: string }) {
  const qc = useQueryClient();
  const canPlan = role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ planId: string; optionNo: 1 | 2 } | null>(null);
  const [form, setForm] = useState({ seasonalPlanId: "", planDate: "", option1Party: "", option2Party: "" });
  const L = {
    title: useLabel("party_planning.title"), nav: useLabel("party_planning.nav.monthly"),
    market: useLabel("party_planning.monthly.col.market"), potential: useLabel("party_planning.monthly.col.potential"),
    planDate: useLabel("party_planning.monthly.col.plan_date"), opt1: useLabel("party_planning.monthly.col.option1"), opt2: useLabel("party_planning.monthly.col.option2"),
    search: useLabel("party_planning.monthly.search"), empty: useLabel("party_planning.monthly.empty"),
  };
  const { data: detail, isLoading, error: loadError } = useQuery<MonthlySheetDetail>({ queryKey: ["party-monthly-sheet", sheetId], queryFn: () => api.get<MonthlySheetDetail>(`/api/party-monthly-sheets/${sheetId}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["party-monthly-sheet", sheetId] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheets"] }); qc.invalidateQueries({ queryKey: ["party-monthly-sheet-options"] }); };
  const create = useMutation({
    mutationFn: () => api.post("/api/party-monthly-plans", { sheetId, ...form }),
    onSuccess: () => { setError(null); setForm({ seasonalPlanId: "", planDate: "", option1Party: "", option2Party: "" }); refresh(); },
    onError: (e) => setError((e as Error).message),
  });
  const sheet = detail?.sheet;
  const needle = search.trim().toLowerCase();
  const plans = (detail?.plans ?? []).filter((p) =>
    (!needle || p.marketName.toLowerCase().includes(needle) || p.options.some((o) => (o.partyName ?? "").toLowerCase().includes(needle) || (o.actualPartyName ?? "").toLowerCase().includes(needle)))
    && (!status || p.options.some((o) => o.status === status)));
  const openPlan = open ? detail?.plans.find((p) => p.id === open.planId) : undefined;
  const openOption = openPlan?.options.find((o) => o.optionNo === open?.optionNo);
  const canAdd = canPlan && sheet?.own && sheet.seasonOpen;

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: L.title }, { label: L.nav, href: "/planning/party/monthly" }, { label: detail ? `${detail.season.name} ${detail.season.year} · ${detail.month.label}` : "Monthly Plan" }]} title={L.title}
        subtitle="Plan the parties you are considering for each of your approved seasonal markets this month." />
      <PartyPlanModeLinks mode="monthly" />

      {detail && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">Season: {detail.season.name} {detail.season.year} · Month: {detail.month.label}</span>
          {detail.season.period && <span className="text-muted-foreground"> · {detail.season.period}</span>}
          {!sheet!.own && <span className="text-muted-foreground"> · {sheet!.ownerName}</span>}
          {!sheet!.seasonOpen && <span className="ml-2 text-xs text-muted-foreground">(season closed — read-only)</span>}
        </div>
      )}
      {loadError && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{(loadError as Error).message}</div>}

      {canAdd && detail && (
        <div className="space-y-3 rounded-lg border bg-background p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5"><Label>{L.market} *</Label>
              <NativeSelect className="w-64" value={form.seasonalPlanId} placeholder={detail.seasonalPlans.length ? "Select a market…" : "No approved markets left for this month"}
                options={detail.seasonalPlans.map((p) => ({ value: p.id, label: `${p.marketName} — ${p.partyName}` }))} onChange={(e) => setForm({ ...form, seasonalPlanId: e.target.value })} />
            </div>
            <div className="space-y-1.5"><Label>{L.planDate}</Label>
              <Input type="date" className="w-44" min={`${detail.month.key}-01`} max={`${detail.month.key}-31`} value={form.planDate} onChange={(e) => setForm({ ...form, planDate: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5"><Label>{L.opt1} party *</Label><Input className="w-64" maxLength={200} value={form.option1Party} onChange={(e) => setForm({ ...form, option1Party: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{L.opt2} party</Label><Input className="w-64" maxLength={200} value={form.option2Party} onChange={(e) => setForm({ ...form, option2Party: e.target.value })} /></div>
            <Button disabled={create.isPending || !form.seasonalPlanId || !form.option1Party.trim()} onClick={() => create.mutate()}><Plus className="h-4 w-4" /> Add Monthly Plan</Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap items-end justify-end gap-2">
        <Input className="w-56" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L.search} aria-label={L.search} />
        <NativeSelect className="w-44" value={status} placeholder="All statuses" options={OPTION_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} onChange={(e) => setStatus(e.target.value)} />
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow><TableHead>{L.market}</TableHead><TableHead>{L.potential}</TableHead><TableHead>{L.planDate}</TableHead><TableHead>{L.opt1}</TableHead><TableHead>{L.opt2}</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : plans.length === 0 ? <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
                : plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.marketName}</TableCell>
                    <TableCell>{p.marketPotential ?? dash}</TableCell>
                    <TableCell className="whitespace-nowrap">{dateText(p.planDate) ?? dash}</TableCell>
                    {p.options.map((o) => (
                      <TableCell key={o.id} className="p-1">
                        <button className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => setOpen({ planId: p.id, optionNo: o.optionNo })} aria-label={`Option ${o.optionNo} ${o.statusLabel}`}>
                          <div className="text-sm">{o.actualPartyName ?? o.partyName ?? dash}</div>
                          <Badge variant={STATUS_VARIANT[o.status]} className="mt-0.5">{o.statusLabel}</Badge>
                        </button>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {openPlan && openOption && <OptionDialog plan={openPlan} option={openOption} onClose={() => setOpen(null)} onChanged={refresh} />}
    </div>
  );
}

/* ================================================= option dialog ================================================= */

function DocForm({ value, onChange }: { value: DocInfo; onChange: (v: DocInfo) => void }) {
  return (
    <div className="space-y-2">
      {(["documents", "checks", "other"] as const).map((key) => (
        <label key={key} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" checked={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} /> {key}</label>
      ))}
      {value.other && <Textarea rows={2} maxLength={500} placeholder="Describe what 'Other' is…" value={value.otherDetails ?? ""} onChange={(e) => onChange({ ...value, otherDetails: e.target.value })} />}
    </div>
  );
}

function OptionDialog({ plan, option, onClose, onChanged }: { plan: Plan; option: Option; onClose: () => void; onChanged: () => void }) {
  const [to, setTo] = useState<OptionStatus | null>(null);
  const [doc, setDoc] = useState<DocInfo>({ documents: false, checks: false, other: false, otherDetails: null });
  const [reason, setReason] = useState("");
  const [actualParty, setActualParty] = useState(option.partyName ?? "");
  const [party, setParty] = useState(option.partyName ?? "");
  const [planDate, setPlanDate] = useState(plan.planDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const done = () => { setError(null); setTo(null); setReason(""); onChanged(); };
  const move = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { to };
      if (to === "DOC_SENT") body.sent = doc; else if (to === "DOC_RECEIVED") body.received = doc;
      else if (to === "APPOINTED") body.actualPartyName = actualParty; else body.reason = reason;
      return api.post(`/api/party-monthly-plans/${plan.id}/options/${option.optionNo}/transition`, body);
    },
    onSuccess: done, onError: (e) => setError((e as Error).message),
  });
  const edit = useMutation({
    mutationFn: () => api.put(`/api/party-monthly-plans/${plan.id}`, { [option.optionNo === 1 ? "option1Party" : "option2Party"]: party, planDate }),
    onSuccess: done, onError: (e) => setError((e as Error).message),
  });
  const needsReason = to === "SD_DELAYED_BY_SO" || to === "SD_BOUNCE" || to === "PART_REJECTED";
  const ready = to != null && (needsReason ? reason.trim() !== "" : to === "APPOINTED" ? actualParty.trim() !== "" : doc.documents || doc.checks || doc.other);
  const monthStart = plan.monthKey ? `${plan.monthKey}-01` : undefined;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{plan.marketName} · {plan.monthLabel} · Option {option.optionNo}</DialogTitle></DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2"><Badge variant={STATUS_VARIANT[option.status]}>{option.statusLabel}</Badge><span className="text-muted-foreground">since {dateTimeText(option.statusChangedAt)}</span></div>

          <section className="space-y-1 rounded-md border p-3">
            <h3 className="font-semibold">Planning information</h3>
            <div>Candidate party: <b>{option.partyName ?? "—"}</b></div>
            <div>Plan date (tentative): <b>{dateText(plan.planDate) ?? "—"}</b></div>
            {plan.canManage && option.status === "PENDING" && (
              <div className="flex flex-wrap items-end gap-2 pt-2">
                <Input className="w-56" maxLength={200} value={party} onChange={(e) => setParty(e.target.value)} aria-label="Candidate party" />
                <Input type="date" className="w-40" min={monthStart} max={plan.monthKey ? `${plan.monthKey}-31` : undefined} value={planDate} onChange={(e) => setPlanDate(e.target.value)} aria-label="Plan date" />
                <Button size="sm" variant="outline" disabled={edit.isPending} onClick={() => edit.mutate()}>Save</Button>
              </div>
            )}
          </section>

          <details className="rounded-md border p-3" open={option.status !== "PENDING"}>
            <summary className="cursor-pointer font-semibold">Admin / actual information</summary>
            <div className="mt-2 space-y-1">
              <div>Sent by SO: {docText(option.sentInfo)}{option.sentByName && <span className="text-muted-foreground"> — {option.sentByName}, {option.sentAt && dateTimeText(option.sentAt)}</span>}</div>
              <div>Received by Admin: {docText(option.receivedInfo)}{option.receivedByName && <span className="text-muted-foreground"> — {option.receivedByName}, {option.receivedAt && dateTimeText(option.receivedAt)}</span>}</div>
              <div>Actual party: <b>{option.actualPartyName ?? "—"}</b></div>
              <div>Actual appointment date: <b>{dateText(option.actualAppointedOn) ?? "—"}</b></div>
              {option.rejectionReason && <div className="text-destructive">Part Rejected: {option.rejectionReason}</div>}
            </div>
          </details>

          {option.allowed.length > 0 && (
            <section className="space-y-2 rounded-md border p-3">
              <h3 className="font-semibold">Update status</h3>
              <div className="flex flex-wrap gap-2">{option.allowed.map((s) => <Button key={s} size="sm" variant={to === s ? "default" : "outline"} onClick={() => { setTo(s); setError(null); }}>{STATUS_LABEL[s]}</Button>)}</div>
              {(to === "DOC_SENT" || to === "DOC_RECEIVED") && (
                <div className="space-y-2">
                  {to === "DOC_RECEIVED" && <div className="text-muted-foreground">SO marked as sent: {docText(option.sentInfo)}</div>}
                  <Label>{to === "DOC_SENT" ? "What did you send?" : "What was actually received?"}</Label>
                  <DocForm value={doc} onChange={setDoc} />
                </div>
              )}
              {needsReason && <div className="space-y-1"><Label>Reason *</Label><Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
              {to === "APPOINTED" && <div className="space-y-1"><Label>Actual party name *</Label><Input maxLength={200} value={actualParty} onChange={(e) => setActualParty(e.target.value)} /><p className="text-xs text-muted-foreground">The appointment date is recorded as today.</p></div>}
              {error && <p className="text-destructive">{error}</p>}
              {to && <Button disabled={!ready || move.isPending} variant={to === "PART_REJECTED" ? "destructive" : "default"} onClick={() => move.mutate()}>Confirm {STATUS_LABEL[to]}</Button>}
            </section>
          )}
          {option.allowed.length === 0 && error && <p className="text-destructive">{error}</p>}

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer font-semibold">Timeline ({option.events.length})</summary>
            <ol className="mt-2 space-y-2 border-l pl-3">
              {option.events.map((e) => (
                <li key={e.id}>
                  <div className="font-medium">{e.eventType === "PLAN_CREATED" ? "Planning Created" : e.eventType === "PARTY_UPDATED" ? "Candidate party changed" : STATUS_LABEL[e.toStatus]}</div>
                  <div className="text-xs text-muted-foreground">{dateTimeText(e.createdAt)} · {e.actorName} ({e.actorRole.replace(/_/g, " ").toLowerCase()})</div>
                  {e.details && <div className="text-xs">{Object.entries(e.details).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ")}</div>}
                </li>
              ))}
            </ol>
          </details>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
