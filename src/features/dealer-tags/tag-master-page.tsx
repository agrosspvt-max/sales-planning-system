"use client";
import { refreshDealerTags } from "./refresh";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { ResourceForm } from "@/features/resources/resource-form";
import type { ResourceClientConfig } from "@/features/resources/config";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import type { TagDefinition } from "./types";
const config: ResourceClientConfig = {
  key: "dealerTags",
  label: "Dealer Tags",
  singular: "Dealer Tag",
  softDelete: true,
  searchPlaceholder: "Search tags…",
  columns: [],
  fields: [
    { name: "name", label: "Tag Name", type: "text", required: true },
    {
      name: "markerType",
      label: "Marker Type",
      type: "select",
      optionsKey: "markerTypes",
      required: true,
    },
    {
      name: "marker",
      label: "Marker",
      type: "text",
      required: true,
      helpText: "Text: 1–8 letters/numbers, such as FP. Symbol: an emoji or symbol, such as ⭐.",
    },
    { name: "isActive", label: "Active", type: "switch", defaultValue: "true" },
  ],
};
export function TagMasterPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TagDefinition | null>(null);
  const { data, error } = useQuery<TagDefinition[]>({
    queryKey: ["dealer-tags", "master"],
    queryFn: () => api.get("/api/dealer-tags"),
  });
  const save = async (values: Record<string, string>) => {
    const body = { ...values, isActive: values.isActive === "true" };
    if (editing) await api.patch(`/api/dealer-tags/${editing.id}`, body);
    else await api.post("/api/dealer-tags", body);
    await refreshDealerTags(qc);
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title="Tag Master"
        subtitle="Global dealer markers. Inactive tags retain assignments and history."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            Add Tag
          </Button>
        }
      />
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag Name</TableHead>
            <TableHead>Marker</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data ?? []).map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.name}</TableCell>
              <TableCell>{t.marker}</TableCell>
              <TableCell>{t.markerType === "TEXT" ? "Text" : "Symbol / Emoji"}</TableCell>
              <TableCell>{t.isActive ? "Active" : "Inactive"}</TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(t);
                    setOpen(true);
                  }}
                >
                  Edit
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ResourceForm
        config={config}
        open={open}
        onOpenChange={setOpen}
        initial={editing ? { ...editing } : null}
        onSubmit={save}
        optionOverrides={{
          markerTypes: [
            { value: "TEXT", label: "Text / Initials" },
            { value: "SYMBOL", label: "Symbol / Emoji" },
          ],
        }}
      />
    </div>
  );
}
