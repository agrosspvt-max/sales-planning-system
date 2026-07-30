"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export interface QuickActionVM {
  label: string;
  href: string;
  variant?: "default" | "outline";
  external?: boolean;
  disabled?: boolean;
}

/** Reusable Quick Actions row for any profile (Officer, Dealer, RM, …). */
export function QuickActions({ actions }: { actions: QuickActionVM[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => {
        const variant = a.variant ?? "outline";
        if (a.disabled) {
          return (
            <Button key={a.label} size="sm" variant={variant} disabled>
              {a.label}
            </Button>
          );
        }
        if (a.external) {
          return (
            <Button key={a.label} size="sm" variant={variant} asChild>
              <a href={a.href}>{a.label}</a>
            </Button>
          );
        }
        return (
          <Button key={a.label} size="sm" variant={variant} asChild>
            <Link href={a.href}>{a.label}</Link>
          </Button>
        );
      })}
    </div>
  );
}
