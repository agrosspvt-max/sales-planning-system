"use client";
import Link from "next/link";
import { UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { useLabel } from "@/features/labels/label-ui";

/** The "Party Planning is off" screen; every word comes from the Labels system. */
export function PartyPlanningUnavailableView() {
  const L = {
    planning: useLabel("party_planning.crumb.planning"), createView: useLabel("party_planning.crumb.create_view"), title: useLabel("party_planning.title"),
    subtitle: useLabel("party_planning.unavailable.subtitle"), badge: useLabel("party_planning.unavailable.badge"), message: useLabel("party_planning.unavailable.message"), back: useLabel("party_planning.unavailable.back"),
  };
  return (
    <div className="space-y-6">
      <PageHeader crumbs={[{ label: L.planning }, { label: L.createView, href: "/planning/create" }, { label: L.title }]} title={L.title} subtitle={L.subtitle} />
      <Card className="opacity-80">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><UsersRound className="h-5 w-5 text-primary" /> {L.title}</CardTitle>
          <Badge variant="muted">{L.badge}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{L.message}</p>
          <Button asChild variant="outline"><Link href="/planning/create">{L.back}</Link></Button>
        </CardContent>
      </Card>
    </div>
  );
}
