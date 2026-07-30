"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Breadcrumbs } from "./breadcrumbs";
import { BackButton } from "./back-button";
import { CrumbTrail, buildProfileCrumbs, type Crumb } from "./crumb-trail";
import { routeParent } from "@/features/navigation/route-parents";
import { readProfileOrigin, profileKindLabel } from "@/features/navigation/profile-context";

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Action buttons (Save, Import, Export, Approve, …), shown top-right. */
  actions?: React.ReactNode;
  /** Explicit logical parent for the Back button. Defaults to the route-parent map. */
  backTo?: string;
  /** Force show/hide the Back button. Defaults to "show when a logical parent exists". */
  showBack?: boolean;
  /** Show the breadcrumb trail. Default true. */
  showBreadcrumbs?: boolean;
  /** Explicit breadcrumb trail (profile pages). Overrides the path-based default. */
  crumbs?: Crumb[];
  className?: string;
  /** Optional secondary toolbar (filters, tabs) that stays sticky with the header. */
  children?: React.ReactNode;
}

/**
 * Reusable sticky page header with centralized navigation resolution.
 *
 * Back + breadcrumbs resolve by priority:
 *   1. explicit `crumbs` prop (a profile page defining its own hierarchy),
 *   2. profile context in the URL (a child page launched FROM a profile),
 *   3. path-based default (route-parent + segment breadcrumbs).
 * This means any page that already renders a PageHeader inherits correct, context-aware
 * Back/breadcrumbs with no per-page code.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  backTo,
  showBack,
  showBreadcrumbs = true,
  crumbs,
  className,
  children,
}: PageHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const origin = readProfileOrigin(searchParams);

  // Resolve breadcrumbs + back target from the priority order above.
  let resolvedCrumbs: Crumb[] | null = null;
  let backHref: string | undefined = backTo;
  let backLabel = "Back";

  if (crumbs && crumbs.length) {
    resolvedCrumbs = crumbs;
    const prev = [...crumbs].reverse().find((c) => c.href);
    backHref = backTo ?? prev?.href;
    backLabel = prev ? `Back to ${prev.label}` : "Back";
  } else if (origin) {
    resolvedCrumbs = buildProfileCrumbs(origin);
    backHref = origin.href;
    backLabel = `Back to ${profileKindLabel(origin.kind)}`;
  }

  const hasParent = resolvedCrumbs != null || backTo != null || routeParent(pathname) != null;
  const back = showBack ?? hasParent;

  return (
    <div
      className={cn(
        "sticky top-0 z-20 -mx-4 -mt-4 mb-4 border-b bg-muted/20 px-4 py-3 backdrop-blur md:-mx-6 md:-mt-6 md:px-6",
        className,
      )}
    >
      {(back || showBreadcrumbs) && (
        <div className="mb-1.5 flex items-center gap-2">
          {back && <BackButton to={backHref} label={backLabel} />}
          {showBreadcrumbs && (resolvedCrumbs ? <CrumbTrail crumbs={resolvedCrumbs} /> : <Breadcrumbs />)}
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
