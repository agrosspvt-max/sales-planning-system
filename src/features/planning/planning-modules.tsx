"use client";

import Link from "next/link";
import { ShoppingCart, Wallet, Gift, UsersRound, ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

export type PlanningWorkspaceMode = "create" | "view";

interface Module {
  key: string;
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
  available: boolean;
}

/**
 * The landing for both primary planning workspaces — Create Plan (work-in-progress) and
 * View Plans (approved). It lists the planning MODULES (Sales, Recovery, Scheme, Party);
 * only Sales Planning is functional. Recovery/Scheme/Party render as Coming Soon here
 * instead of being separate sidebar items. The Sales card routes into the matching side of
 * the existing Sales Planning workspace, reusing all existing screens.
 */
export function PlanningModules({ mode }: { mode: PlanningWorkspaceMode }) {
  const isCreate = mode === "create";
  const title = isCreate ? "Create New Plan" : "View Approved Plans";
  const subtitle = isCreate
    ? "Start or continue a plan. Only work-in-progress (Draft) plans live here."
    : "Browse finalised planning. Only Approved plans are shown here.";
  // Sales & Recovery reuse the existing screens; the workspace mode selects create vs browse.
  const salesHref = isCreate ? "/planning/sales" : "/planning/sales/plans";
  const recoveryHref = isCreate ? "/planning/recovery" : "/planning/recovery/plans";

  const modules: Module[] = [
    {
      key: "sales",
      label: "Sales Planning",
      href: salesHref,
      description: "Seasonal, Monthly and Yearly sales plans — dealer-first, with approvals and reports.",
      icon: ShoppingCart,
      available: true,
    },
    { key: "recovery", label: "Recovery Planning", href: recoveryHref, description: "Plan and track outstanding recovery from the Aging Report.", icon: Wallet, available: true },
    { key: "scheme", label: "Scheme Planning", href: "/planning/scheme", description: "Design and plan dealer/product schemes.", icon: Gift, available: false },
    { key: "party", label: "Party Planning", href: "/planning/party", description: "Plan party-wise targets and engagement.", icon: UsersRound, available: false },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: title }]}
        title={title}
        subtitle={subtitle}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {modules.map((m) => {
          const Icon = m.icon;
          const inner = (
            <Card
              className={cn(
                "h-full transition-colors",
                m.available ? "hover:border-primary/50 hover:bg-accent/40" : "opacity-70",
              )}
            >
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="h-5 w-5 text-primary" />
                  {m.label}
                </CardTitle>
                {m.available ? (
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Badge variant="muted">Coming Soon</Badge>
                )}
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{m.description}</p>
              </CardContent>
            </Card>
          );
          return m.available ? (
            <Link key={m.key} href={m.href} className="block">
              {inner}
            </Link>
          ) : (
            <div key={m.key}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}
