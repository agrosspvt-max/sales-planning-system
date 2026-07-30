"use client";

import { useRouter, usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { routeParent } from "@/features/navigation/route-parents";

/**
 * Reusable, parent-aware Back control.
 *
 * If a logical parent exists (an explicit `to`, else the central route-parent map) it
 * navigates there; otherwise it uses browser history (`router.back()`). Pages never encode
 * navigation targets themselves.
 */
export function BackButton({
  to,
  label = "Back",
  className,
}: {
  to?: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const parent = to ?? routeParent(pathname);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 h-8 gap-1 px-2 text-muted-foreground", className)}
      onClick={() => (parent ? router.push(parent) : router.back())}
      aria-label="Go back"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Button>
  );
}
