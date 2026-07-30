"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { FieldDef, ResourceClientConfig } from "./config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OptionMap = Record<string, { value: string; label: string }[]>;
type Row = Record<string, unknown>;

interface ResourceFormProps {
  config: ResourceClientConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Row | null;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}

function visibleFields(fields: FieldDef[], isEdit: boolean): FieldDef[] {
  return fields.filter((f) => !(isEdit && f.createOnly));
}

export function ResourceForm({ config, open, onOpenChange, initial, onSubmit }: ResourceFormProps) {
  const isEdit = Boolean(initial);
  const fields = visibleFields(config.fields, isEdit);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const needsOptions = fields.some((f) => f.type === "select");
  const { data: options } = useQuery<OptionMap>({
    queryKey: ["resource-options"],
    queryFn: () => api.get<OptionMap>("/api/resources/options"),
    enabled: open && needsOptions,
  });

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    for (const f of fields) {
      const v = initial?.[f.name];
      next[f.name] = v === null || v === undefined ? "" : String(v);
    }
    setValues(next);
    setError(null);
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit" : "New"} {config.singular}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? "Update the details below." : `Create a new ${config.singular.toLowerCase()}.`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={f.name}>
                {f.label}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
              {f.type === "textarea" ? (
                <Textarea
                  id={f.name}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  required={f.required}
                />
              ) : f.type === "select" ? (
                <NativeSelect
                  id={f.name}
                  options={options?.[f.optionsKey ?? ""] ?? []}
                  placeholder={f.required ? "Select…" : "— None —"}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  required={f.required}
                />
              ) : f.type === "switch" ? (
                <label className="flex items-center gap-2">
                  <input
                    id={f.name}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={values[f.name] === "true"}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked ? "true" : "false" }))}
                  />
                  <span className="text-sm">{values[f.name] === "true" ? "Yes" : "No"}</span>
                </label>
              ) : (
                <Input
                  id={f.name}
                  type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"}
                  step={f.step}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  required={f.required}
                />
              )}
              {f.helpText && <p className="text-xs text-muted-foreground">{f.helpText}</p>}
            </div>
          ))}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
