import Link from "next/link";
import { UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { isPartyPlanningEnabled } from "@/lib/feature-flags";

/** What a Party Planning page shows while PARTY_PLANNING_ENABLED is off. No data is touched; the module returns when the flag is turned back on. */
export function PartyPlanningUnavailable() {
  return (
    <div className="space-y-6">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Party Planning" }]} title="Party Planning" subtitle="This module is temporarily unavailable." />
      <Card className="opacity-80">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><UsersRound className="h-5 w-5 text-primary" /> Party Planning</CardTitle>
          <Badge variant="muted">Temporarily unavailable</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Party Planning has been switched off for now. Your plans and records are safe and unchanged; it will be available again soon.</p>
          <Button asChild variant="outline"><Link href="/planning/create">Back to Create / View Plans</Link></Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** Page-level guard (defence in depth next to the middleware): the unavailable page when the flag is off, else null. */
export function partyPlanningGate(): React.ReactNode | null {
  return isPartyPlanningEnabled() ? null : <PartyPlanningUnavailable />;
}
