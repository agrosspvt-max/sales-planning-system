import type { ReactNode } from "react";
import { ClearanceTag } from "@/components/ui/clearance-tag";
import { CategoryBadge } from "@/components/ui/category-badge";
import { categoryForNbv, type Category } from "@/lib/product-category";

/**
 * Standard product-name cell used across all planning/catalogue tables:
 *  - name turns YELLOW (text-warning) when the product is a clearance product for this group/state,
 *  - the clearance capsule is kept alongside the name,
 *  - a compact horizontal Category badge (derived from NBV%) sits on the line below,
 *  - `technicalName` (if given) renders as muted sub-text, and `children` allows site-specific extras
 *    (e.g. an "Auto Added" tag or a chevron) to sit next to the name.
 */
export function ProductName({
  name,
  nbvPercent,
  categories,
  isClearance = false,
  clearanceQty = null,
  clearanceRemaining = null,
  state = null,
  technicalName = null,
  children,
}: {
  name: string;
  nbvPercent?: number | null;
  categories: Category[];
  isClearance?: boolean;
  clearanceQty?: number | null;
  clearanceRemaining?: number | null;
  state?: string | null;
  technicalName?: string | null;
  children?: ReactNode;
}) {
  const category = categoryForNbv(nbvPercent, categories);
  return (
    <div>
      <span className="inline-flex flex-wrap items-center gap-x-0.5">
        <span className={isClearance ? "font-medium text-warning" : "font-medium"}>{name}</span>
        {isClearance && <ClearanceTag qty={clearanceQty} remaining={clearanceRemaining} state={state} />}
        {children}
      </span>
      {(category || technicalName) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {category && <CategoryBadge category={category} />}
          {technicalName && <span className="text-xs text-muted-foreground">{technicalName}</span>}
        </div>
      )}
    </div>
  );
}
