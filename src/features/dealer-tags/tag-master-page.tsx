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
import { useLabel } from "@/features/labels/label-ui";
type MasterLabels = { module: string; singular: string; search: string; tagName: string; markerType: string; marker: string; markerHelp: string; active: string };
/** The resource form's text comes from the Labels system (resolved by the page); keys and field names stay fixed. */
const buildConfig = (L: MasterLabels): ResourceClientConfig => ({
  key: "dealerTags",
  label: L.module,
  singular: L.singular,
  softDelete: true,
  searchPlaceholder: L.search,
  columns: [],
  fields: [
    { name: "name", label: L.tagName, type: "text", required: true },
    { name: "markerType", label: L.markerType, type: "select", optionsKey: "markerTypes", required: true },
    { name: "marker", label: L.marker, type: "text", required: true, helpText: L.markerHelp },
    { name: "isActive", label: L.active, type: "switch", defaultValue: "true" },
  ],
});
export function TagMasterPage() {
  const qc = useQueryClient();
  const L = {
    title: useLabel("dealer_tags.master.title"), subtitle: useLabel("dealer_tags.master.subtitle"), module: useLabel("dealer_tags.master.module"), singular: useLabel("dealer_tags.master.singular"),
    search: useLabel("dealer_tags.master.search"), tagName: useLabel("dealer_tags.master.tag_name"), marker: useLabel("dealer_tags.master.marker"), markerType: useLabel("dealer_tags.master.marker_type"),
    type: useLabel("dealer_tags.master.type"), markerHelp: useLabel("dealer_tags.master.marker_help"), typeText: useLabel("dealer_tags.master.type_text"), typeTextShort: useLabel("dealer_tags.master.type_text_short"),
    typeSymbol: useLabel("dealer_tags.master.type_symbol"), edit: useLabel("dealer_tags.master.edit"), add: useLabel("dealer_tags.action.add_tag"), status: useLabel("dealer_tags.col.status"),
    active: useLabel("dealer_tags.status.active"), inactive: useLabel("dealer_tags.status.inactive"), action: useLabel("dealer_tags.requests.col.action"),
  };
  const config = buildConfig(L);
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
        title={L.title}
        subtitle={L.subtitle}
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            {L.add}
          </Button>
        }
      />
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <Table numbered>
        <TableHeader>
          <TableRow>
            <TableHead>{L.tagName}</TableHead>
            <TableHead>{L.marker}</TableHead>
            <TableHead>{L.type}</TableHead>
            <TableHead>{L.status}</TableHead>
            <TableHead>{L.action}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data ?? []).map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.name}</TableCell>
              <TableCell>{t.marker}</TableCell>
              <TableCell>{t.markerType === "TEXT" ? L.typeTextShort : L.typeSymbol}</TableCell>
              <TableCell>{t.isActive ? L.active : L.inactive}</TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(t);
                    setOpen(true);
                  }}
                >
                  {L.edit}
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
            { value: "TEXT", label: L.typeText },
            { value: "SYMBOL", label: L.typeSymbol },
          ],
        }}
      />
    </div>
  );
}
