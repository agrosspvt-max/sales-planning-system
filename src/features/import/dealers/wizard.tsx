"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, ArrowLeft, ArrowRight, Check, Loader2, AlertTriangle, Copy } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Named {
  id: string;
  name: string;
}
interface OfficerCandidate {
  name: string;
  source: string;
  matches: Named[];
}
interface ParseResult {
  workbookName: string;
  sheetCount: number;
  sheets: { name: string; defaultIgnore: boolean }[];
  officerCandidates: OfficerCandidate[];
  defaultCandidateName: string | null;
}
interface Options {
  officers: Named[];
  managers: Named[];
  managerByOfficer: Record<string, string>;
  officersByManager: Record<string, string[]>;
}
interface Dup {
  id: string;
  name: string;
  confidence: number;
  currentOfficerName: string | null;
}
interface Resolved {
  name: string;
  existsInDb: boolean;
  existingId: string | null;
  currentOfficerName: string | null;
  currentRmName: string | null;
  possibleDuplicates: Dup[];
}
interface NewOfficer {
  tempId: string;
  name: string;
  username: string;
  phone: string;
  email: string;
  managerId: string;
  passwordMode: "auto" | "manual";
  password: string;
}
interface DealerRow extends Resolved {
  skip: boolean;
  officer: string; // "" | "e:<id>" | "n:<tempId>"
  mergeWithId: string;
}
interface CommitResult {
  status: string;
  counts: Record<string, number>;
  errors: string[];
  warnings: string[];
  createdCredentials: { name: string; username: string; password: string }[];
}
interface DealerOpData {
  dealerId: string;
  dealerName: string;
  currentOfficerName: string | null;
  seasonPlans: number;
  monthlyPlans: number;
  actualSales: number;
  approvalActions: number;
}

type Step = "upload" | "configure" | "review";

