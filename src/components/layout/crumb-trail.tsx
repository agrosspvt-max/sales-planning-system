"use client";

import { Fragment } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ProfileOrigin } from "@/features/navigation/profile-context";

export interface Crumb {
  label: string;
  href?: string;
}

/** Renders an explicit breadcrumb trail (reused by profile pages and context-launched pages). */
export function CrumbTrail({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={`${c.label}-${i}`}>
            {last || !c.href ? (
              <span className={last ? "font-medium text-foreground" : ""}>{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-foreground">
                {c.label}
              </Link>
            )}
            {!last && <ChevronRight className="h-3.5 w-3.5" />}
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Build the breadcrumb trail for a page reached from a profile:
 *   Masters > Users|Dealers > <Name> > <Current Page>
 * Derived entirely from the origin, so every child page shows a consistent hierarchy.
 */
export function buildProfileCrumbs(origin: ProfileOrigin): Crumb[] {
  const segs = origin.href.split("/").filter(Boolean); // ["masters","users","<id>"]
  const resource = segs[1] ?? "users";
  const resourceLabel = resource === "dealers" ? "Dealers" : resource === "users" ? "Users" : resource;
  const crumbs: Crumb[] = [
    { label: "Masters" },
    { label: resourceLabel, href: `/masters/${resource}` },
    { label: origin.label, href: origin.href },
  ];
  if (origin.pageLabel) crumbs.push({ label: origin.pageLabel });
  return crumbs;
}
