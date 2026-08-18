"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Users2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Group { id: string; name: string; description: string | null; memberCount: number }

/** Products → State Catalogue: pick a state/group, then open that state's catalogue (same page as Users → Group → State Catalogue). */
export function ProductCatalogueSelect() {
  const { data: groups, isLoading } = useQuery<Group[]>({ queryKey: ["groups"], queryFn: () => api.get<Group[]>("/api/groups") });
  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: "Masters" }, { label: "Products and Catalogues" }, { label: "State Catalogue" }]} title="State Catalogue" subtitle="Select a state/group to manage its product availability and pricing." />
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (groups?.length ?? 0) === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No groups yet.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {groups!.map((g) => (
            <Link key={g.id} href={`/groups/${g.id}/catalogue`}>
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/40">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Users2 className="h-4 w-4 text-primary" /> {g.name}</CardTitle>
                  <Badge variant="secondary">{g.memberCount}</Badge>
                </CardHeader>
                <CardContent><p className="text-xs text-muted-foreground">Open {g.name} State Catalogue</p></CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
