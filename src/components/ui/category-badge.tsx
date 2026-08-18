import type { Category } from "@/lib/product-category";

/**
 * Small horizontal capsule shown under a product name, e.g. `Premium` in the category color. Uses the
 * category's `color` (hex) for a translucent background + solid text/border; falls back to a neutral grey
 * when no color is set. Display-only — derived from the product's NBV%, never stored per-render.
 */
export function CategoryBadge({ category, className = "" }: { category: Category | null; className?: string }) {
  if (!category) return null;
  const label = category.notation ? `${category.notation} · ${category.name}` : category.name;
  const color = category.color || "#64748b"; // slate-500 fallback
  return (
    <span
      title={category.name}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${className}`}
      style={{ backgroundColor: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {label}
    </span>
  );
}
