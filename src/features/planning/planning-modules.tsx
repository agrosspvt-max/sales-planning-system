"use client";

import Link from "next/link";
import { ShoppingCart, Wallet, Gift, UsersRound, MapPin, ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { useContext } from "react";
import { PermissionContext } from "@/features/accounts/permission-ui";
import { mayEnterPage } from "@/features/accounts/permissions";

export type PlanningWorkspaceMode = "create" | "view";

interface Module {
  key: string;
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
  available: boolean;
  /** Badge shown on an unavailable card (default "Coming Soon"). */
  unavailableLabel?: string;
}

/**
 * "Create/View Plans" landing — the single Planning entry. It lists the planning MODULES in this order: Territory Mapping, Party
 * Planning, Sales, Recovery, Scheme. Each opens its own workspace; Scheme is gated behind SCHEME_PLANNING_ENABLED. While
 * PARTY_PLANNING_ENABLED is off the Party Planning card stays visible but disabled ("Temporarily Disabled", not a link); the server blocks
 * its pages and APIs regardless of this card.
 * The optional `mode` is kept only for backward-compatible deep links and no longer changes the landing.
 */
export function PlanningModules({ mode, schemePlanningEnabled = false, partyPlanningEnabled = false }: { mode?: PlanningWorkspaceMode; schemePlanningEnabled?: boolean; partyPlanningEnabled?: boolean }) {
  const identity = useContext(PermissionContext);
  void mode;
  const modules: Module[] = [
    { key: "territory", label: "Territory Mapping", href: "/planning/territory-mapping", description: "Map every existing dealer to its Market and District, and request new Markets for approval.", icon: MapPin, available: true },
    // Party Planning stays listed when PARTY_PLANNING_ENABLED is off — as a disabled, non-navigating card.
    { key: "party", label: "Party Planning", href: "/planning/party/seasonal", description: "Plan party visits and appointments, then submit them for admin approval.", icon: UsersRound, available: partyPlanningEnabled, unavailableLabel: "Temporarily Disabled" },
    {
      key: "sales",
      label: "Sales Planning",
      href: "/planning/sales",
      description: "Seasonal, Monthly and Yearly sales plans — dealer-first, with approvals and reports.",
      icon: ShoppingCart,
      available: true,
    },
    { key: "recovery", label: "Recovery Planning", href: "/planning/recovery", description: "Plan and track outstanding recovery from the Aging Report.", icon: Wallet, available: true },
    // Scheme Planning is gated behind SCHEME_PLANNING_ENABLED — shown as "Coming Soon" (disabled) until ready.
    { key: "scheme", label: "Scheme Planning", href: "/planning/scheme", description: "Plan dealers into schemes, get RM approval, and verify enrollment.", icon: Gift, available: schemePlanningEnabled },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans" }]}
        title="Create / View Plans"
        subtitle="Choose a planning module. Each module lets you create new plans or view submitted, approved and historical plans."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {modules.filter(m => mayEnterPage(identity, m.href)).map((m) => {
          const Icon = m.icon;
          const inner = (
            <Card
              className={cn(
                "h-full transition-colors",
                m.available ? "hover:border-primary/50 hover:bg-accent/40" : m.unavailableLabel ? "opacity-60" : "opacity-70",
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
                  <Badge variant="muted">{m.unavailableLabel ?? "Coming Soon"}</Badge>
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
            <div key={m.key} {...(m.unavailableLabel ? { "aria-disabled": true, title: `${m.label} is ${m.unavailableLabel.toLowerCase()}`, className: "cursor-not-allowed select-none" } : {})}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}
