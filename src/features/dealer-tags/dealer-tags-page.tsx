"use client";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { refreshDealerTags } from "./refresh";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { Table, TableHeader, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { DealerTagRequests } from "./dealer-tag-requests";
import { SalesOfficerFilterHeader, type SalesOfficerOption } from "./sales-officer-filter";
import type { TagDefinition, TagDealer } from "./types";
export function DealerTagsPage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const [dealerId, setDealerId] = useState(""),
    [tagId, setTagId] = useState(""),
    [operation, setOperation] = useState<"ADD" | "REVOKE">("ADD"),
    [search, setSearch] = useState(""),
    [officerIds, setOfficerIds] = useState<string[]>([]);
  const dealers = useQuery<TagDealer[]>({
    queryKey: ["dealer-tags", "dealers"],
    queryFn: () => api.get("/api/dealer-tags/dealers"),
  });
  // Sales Officer filter: options and the filtered rows both come from the server, already scoped to the caller. The
  // picker above keeps using the unfiltered list, so the assignment workflow is unaffected by the filter.
  const officers = useQuery<SalesOfficerOption[]>({
    queryKey: ["dealer-tags", "sales-officers"],
    queryFn: () => api.get("/api/dealer-tags/sales-officers"),
  });
  const filterKey = [...officerIds].sort().join(",");
  const filtered = useQuery<TagDealer[]>({
    queryKey: ["dealer-tags", "dealers", "by-officer", filterKey],
    queryFn: () => api.get(`/api/dealer-tags/dealers?officerIds=${encodeURIComponent(filterKey)}`),
    enabled: officerIds.length > 0,
  });
  const tableDealers = officerIds.length > 0 ? (filtered.data ?? []) : (dealers.data ?? []);
  const tags = useQuery<TagDefinition[]>({
    queryKey: ["dealer-tags", "master"],
    queryFn: () => api.get("/api/dealer-tags"),
  });
  const selected = dealers.data?.find((d) => d.id === dealerId);
  const choices = (tags.data ?? []).filter((t) =>
    operation === "ADD"
      ? t.isActive && !selected?.assignedTags.some((a) => a.id === t.id)
      : selected?.assignedTags.some((a) => a.id === t.id),
  );
  const act = useMutation({
    mutationFn: () =>
      api.post(
        isAdministrativeRole(role) ? "/api/dealer-tags/direct" : "/api/dealer-tags/requests",
        { dealerId, tagId, operation },
      ),
    onSuccess: async () => {
      setTagId("");
      await refreshDealerTags(qc);
    },
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dealer Tags"
        subtitle={
          isAdministrativeRole(role)
            ? "Direct Admin assignment/revocation takes effect immediately."
            : "Request an addition or revocation. Existing markers change only after final approval."
        }
      />
      <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-4">
        <div className="space-y-1">
          <Label>Dealer *</Label>
          <NativeSelect
            dealerOptions
            placeholder="Select a dealer…"
            value={dealerId}
            onChange={(e) => {
              setDealerId(e.target.value);
              setTagId("");
            }}
            options={(dealers.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
        </div>
        <div className="space-y-1">
          <Label>Action *</Label>
          <NativeSelect
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as "ADD" | "REVOKE");
              setTagId("");
            }}
            options={[
              { value: "ADD", label: "Add Tag" },
              { value: "REVOKE", label: "Revoke Tag" },
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label>Tag *</Label>
          <NativeSelect
            placeholder="Select a tag…"
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            options={choices.map((t) => ({
              value: t.id,
              label: `${t.name} (${t.marker})${t.isActive ? "" : " — Inactive"}`,
            }))}
          />
        </div>
        <div className="flex items-end">
          <Button
            disabled={!selected || !choices.some((t) => t.id === tagId) || act.isPending}
            onClick={() => act.mutate()}
          >
            {isAdministrativeRole(role)
              ? operation === "ADD"
                ? "Assign Tag"
                : "Revoke Tag"
              : operation === "ADD"
                ? "Request Tag"
                : "Request Revoke"}
          </Button>
        </div>
      </div>
      {(dealers.error || tags.error || act.error || filtered.error || officers.error) && (
        <p className="text-sm text-destructive">
          {(dealers.error ?? tags.error ?? act.error ?? filtered.error ?? officers.error)?.message}
        </p>
      )}
      {act.isSuccess && (
        <p className="text-sm text-muted-foreground">
          {isAdministrativeRole(role) ? "Dealer tag updated." : "Request submitted for approval."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          placeholder="Search dealers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {officerIds.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setOfficerIds([])}>
            Clear Sales Officer filter ({officerIds.length})
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Dealer</TableHead>
            <SalesOfficerFilterHeader options={officers.data ?? []} selected={officerIds} onChange={setOfficerIds} />
            <TableHead>Status</TableHead>
            <TableHead>Assignments</TableHead>
          </TableRow>
        </TableHeader>
        <DealerTableBody>
          {tableDealers
            .filter((d) => d.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
            .map((d) => (
              <TableRow key={d.id} data-dealer-id={d.id}>
                <TableCell>
                  <DealerName id={d.id} name={d.name} />
                </TableCell>
                <TableCell className="break-words">
                  {d.salesOfficers?.map((o) => o.name).join(", ") || "—"}
                </TableCell>
                <TableCell>{d.isActive ? "Active" : "Inactive"}</TableCell>
                <TableCell>
                  {d.assignedTags
                    .map((t) => `${t.name}${t.isActive ? "" : " (Inactive tag)"}`)
                    .join(", ") || "—"}
                </TableCell>
              </TableRow>
            ))}
        </DealerTableBody>
      </Table>
      <DealerTagRequests />
    </div>
  );
}
