import Link from "next/link";
import { Gift } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Placeholder shown at /planning/scheme while SCHEME_PLANNING_ENABLED is off. Keeps the route valid (no
 * 404) and blocks access to the not-yet-ready workspace. Set SCHEME_PLANNING_ENABLED=true to restore it.
 */
export function SchemePlanningComingSoon() {
  return (
    <div className="space-y-6">
      <PageHeader crumbs={[{ label: "Planning" }, { label: "Scheme Planning" }]} title="Scheme Planning" subtitle="This module is being finalised and is not yet available." />
      <Card className="opacity-80">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Gift className="h-5 w-5 text-primary" /> Scheme Planning</CardTitle>
          <Badge variant="muted">Coming Soon</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Scheme Planning is temporarily disabled while we finish it for production. It will be available here soon.</p>
          <Button asChild variant="outline"><Link href="/planning/create">Back to Create / View Plans</Link></Button>
        </CardContent>
      </Card>
    </div>
  );
}
