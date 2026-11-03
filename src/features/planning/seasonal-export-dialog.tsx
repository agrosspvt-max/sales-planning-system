"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api } from "@/lib/api-client";
import { useLabel } from "@/features/labels/label-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface OpenSeason { id: string; name: string; year: number }
interface PlanOption { planId: string; version: number; label: string; statusLabel: string }
interface OfficerOption { officerId: string; name: string; stateName: string | null; plans: PlanOption[]; defaultPlanId: string | null }

/** The filename the server chose (Content-Disposition), falling back to a generic name. */
export function downloadFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

/**
 * Export Seasonal Plan — choose a season, the Sales Officers and (per officer) the exact seasonal plan version. One workbook per officer; several
 * officers download as one ZIP. Presentation only: the server re-checks the permission, the season and every officer / version pairing.
 */
export function SeasonalExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const L = {
    title: useLabel("sales_planning.export.title"),
    season: useLabel("sales_planning.export.season"),
    selectSeason: useLabel("sales_planning.export.select_season"),
    officers: useLabel("sales_planning.export.officers"),
    search: useLabel("sales_planning.export.search"),
    selectAll: useLabel("sales_planning.export.select_all"),
    clear: useLabel("sales_planning.export.clear"),
    chooseVersion: useLabel("sales_planning.export.choose_version"),
    noPlan: useLabel("sales_planning.export.no_plan"),
    noOfficers: useLabel("sales_planning.export.no_officers"),
    selected: useLabel("sales_planning.export.selected"),
    multipleVersions: useLabel("sales_planning.export.multiple_versions"),
    export: useLabel("sales_planning.export.submit"),
    exporting: useLabel("sales_planning.export.exporting"),
    cancel: useLabel("sales_planning.export.cancel"),
    loading: useLabel("sales_planning.export.loading"),
    seasonRequired: useLabel("sales_planning.export.season_required"),
    officerRequired: useLabel("sales_planning.export.officer_required"),
    versionRequired: useLabel("sales_planning.export.version_required"),
    failed: useLabel("sales_planning.export.failed"),
    done: useLabel("sales_planning.export.done"),
    zipNote: useLabel("sales_planning.export.zip_note"),
  };
  const [seasonId, setSeasonId] = useState("");
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({}); // officerId → planId ("" = version not chosen yet)
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const inFlight = useRef(false);

  const seasons = useQuery<OpenSeason[]>({ queryKey: ["open-seasons"], queryFn: () => api.get<OpenSeason[]>("/api/planning/season-plans/open-seasons"), enabled: open, staleTime: 0 });
  const options = useQuery<{ officers: OfficerOption[] }>({
    queryKey: ["seasonal-export-options", seasonId],
    queryFn: () => api.get(`/api/planning/season-plans/export?seasonId=${encodeURIComponent(seasonId)}`),
    enabled: open && !!seasonId,
    staleTime: 0,
  });
  const officers = useMemo(() => options.data?.officers ?? [], [options.data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? officers.filter((o) => o.name.toLowerCase().includes(q) || (o.stateName ?? "").toLowerCase().includes(q)) : officers;
  }, [officers, search]);
  const selectedIds = Object.keys(chosen);

  const reset = (nextSeason: string) => { setSeasonId(nextSeason); setChosen({}); setSearch(""); setError(null); setNotice(null); };
  const toggle = (o: OfficerOption, on: boolean) => setChosen((prev) => {
    const next = { ...prev };
    if (on) next[o.officerId] = o.defaultPlanId ?? ""; else delete next[o.officerId];
    return next;
  });
  const selectAll = () => setChosen((prev) => {
    const next = { ...prev };
    for (const o of visible) if (o.plans.length > 0 && !(o.officerId in next)) next[o.officerId] = o.defaultPlanId ?? "";
    return next;
  });

  async function runExport() {
    if (inFlight.current) return; // one export at a time — no duplicate submissions
    setError(null); setNotice(null);
    if (!seasonId) return setError(L.seasonRequired);
    if (selectedIds.length === 0) return setError(L.officerRequired);
    const missing = officers.filter((o) => o.officerId in chosen && !chosen[o.officerId]);
    if (missing.length > 0) return setError(`${L.versionRequired} ${missing.map((o) => o.name).join(", ")}`);
    inFlight.current = true;
    setExporting(true);
    try {
      const response = await fetch("/api/planning/season-plans/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seasonId, plans: selectedIds.map((officerId) => ({ officerId, planId: chosen[officerId] })) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? L.failed);
        return;
      }
      const fallback = selectedIds.length === 1 ? "Seasonal Plan.xlsx" : "Seasonal Plans.zip";
      const filename = downloadFilename(response.headers.get("Content-Disposition"), fallback);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setNotice(L.done.replace("{count}", String(Number(response.headers.get("X-Export-Officers") ?? selectedIds.length))).replace("{file}", filename));
    } catch {
      setError(L.failed);
    } finally {
      inFlight.current = false;
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!exporting) onOpenChange(next); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="seasonal-export-season">{L.season} *</Label>
            <NativeSelect id="seasonal-export-season" value={seasonId} onChange={(e) => reset(e.target.value)} disabled={exporting}
              placeholder={seasons.isLoading ? L.loading : L.selectSeason} options={(seasons.data ?? []).map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))} />
          </div>
          {seasonId && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{L.officers} *</Label>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={selectAll} disabled={exporting || officers.length === 0}>{L.selectAll}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setChosen({})} disabled={exporting || selectedIds.length === 0}>{L.clear}</Button>
                </div>
              </div>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L.search} aria-label={L.search} disabled={exporting} />
              <div className="max-h-80 overflow-auto rounded-md border" role="listbox" aria-multiselectable="true" aria-label={L.officers}>
                {options.isLoading && <p className="p-3 text-sm text-muted-foreground">{L.loading}</p>}
                {options.error && <p className="p-3 text-sm text-destructive">{(options.error as Error).message}</p>}
                {!options.isLoading && !options.error && visible.length === 0 && <p className="p-3 text-sm text-muted-foreground">{L.noOfficers}</p>}
                {visible.map((o) => {
                  const selected = o.officerId in chosen;
                  const none = o.plans.length === 0;
                  return (
                    <div key={o.officerId} role="option" aria-selected={selected} className="flex flex-wrap items-center gap-3 border-b px-3 py-2 last:border-b-0" data-testid={`export-officer-${o.officerId}`}>
                      <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-sm">
                        <input type="checkbox" checked={selected} disabled={none || exporting} onChange={(e) => toggle(o, e.target.checked)} />
                        <span className="font-medium">{o.name}</span>
                        {o.stateName && <span className="text-xs text-muted-foreground">{o.stateName}</span>}
                      </label>
                      {none ? (
                        <span className="text-xs text-muted-foreground">{L.noPlan}</span>
                      ) : o.plans.length === 1 ? (
                        <span className="text-xs">{o.plans[0]!.label}</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <NativeSelect aria-label={`${L.chooseVersion} — ${o.name}`} className="h-8 text-xs" value={selected ? chosen[o.officerId] : o.defaultPlanId ?? ""} disabled={exporting}
                            onChange={(e) => setChosen((prev) => ({ ...prev, [o.officerId]: e.target.value }))}
                            placeholder={L.chooseVersion} options={o.plans.map((p) => ({ value: p.planId, label: p.label }))} />
                          <span className="text-[11px] text-muted-foreground">{L.multipleVersions.replace("{count}", String(o.plans.length))}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{L.selected.replace("{count}", String(selectedIds.length))}{selectedIds.length > 1 ? ` ${L.zipNote}` : ""}</p>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>{L.cancel}</Button>
          <Button onClick={() => void runExport()} disabled={exporting || !seasonId || selectedIds.length === 0}>
            <Download className="h-4 w-4" /> {exporting ? L.exporting : L.export}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
