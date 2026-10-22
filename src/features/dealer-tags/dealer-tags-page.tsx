"use client";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { refreshDealerTags } from "./refresh";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useLabel, Th } from "@/features/labels/label-ui";
import { taggedDealersFirst } from "@/lib/dealer-tags";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DealerName, useDealerMarkers } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { Table, TableHeader, TableRow, TableCell } from "@/components/ui/table";
import { DealerTagRequests } from "./dealer-tag-requests";
import { SalesOfficerFilterHeader, type SalesOfficerOption } from "./sales-officer-filter";
import type { TagDefinition, TagDealer } from "./types";
export function DealerTagsPage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const L = {
    dealerPlaceholder: useLabel("dealer_tags.dealer.placeholder"),
    dealerSearch: useLabel("dealer_tags.dealer.search"),
    dealerEmpty: useLabel("dealer_tags.dealer.empty"),
    crumb: useLabel("dealer_tags.crumb.dealer_tags"),
    title: useLabel("dealer_tags.page.title"),
    subtitleAdmin: useLabel("dealer_tags.page.subtitle_admin"),
    subtitleUser: useLabel("dealer_tags.page.subtitle_user"),
    fieldDealer: useLabel("dealer_tags.field.dealer"),
    fieldAction: useLabel("dealer_tags.field.action"),
    fieldTag: useLabel("dealer_tags.field.tag"),
    addTag: useLabel("dealer_tags.action.add_tag"),
    revokeTag: useLabel("dealer_tags.action.revoke_tag"),
    tagPlaceholder: useLabel("dealer_tags.tag.placeholder"),
    inactiveSuffix: useLabel("dealer_tags.tag.inactive_suffix"),
    inactiveAssigned: useLabel("dealer_tags.tag.inactive_assigned"),
    assign: useLabel("dealer_tags.button.assign"),
    revoke: useLabel("dealer_tags.button.revoke"),
    request: useLabel("dealer_tags.button.request"),
    requestRevoke: useLabel("dealer_tags.button.request_revoke"),
    updated: useLabel("dealer_tags.msg.updated"),
    submitted: useLabel("dealer_tags.msg.submitted"),
    searchPlaceholder: useLabel("dealer_tags.search.placeholder"),
    clearFilter: useLabel("dealer_tags.filter.clear"),
    active: useLabel("dealer_tags.status.active"),
    inactive: useLabel("dealer_tags.status.inactive"),
  };
  const markers = useDealerMarkers();
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
        title={L.title}
        crumbs={[{ label: L.crumb }]}
        showBack={false}
        subtitle={isAdministrativeRole(role) ? L.subtitleAdmin : L.subtitleUser}
      />
      <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-4">
        <div className="space-y-1">
          <Label>{L.fieldDealer}</Label>
          {/* Searchable over the FULL authorized dealer list (never just the table page). The submitted value stays the dealer's id. */}
          <SearchableSelect
            ariaLabel={L.dealerSearch}
            placeholder={L.dealerPlaceholder}
            emptyText={L.dealerEmpty}
            value={dealerId}
            onChange={(value) => {
              setDealerId(value);
              setTagId("");
            }}
            options={taggedDealersFirst((dealers.data ?? []).map((d) => ({ value: d.id, label: d.name })), (o) => o.value, markers)}
          />
        </div>
        <div className="space-y-1">
          <Label>{L.fieldAction}</Label>
          <NativeSelect
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as "ADD" | "REVOKE");
              setTagId("");
            }}
            options={[
              { value: "ADD", label: L.addTag },
              { value: "REVOKE", label: L.revokeTag },
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label>{L.fieldTag}</Label>
          <NativeSelect
            placeholder={L.tagPlaceholder}
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            options={choices.map((t) => ({
              value: t.id,
              label: `${t.name} (${t.marker})${t.isActive ? "" : L.inactiveSuffix}`,
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
                ? L.assign
                : L.revoke
              : operation === "ADD"
                ? L.request
                : L.requestRevoke}
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
          {isAdministrativeRole(role) ? L.updated : L.submitted}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          placeholder={L.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {officerIds.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setOfficerIds([])}>
            {L.clearFilter.replace("{count}", String(officerIds.length))}
          </Button>
        )}
      </div>
      <Table numbered>
        <TableHeader>
          <TableRow>
            <Th labelKey="dealer_tags.col.dealer" />
            <SalesOfficerFilterHeader options={officers.data ?? []} selected={officerIds} onChange={setOfficerIds} />
            <Th labelKey="dealer_tags.col.status" />
            <Th labelKey="dealer_tags.col.assignments" />
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
                <TableCell>{d.isActive ? L.active : L.inactive}</TableCell>
                <TableCell>
                  {d.assignedTags
                    .map((t) => `${t.name}${t.isActive ? "" : L.inactiveAssigned}`)
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