export function DealerImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [ignore, setIgnore] = useState<Set<string>>(new Set());
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [newOfficers, setNewOfficers] = useState<NewOfficer[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [officerFilter, setOfficerFilter] = useState("");
  const [validation, setValidation] = useState<CommitResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reassignData, setReassignData] = useState<DealerOpData[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: options } = useQuery<Options>({
    queryKey: ["import-options"],
    queryFn: () => api.get<Options>("/api/import/dealers/options"),
  });

  const officerName = (o: string): string => {
    if (o.startsWith("e:")) return options?.officers.find((x) => x.id === o.slice(2))?.name ?? "—";
    if (o.startsWith("n:")) return newOfficers.find((x) => x.tempId === o.slice(2))?.name || "(new officer)";
    return "—";
  };
  const officerRm = (o: string): string => {
    let managerId: string | undefined;
    if (o.startsWith("e:")) managerId = options?.managerByOfficer[o.slice(2)];
    if (o.startsWith("n:")) managerId = newOfficers.find((x) => x.tempId === o.slice(2))?.managerId;
    if (!managerId) return "Direct to Super Admin";
    return options?.managers.find((m) => m.id === managerId)?.name ?? "—";
  };
  const officerSelectOptions = useMemo(
    () => [
      ...(options?.officers ?? []).map((o) => ({ value: `e:${o.id}`, label: o.name })),
      ...newOfficers.map((o) => ({ value: `n:${o.tempId}`, label: `${o.name || "New officer"} (new)` })),
    ],
    [options, newOfficers],
  );

  function rowInfo(d: DealerRow) {
    const newSO = officerName(d.officer);
    const derivedRM = officerRm(d.officer);
    const merge = d.mergeWithId ? d.possibleDuplicates.find((p) => p.id === d.mergeWithId) : null;
    const hasTarget = d.existsInDb || !!merge;
    const curSO = merge ? merge.currentOfficerName : d.currentOfficerName;
    let status: string;
    if (d.skip) status = "Skipped";
    else if (d.existsInDb || merge) status = "Existing";
    else if (d.possibleDuplicates.length > 0) status = "Possible Duplicate";
    else status = "New";
    let action: string;
    if (d.skip) action = "Skipped";
    else if (!hasTarget) action = "Create";
    else action = newSO !== "—" && newSO === curSO ? "No Change" : "Reassign";
    return { newSO, derivedRM, currentSO: curSO ?? "—", currentRM: d.currentRmName ?? "—", status, action };
  }

  /* ------------------------------ Parse ------------------------------ */
  const parseMut = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/dealers/parse", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to parse workbook");
      return body as ParseResult;
    },
    onSuccess: async (p) => {
      setParsed(p);
      const ig = new Set(p.sheets.filter((s) => s.defaultIgnore).map((s) => s.name));
      setIgnore(ig);
      const match = p.officerCandidates.find((c) => c.matches.length > 0);
      const defaultOfficer = match ? `e:${match.matches[0].id}` : "";
      await loadDealers(p, ig, defaultOfficer);
      setStep("configure");
    },
    onError: (e) => setError((e as Error).message),
  });

  async function loadDealers(p: ParseResult, ig: Set<string>, defaultOfficer: string) {
    const names = p.sheets.filter((s) => !ig.has(s.name)).map((s) => s.name);
    const resolved = await api.post<Resolved[]>("/api/import/dealers/resolve", { names });
    setDealers(
      resolved.map((r) => ({ ...r, skip: false, officer: defaultOfficer, mergeWithId: "" })),
    );
  }

  async function applyIgnore() {
    if (!parsed) return;
    const prevOfficer = dealers[0]?.officer ?? "";
    await loadDealers(parsed, ignore, prevOfficer);
  }

  /* ---------------------------- Bulk / edit --------------------------- */
  const setAllOfficer = (o: string) => setDealers((ds) => ds.map((d) => ({ ...d, officer: o })));
  const setSelectedOfficer = (o: string) =>
    setDealers((ds) => ds.map((d, i) => (selected.has(i) ? { ...d, officer: o } : d)));
  const setSelectedSkip = (skip: boolean) =>
    setDealers((ds) => ds.map((d, i) => (selected.has(i) ? { ...d, skip } : d)));
  const addNewOfficer = () =>
    setNewOfficers((n) => [
      ...n,
      { tempId: `t${Date.now()}${n.length}`, name: "", username: "", phone: "", email: "", managerId: "", passwordMode: "auto", password: "" },
    ]);

  function buildPayload(validateOnly: boolean) {
    const usedTempIds = new Set(
      dealers.filter((d) => !d.skip && d.officer.startsWith("n:")).map((d) => d.officer.slice(2)),
    );
    return {
      workbookName: parsed?.workbookName ?? "workbook",
      effectiveFrom,
      validateOnly,
      createOfficers: newOfficers
        .filter((o) => usedTempIds.has(o.tempId))
        .map((o) => ({
          tempId: o.tempId,
          name: o.name,
          username: o.username || undefined,
          phone: o.phone || undefined,
          email: o.email || undefined,
          managerId: o.managerId || undefined,
          password: o.passwordMode === "manual" ? o.password : undefined,
        })),
      dealers: dealers.map((d) => ({
        name: d.name,
        action: d.skip ? "skip" : "import",
        existingOfficerId: d.officer.startsWith("e:") ? d.officer.slice(2) : undefined,
        newOfficerTempId: d.officer.startsWith("n:") ? d.officer.slice(2) : undefined,
        mergeWithExistingId: d.mergeWithId || undefined,
      })),
    };
  }

  const validateMut = useMutation({
    mutationFn: () => api.post<CommitResult>("/api/import/dealers/commit", buildPayload(true)),
    onSuccess: (r) => {
      setValidation(r);
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });
  const commitMut = useMutation({
    mutationFn: () => api.post<CommitResult>("/api/import/dealers/commit", buildPayload(false)),
    onSuccess: (r) => {
      if (r.status === "FAILED") {
        setValidation(r);
        setError("Import blocked by validation errors. See below.");
      } else {
        setResult(r);
        setError(null);
      }
    },
    onError: (e) => setError((e as Error).message),
  });

  // Existing dealers that carry an id and are being moved to a different officer.
  const reassignTargetIds = (): string[] =>
    dealers
      .filter((d) => !d.skip)
      .map((d) => ({ d, info: rowInfo(d) }))
      .filter(({ info }) => info.action === "Reassign")
      .map(({ d }) => d.mergeWithId || d.existingId)
      .filter((x): x is string => !!x);

  const reassignCheckMut = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<DealerOpData[]>("/api/import/dealers/operational-data", { dealerIds: ids }),
  });

  // Safeguard: before committing, if any reassigned dealer has operational
  // history, surface a confirmation dialog. Never blocks — proceeds on confirm
  // (or if the check itself fails, since the check is advisory only).
  async function startImport() {
    setError(null);
    const ids = reassignTargetIds();
    if (ids.length === 0) {
      commitMut.mutate();
      return;
    }
    try {
      const data = await reassignCheckMut.mutateAsync(ids);
      if (data.length > 0) {
        setReassignData(data);
        setConfirmOpen(true);
      } else {
        commitMut.mutate();
      }
    } catch {
      commitMut.mutate();
    }
  }

  const filtered = dealers
    .map((d, i) => ({ d, i, info: rowInfo(d) }))
    .filter(({ d, info }) => {
      if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter && info.status !== statusFilter) return false;
      if (officerFilter && d.officer !== officerFilter) return false;
      return true;
    });
  const importCount = dealers.filter((d) => !d.skip).length;

  async function copyCreds() {
    if (!result) return;
    const text = result.createdCredentials.map((c) => `${c.name}: ${c.username} / ${c.password}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  /* -------------------------------- Render ------------------------------ */
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dealer Import Wizard"
        subtitle="Upload a Sales Officer's planning workbook to discover and assign dealers in one step."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/masters/import-history">Import history</Link>
          </Button>
        }
      />

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1 — Upload workbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Accepts .xlsx and .xls. Parsed in memory and never stored.
            </p>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="block text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setError(null);
                if (file) parseMut.mutate(file);
              }}
            />
            {parseMut.isPending && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Parsing workbook…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === "configure" && parsed && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Step 2 — {parsed.workbookName} · {parsed.sheetCount} sheets
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium">Sheets to ignore (checked = skipped)</p>
              <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {parsed.sheets.map((s) => (
                  <label key={s.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={ignore.has(s.name)}
                      onChange={() =>
                        setIgnore((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.name)) next.delete(s.name);
                          else next.add(s.name);
                          return next;
                        })
                      }
                    />
                    {s.name}
                  </label>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={applyIgnore}>
                Apply sheet selection
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Step 3 — Sales Officer &amp; assignment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {parsed.officerCandidates.length > 0 ? (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Detected candidates:</p>
                  {parsed.officerCandidates.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Badge variant="muted">{c.source}</Badge>
                      <span>{c.name}</span>
                      {c.matches.length > 0 ? (
                        <button
                          className="text-primary hover:underline"
                          onClick={() => setAllOfficer(`e:${c.matches[0].id}`)}
                        >
                          use existing: {c.matches[0].name}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">no existing match</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No officer detected — choose one below.</p>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label>Assign all dealers to</Label>
                  <NativeSelect
                    className="w-64"
                    placeholder="Select officer…"
                    options={officerSelectOptions}
                    value=""
                    onChange={(e) => e.target.value && setAllOfficer(e.target.value)}
                  />
                </div>
                <Button variant="outline" size="sm" onClick={addNewOfficer}>
                  + New Sales Officer
                </Button>
                <div className="space-y-1.5">
                  <Label htmlFor="eff">Effective from</Label>
                  <Input id="eff" type="date" className="w-40" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                </div>
              </div>

              {newOfficers.length > 0 && (
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm font-medium">New Sales Officers</p>
                  {newOfficers.map((o, i) => (
                    <div key={o.tempId} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <Input placeholder="Full name *" value={o.name} onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                      <Input placeholder="Username (auto if blank)" value={o.username} onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))} />
                      <Input placeholder="Phone (optional)" value={o.phone} onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                      <Input placeholder="Email (optional)" value={o.email} onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                      <NativeSelect
                        placeholder="Reports to (RM) — optional"
                        options={(options?.managers ?? []).map((m) => ({ value: m.id, label: m.name }))}
                        value={o.managerId}
                        onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, managerId: e.target.value } : x)))}
                      />
                      <div className="flex items-center gap-2">
                        <NativeSelect
                          className="w-28"
                          options={[{ value: "auto", label: "Auto pwd" }, { value: "manual", label: "Manual" }]}
                          value={o.passwordMode}
                          onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, passwordMode: e.target.value as "auto" | "manual" } : x)))}
                        />
                        {o.passwordMode === "manual" && (
                          <Input placeholder="Password" value={o.password} onChange={(e) => setNewOfficers((n) => n.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Step 4 — Dealers ({dealers.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input className="w-48" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <NativeSelect className="w-44" placeholder="All statuses" options={["New", "Existing", "Possible Duplicate", "Skipped"].map((s) => ({ value: s, label: s }))} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} />
                <NativeSelect className="w-48" placeholder="All officers" options={officerSelectOptions} value={officerFilter} onChange={(e) => setOfficerFilter(e.target.value)} />
                <NativeSelect className="w-52" placeholder="Assign selected to…" options={officerSelectOptions} value="" onChange={(e) => e.target.value && setSelectedOfficer(e.target.value)} />
                <Button variant="outline" size="sm" onClick={() => setSelectedSkip(true)}>Skip selected</Button>
                <Button variant="outline" size="sm" onClick={() => setSelectedSkip(false)}>Unskip</Button>
                <span className="text-xs text-muted-foreground">{selected.size} selected</span>
              </div>

              <div className="overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <input type="checkbox" checked={selected.size === dealers.length && dealers.length > 0} onChange={(e) => setSelected(e.target.checked ? new Set(dealers.map((_, i) => i)) : new Set())} />
                      </TableHead>
                      <TableHead>Dealer</TableHead>
                      <TableHead>Current SO</TableHead>
                      <TableHead>Current RM</TableHead>
                      <TableHead>New SO</TableHead>
                      <TableHead>Derived RM</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map(({ d, i, info }) => (
                      <TableRow key={i} className={cn(d.skip && "opacity-50")}>
                        <TableCell>
                          <input type="checkbox" checked={selected.has(i)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                        </TableCell>
                        <TableCell>
                          <Input className="h-8 w-40" value={d.name} onChange={(e) => setDealers((ds) => ds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                          {d.possibleDuplicates.length > 0 && !d.existsInDb && (
                            <NativeSelect
                              className="mt-1 h-7 w-48 text-xs"
                              options={[
                                { value: "", label: "Create new" },
                                ...d.possibleDuplicates.map((p) => ({ value: `m:${p.id}`, label: `Merge: ${p.name} (${p.confidence}%)` })),
                                { value: "skip", label: "Skip" },
                              ]}
                              value={d.skip ? "skip" : d.mergeWithId ? `m:${d.mergeWithId}` : ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                setDealers((ds) => ds.map((x, j) => (j === i ? { ...x, skip: v === "skip", mergeWithId: v.startsWith("m:") ? v.slice(2) : "" } : x)));
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{info.currentSO}</TableCell>
                        <TableCell className="text-muted-foreground">{info.currentRM}</TableCell>
                        <TableCell>
                          <NativeSelect className="h-8 w-40" placeholder="—" options={officerSelectOptions} value={d.officer} onChange={(e) => setDealers((ds) => ds.map((x, j) => (j === i ? { ...x, officer: e.target.value } : x)))} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{info.derivedRM}</TableCell>
                        <TableCell>
                          <span className={cn("inline-flex items-center gap-1", info.action === "Reassign" && "text-warning")}>
                            {info.action === "Reassign" && <AlertTriangle className="h-3.5 w-3.5" />}
                            {info.action}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={info.status === "New" ? "success" : info.status === "Possible Duplicate" ? "default" : info.status === "Skipped" ? "muted" : "secondary"}>
                            {info.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep("upload")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => validateMut.mutate()} disabled={validateMut.isPending}>
                {validateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Validate only
              </Button>
              <Button onClick={() => setStep("review")}>
                Review <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {validation && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Validation result</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>
                  Create {validation.counts.createdDealers} · Reassign {validation.counts.reassignedDealers} · No change{" "}
                  {validation.counts.noChangeDealers} · Skip {validation.counts.skippedDealers} · Possible duplicates{" "}
                  {validation.counts.possibleDuplicates}
                </p>
                {validation.errors.length > 0 && (
                  <div className="text-destructive">
                    <p className="font-medium">Errors:</p>
                    <ul className="list-disc pl-5">{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </div>
                )}
                {validation.warnings.length > 0 && (
                  <div className="text-warning">
                    <p className="font-medium">Warnings:</p>
                    <ul className="list-disc pl-5">{validation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                {validation.errors.length === 0 && <p className="text-success">No blocking errors — ready to import.</p>}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {step === "review" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 5 — Review &amp; import</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {result ? (
              <div className="space-y-4">
                <p className="flex items-center gap-2 text-lg font-medium text-success">
                  <Check className="h-6 w-6" /> Import completed successfully
                </p>
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    ["Dealers created", result.counts.createdDealers],
                    ["Dealers reassigned", result.counts.reassignedDealers],
                    ["No change", result.counts.noChangeDealers],
                    ["Officers created", result.counts.officersCreated],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border p-3">
                      <p className="text-xs uppercase text-muted-foreground">{label}</p>
                      <p className="text-xl font-semibold">{value}</p>
                    </div>
                  ))}
                </div>
                {result.warnings.length > 0 && (
                  <div className="text-sm text-warning">
                    <p className="font-medium">Warnings:</p>
                    <ul className="list-disc pl-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                {result.createdCredentials.length > 0 && (
                  <div className="rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-medium">New officer credentials</p>
                      <Button size="sm" variant="outline" onClick={copyCreds}>
                        <Copy className="h-4 w-4" /> Copy
                      </Button>
                    </div>
                    <ul className="text-sm">
                      {result.createdCredentials.map((c, i) => (
                        <li key={i} className="font-mono">
                          {c.name}: {c.username} / {c.password}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <Link href="/masters/dealers">View Dealers</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/masters/users">View Sales Officers</Link>
                  </Button>
                  <Button onClick={() => window.location.reload()}>Import another workbook</Button>
                </div>
              </div>
            ) : (
              <>
                <ul className="text-sm">
                  <li>Workbook: {parsed?.workbookName}</li>
                  <li>Sheets processed: {parsed?.sheetCount} · Dealer sheets: {dealers.length} · Skipped sheets: {(parsed?.sheetCount ?? 0) - dealers.length}</li>
                  <li>Dealers to import: {importCount} · Skipped dealers: {dealers.length - importCount}</li>
                  <li>New officers: {newOfficers.filter((o) => o.name.trim()).length}</li>
                  <li>Effective from: {effectiveFrom}</li>
                </ul>
                <p className="text-xs text-muted-foreground">Everything imports in a single transaction — all or nothing.</p>
                <div className="flex items-center justify-between">
                  <Button variant="outline" onClick={() => setStep("configure")}>
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <Button onClick={startImport} disabled={commitMut.isPending || reassignCheckMut.isPending || importCount === 0}>
                    {commitMut.isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
                    ) : reassignCheckMut.isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Checking…</>
                    ) : (
                      <><Upload className="h-4 w-4" /> Import {importCount} dealers</>
                    )}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-5 w-5" />
              Reassigning dealers that already have data
            </DialogTitle>
            <DialogDescription>
              {reassignData?.length === 1 ? "This dealer" : `These ${reassignData?.length ?? 0} dealers`} already have
              operational history. Their existing Season Plans, Monthly Plans, Actual Sales and Approval History
              stay unchanged and remain attributed to the current Sales Officer. Only future ownership moves to the
              newly assigned Sales Officer, effective {effectiveFrom}.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dealer</TableHead>
                  <TableHead>Current SO</TableHead>
                  <TableHead className="text-right">Seasonal Plans</TableHead>
                  <TableHead className="text-right">Monthly Plans</TableHead>
                  <TableHead className="text-right">Actual Sales</TableHead>
                  <TableHead className="text-right">Approval History</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(reassignData ?? []).map((r) => (
                  <TableRow key={r.dealerId}>
                    <TableCell className="font-medium">{r.dealerName}</TableCell>
                    <TableCell className="text-muted-foreground">{r.currentOfficerName ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.seasonPlans}</TableCell>
                    <TableCell className="text-right">{r.monthlyPlans}</TableCell>
                    <TableCell className="text-right">{r.actualSales}</TableCell>
                    <TableCell className="text-right">{r.approvalActions}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                commitMut.mutate();
              }}
            >
              <Upload className="h-4 w-4" /> Proceed with import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
