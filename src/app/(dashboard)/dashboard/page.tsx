import Link from "next/link";
import { auth } from "@/auth";
import { requireAuth } from "@/lib/http";
import { ROLE_LABELS } from "@/lib/rbac";
import { PageHeader } from "@/components/layout/page-header";
import { getDashboard } from "@/features/dashboard/service.server";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DraftPlans } from "@/components/dashboard/draft-plans";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RankRow } from "@/features/reports/types";

export default async function DashboardPage() {
  const session = await auth();
  // requireAuth resolves the full context (incl. groupId) from the DB — needed for RM group scoping.
  const ctx = await requireAuth();
  const data = await getDashboard(ctx);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${session!.user.name}`}
        subtitle={
          <>
            {ROLE_LABELS[ctx.role]}
            {data.seasonName ? ` · ${data.seasonName}` : ""}
          </>
        }
        showBreadcrumbs={false}
      />

      {/* Work dashboard: Quick Actions + in-progress drafts replace the KPI summary. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <QuickActionCard
          title="Create New Plan"
          description="Create Seasonal or Monthly plans and continue planning."
          buttonLabel="Create Plan"
          href="/planning/sales"
          primary
        />
        <QuickActionCard
          title="View Approved Plans"
          description="Browse approved Seasonal and Monthly plans."
          buttonLabel="View Plans"
          href="/planning/sales/plans"
        />
      </div>

      <DraftPlans role={ctx.role} />

      {data.seasonName === null ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No seasons exist yet. Ask an administrator to create a season to begin planning.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {data.topProducts && <RankTable title="Top Products" rows={data.topProducts} />}
          {data.topDealers && <RankTable title="Top Dealers" rows={data.topDealers} />}
          {data.lowestDealers && (
            <RankTable title="Lowest Performing Dealers" rows={data.lowestDealers} showAchievement />
          )}
        </div>
      )}
    </div>
  );
}

function QuickActionCard({
  title,
  description,
  buttonLabel,
  href,
  primary,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  href: string;
  primary?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 pt-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="mt-auto">
          <Button asChild variant={primary ? "default" : "outline"}>
            <Link href={href}>{buttonLabel}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RankTable({
  title,
  rows,
  showAchievement,
}: {
  title: string;
  rows: RankRow[];
  showAchievement?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-background">
      <div className="border-b px-4 py-2 text-sm font-semibold">{title}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">{showAchievement ? "Achv %" : "Plan"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                No data.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right">{formatCurrency(r.actualAmount)}</TableCell>
                <TableCell className="text-right">
                  {showAchievement ? formatPercent(r.achievementAmount) : formatCurrency(r.planAmount)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
