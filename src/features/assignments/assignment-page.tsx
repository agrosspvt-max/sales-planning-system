"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, History } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OptionMap = Record<string, { value: string; label: string }[]>;
type Row = Record<string, unknown> & { id: string; effectiveFrom: string };

export interface AssignField {
  name: string;
  label: string;
  optionsKey: "dealers" | "officers" | "managers" | "dealerOwners";
}

export interface AssignmentConfig {
  title: string;
  description: string;
  endpoint: string;
  canManage: boolean;
  columns: { key: string; label: string }[];
  fields: AssignField[];
  history: {
    param: "dealerId" | "officerId";
    idKey: string;
    nameKey: string;
    nameLabel: string;
    subjectKey: string;
  };
}

interface HistoryRow {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  [key: string]: unknown;
}

export function AssignmentPage({ config }: { config: AssignmentConfig }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<{ id: string; label: string } | null>(null);

  const { data: history } = useQuery<HistoryRow[]>({
    queryKey: ["assignment-history", config.endpoint, historyFor?.id],
    queryFn: () => api.get<HistoryRow[]>(`${config.endpoint}?${config.history.param}=${historyFor!.id}`),
    enabled: historyFor !== null,
  });

  const { data: rows, isLoading } = useQuery<Row[]>({
    queryKey: ["assignments", config.endpoint],
    queryFn: () => api.get<Row[]>(config.endpoint),
  });

  const { data: options } = useQuery<OptionMap>({
    queryKey: ["assignment-options"],
    queryFn: () => api.get<OptionMap>("/api/assignments/options"),
    enabled: open,
  });

  const createMut = useMutation({
    mutationFn: (payload: Record<string, string>) => api.post(config.endpoint, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assignments", config.endpoint] });
      setOpen(false);
      setValues({});
    },
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    for (const f of config.fields) {
      if (!values[f.name]) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    try {
      await createMut.mutateAsync({ ...values, effectiveFrom });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save assignment");
    }
  }

  const colSpan = config.columns.length + 1;

  return (
    <div className="space-y-4">
      <PageHeader
        title={config.title}
        subtitle={config.description}
        actions={
          config.canManage ? (
            <Button
              onClick={() => {
                setValues({});
                setError(null);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New Assignment
            </Button>
          ) : undefined
        }
      />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {config.columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
              <TableHead className="text-right">History</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (rows?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10 text-center text-muted-foreground">
                  No current assignments.
                </TableCell>
              </TableRow>
            ) : (
              rows!.map((r) => (
                <TableRow key={r.id}>
                  {config.columns.map((c) => (
                    <TableCell key={c.key}>
                      {c.key === "effectiveFrom"
                        ? formatDate(r.effectiveFrom)
                        : String(r[c.key] ?? "—")}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="View history"
                      onClick={() =>
                        setHistoryFor({
                          id: String(r[config.history.subjectKey]),
                          label: String(r[config.columns[0].key]),
                        })
                      }
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Assignment</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            {config.fields.map((f) => (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={f.name}>{f.label}</Label>
                <NativeSelect
                  id={f.name}
                  options={options?.[f.optionsKey] ?? []}
                  placeholder="Select…"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  required
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="effectiveFrom">Effective From</Label>
              <Input
                id="effectiveFrom"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyFor !== null} onOpenChange={(o) => !o && setHistoryFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assignment history — {historyFor?.label}</DialogTitle>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{config.history.nameLabel}</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(history?.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                    No history.
                  </TableCell>
                </TableRow>
              ) : (
                history!.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{String(h[config.history.nameKey] ?? "—")}</TableCell>
                    <TableCell>{formatDate(h.effectiveFrom)}</TableCell>
                    <TableCell>{h.effectiveTo ? formatDate(h.effectiveTo) : "Current"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
