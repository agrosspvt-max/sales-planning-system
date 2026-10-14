import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The "RM" capsule: ONE look for a Regional Manager everywhere (Users page, Performance RM Rating column). Informational only —
 * a plain span, never a button. `label` lets a caller supply the wording from the label system; the default matches the Users page.
 */
export function RmBadge({ label = "RM", title, className }: { label?: string; title?: string; className?: string }) {
  return <Badge variant="default" className={cn("gap-1", className)} title={title} data-testid="rm-badge"><ShieldCheck className="h-3 w-3" /> {label}</Badge>;
}
