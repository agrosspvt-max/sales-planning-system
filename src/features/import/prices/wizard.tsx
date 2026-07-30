"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatPercent } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Mapping = Record<string, string>; // field → header

interface ParseResult {
  sheetName: string;
  headers: string[];
  rows: (string | number)[][];
  detectedMapping: Mapping;
  savedMapping: Mapping | null;
  signature: string;
}
interface PriceItem {
  productName: string;
  technicalName?: string;
  rate?: number;
  nbvPercent?: number;
  brand?: string;
  category?: string;
  packSize?: string;
}
interface PreviewRow {
  productName: string;
  status: "new" | "update" | "duplicate" | "missing" | "invalid";
  issues: string[];
  existing: {
    rate: number;
    nbvPercent: number;
    technicalName: string | null;
    brand: string | null;
    category: string | null;
  } | null;
}

const FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "productName", label: "Product Name", required: true },
  { key: "technicalName", label: "Technical Name" },
  { key: "rate", label: "Rate" },
  { key: "nbv", label: "NBV (% or fraction)" },
  { key: "brand", label: "Brand (optional)" },
  { key: "category", label: "Category (optional)" },
  { key: "packSize", label: "Pack Size (optional)" },
];

const STATUS_VARIANT: Record<PreviewRow["status"], "success" | "secondary" | "muted" | "destructive"> = {
  new: "success",
  update: "secondary",
  duplicate: "muted",
  missing: "destructive",
  invalid: "destructive",
};

