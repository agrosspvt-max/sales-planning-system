"use client";

import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { routeParent } from "@/features/navigation/route-parents";
import { useNavHistory } from "@/features/navigation/history";

/**
 * Reusable Back control, wired to the centralized navigation history.
 *
 * Priority: the page the user ACTUALLY came from (nav history) → else a logical parent (explicit
 * `to`, else the route-parent map) → else the browser stack. So Back never jumps to a hardcoded
 * generic destination when real history exists. Pages never encode navigation targets themselves.
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
  const pathname = usePathname();
  const { previous, back } = useNavHistory();
  const parent = to ?? routeParent(pathname) ?? undefined;

  // When real history takes us somewhere other than the logical parent, "Back" is the honest label;
  // otherwise keep the descriptive "Back to …" the caller provided.
  const usingHistory = previous != null && previous !== parent;
  const displayLabel = usingHistory ? "Back" : label;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 h-8 gap-1 px-2 text-muted-foreground", className)}
      onClick={() => back(parent)}
      aria-label="Go back"
    >
      <ArrowLeft className="h-4 w-4" />
      {displayLabel}
    </Button>
  );
}
