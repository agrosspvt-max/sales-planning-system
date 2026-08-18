"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface GroupAvail { groupId: string; groupName: string; price: number; isActive: boolean }
interface Row { productId: string; name: string; masterPrice: number; masterActive: boolean; groups: GroupAvail[] }

/** Master Product view — each product with the groups it's available in (relationship, not columns). */
export function ProductGroupsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<Row[]>({ queryKey: ["product-group-overview"], queryFn: () => api.get<Row[]>("/api/products/group-overview") });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter((r) => r.name.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Products", href: "/masters/products" }, { label: "Group Pricing" }]}
        title="Product — Group Availability & Pricing"
        subtitle="Each Master product and the groups it is available in, with the group price and status."
        actions={<Input className="w-64" placeholder="Search product…" value={search} onChange={(e) => setSearch(e.target.value)} />}
      />
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Master Price</TableHead>
              <TableHead>Available Groups</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={3}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={3} className="py-10 text-center text-muted-foreground">No products.</TableCell></TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    {r.name}
                    {!r.masterActive && <Badge variant="warning" className="ml-2 text-[10px]">Master inactive</Badge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.masterPrice)}</TableCell>
                  <TableCell>
                    {r.groups.length === 0 ? (
                      <span className="text-muted-foreground">Not added to any group</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {r.groups.map((g) => (
                          <span key={g.groupId} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-0.5 text-xs">
                            <span className="font-medium">{g.groupName}</span>
                            <span className="tabular-nums">{formatCurrency(g.price)}</span>
                            <Badge variant={g.isActive ? "success" : "muted"} className="text-[10px]">{g.isActive ? "Active" : "Inactive"}</Badge>
                          </span>
                        ))}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