export function PriceImportWizard() {
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [items, setItems] = useState<PriceItem[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [unknownPacks, setUnknownPacks] = useState<string[]>([]);
  const [packResolutions, setPackResolutions] = useState<
    Record<string, { action: "create" | "ignore" | "map"; mapToId: string }>
  >({});
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: existingPacks } = useQuery<{ items: { id: string; name: string }[] }>({
    queryKey: ["packsizes-for-import"],
    queryFn: () => api.get("/api/resources/packSizes?pageSize=100"),
  });

  const parseMut = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/prices/parse", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to parse file");
      return body as ParseResult;
    },
    onSuccess: (p) => {
      setParsed(p);
      setMapping(p.savedMapping ?? p.detectedMapping ?? {});
      setStep("map");
    },
    onError: (e) => setError((e as Error).message),
  });

  function buildItems(): PriceItem[] {
    if (!parsed) return [];
    const idx = (field: string) =>
      mapping[field] ? parsed.headers.indexOf(mapping[field]) : -1;
    const cell = (row: (string | number)[], field: string) => {
      const i = idx(field);
      return i >= 0 ? row[i] : undefined;
    };
    return parsed.rows
      .map((row) => {
        const name = String(cell(row, "productName") ?? "").trim();
        const item: PriceItem = { productName: name };
        const tech = cell(row, "technicalName");
        if (tech !== undefined && tech !== "") item.technicalName = String(tech);
        const rate = cell(row, "rate");
        if (rate !== undefined && rate !== "") item.rate = Number(rate);
        const nbvRaw = cell(row, "nbv");
        if (nbvRaw !== undefined && nbvRaw !== "") {
          const n = Number(nbvRaw);
          item.nbvPercent = n > 1 ? n / 100 : n; // percent → fraction
        }
        const brand = cell(row, "brand");
        if (brand !== undefined && brand !== "") item.brand = String(brand);
        const category = cell(row, "category");
        if (category !== undefined && category !== "") item.category = String(category);
        const pack = cell(row, "packSize");
        if (pack !== undefined && pack !== "") item.packSize = String(pack);
        return item;
      })
      .filter((it) => it.productName.length > 0);
  }

  const previewMut = useMutation({
    mutationFn: (its: PriceItem[]) =>
      api.post<{ rows: PreviewRow[]; unknownPackSizes: string[] }>("/api/import/prices/preview", {
        items: its,
      }),
    onSuccess: (data) => {
      setPreview(data.rows);
      setUnknownPacks(data.unknownPackSizes);
      setPackResolutions(
        Object.fromEntries(data.unknownPackSizes.map((n) => [n, { action: "ignore" as const, mapToId: "" }])),
      );
      setStep("preview");
    },
    onError: (e) => setError((e as Error).message),
  });

  const commitMut = useMutation({
    mutationFn: () =>
      api.post<Record<string, number>>("/api/import/prices/commit", {
        items,
        mapping,
        signature: parsed?.signature,
        packSizeResolutions: Object.entries(packResolutions).map(([name, r]) => ({
          name,
          action: r.action,
          mapToId: r.mapToId || undefined,
        })),
      }),
    onSuccess: (r) => setResult(r),
    onError: (e) => setError((e as Error).message),
  });

  function goPreview() {
    setError(null);
    if (!mapping.productName) {
      setError("Map the Product Name column before continuing.");
      return;
    }
    const its = buildItems();
    setItems(its);
    previewMut.mutate(its);
  }

  const summary = preview.reduce(
    (a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      return a;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product Price Import"
        subtitle="Import or update the Product Master from a workbook or a standalone PRICELIST sheet."
      />

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1 — Upload</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Accepts .xlsx / .xls (full workbook or an exported PRICELIST). Parsed in memory, never stored.
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
                <Loader2 className="h-4 w-4 animate-spin" /> Parsing…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === "map" && parsed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Step 2 — Map columns (sheet: {parsed.sheetName})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Columns were auto-detected from the header names. Adjust if needed. Unmapped optional
              fields are left unchanged on existing products.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>
                    {f.label}
                    {f.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <NativeSelect
                    className="w-full"
                    placeholder="— Not mapped —"
                    options={parsed.headers.map((h) => ({ value: h, label: h }))}
                    value={mapping[f.key] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (e.target.value) next[f.key] = e.target.value;
                        else delete next[f.key];
                        return next;
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => setStep("upload")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button onClick={goPreview} disabled={previewMut.isPending}>
                Preview <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3 — Preview &amp; import</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {result ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 font-medium text-success">
                  <Check className="h-5 w-5" /> Import complete.
                </p>
                <ul className="text-sm text-muted-foreground">
                  <li>New products: {result.newProducts}</li>
                  <li>Updated products: {result.updatedProducts}</li>
                  <li>Skipped: {result.skipped}</li>
                </ul>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant="success">New: {summary.new ?? 0}</Badge>
                  <Badge variant="secondary">Update: {summary.update ?? 0}</Badge>
                  <Badge variant="muted">Duplicate: {summary.duplicate ?? 0}</Badge>
                  <Badge variant="destructive">Missing: {summary.missing ?? 0}</Badge>
                  <Badge variant="destructive">Invalid: {summary.invalid ?? 0}</Badge>
                </div>

                {unknownPacks.length > 0 && (
                  <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                    <p className="text-sm font-medium">
                      Unknown pack sizes — nothing is created automatically. Choose an action for each.
                    </p>
                    {unknownPacks.map((name) => (
                      <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="w-32 font-medium">{name}</span>
                        <NativeSelect
                          className="h-8 w-40"
                          options={[
                            { value: "ignore", label: "Ignore" },
                            { value: "create", label: "Create new" },
                            { value: "map", label: "Map to existing" },
                          ]}
                          value={packResolutions[name]?.action ?? "ignore"}
                          onChange={(e) =>
                            setPackResolutions((p) => ({
                              ...p,
                              [name]: { action: e.target.value as "create" | "ignore" | "map", mapToId: p[name]?.mapToId ?? "" },
                            }))
                          }
                        />
                        {packResolutions[name]?.action === "map" && (
                          <NativeSelect
                            className="h-8 w-40"
                            placeholder="Select pack size…"
                            options={(existingPacks?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
                            value={packResolutions[name]?.mapToId ?? ""}
                            onChange={(e) =>
                              setPackResolutions((p) => ({
                                ...p,
                                [name]: { action: "map", mapToId: e.target.value },
                              }))
                            }
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="max-h-[28rem] overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead>Rate</TableHead>
                        <TableHead>NBV</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.map((row, i) => (
                        <TableRow
                          key={i}
                          className={cn(
                            (row.status === "missing" || row.status === "invalid") && "bg-destructive/5",
                          )}
                        >
                          <TableCell className="font-medium">{row.productName || "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {row.existing && items[i]?.rate !== row.existing.rate && (
                                <span className="text-xs text-muted-foreground line-through">
                                  {formatCurrency(row.existing.rate)}
                                </span>
                              )}
                              <Input
                                type="number"
                                className={cn(
                                  "h-8 w-24",
                                  row.existing && items[i]?.rate !== row.existing.rate && "ring-1 ring-warning",
                                )}
                                value={items[i]?.rate ?? ""}
                                onChange={(e) =>
                                  setItems((its) =>
                                    its.map((it, j) =>
                                      j === i
                                        ? { ...it, rate: e.target.value === "" ? undefined : Number(e.target.value) }
                                        : it,
                                    ),
                                  )
                                }
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {row.existing && items[i]?.nbvPercent !== row.existing.nbvPercent && (
                                <span className="text-xs text-muted-foreground line-through">
                                  {formatPercent(row.existing.nbvPercent)}
                                </span>
                              )}
                              <Input
                                type="number"
                                step="0.0001"
                                className={cn(
                                  "h-8 w-24",
                                  row.existing &&
                                    items[i]?.nbvPercent !== row.existing.nbvPercent &&
                                    "ring-1 ring-warning",
                                )}
                                value={items[i]?.nbvPercent ?? ""}
                                onChange={(e) =>
                                  setItems((its) =>
                                    its.map((it, j) =>
                                      j === i
                                        ? {
                                            ...it,
                                            nbvPercent: e.target.value === "" ? undefined : Number(e.target.value),
                                          }
                                        : it,
                                    ),
                                  )
                                }
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
                            {row.issues.length > 0 && (
                              <span className="ml-1 text-xs text-destructive">{row.issues.join(", ")}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex items-center justify-between">
                  <Button variant="outline" onClick={() => setStep("map")}>
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => previewMut.mutate(items)} disabled={previewMut.isPending}>
                      Re-check
                    </Button>
                    <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending}>
                      {commitMut.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4" /> Import to Product Master
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
