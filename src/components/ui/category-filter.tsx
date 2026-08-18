"use client";

import { NativeSelect } from "@/components/ui/select";
import { UNCATEGORIZED, type Category } from "@/lib/product-category";

/**
 * Reusable Category filter dropdown. Value "" = All Categories, UNCATEGORIZED = products matching no
 * category, otherwise a category id. Filtering is display-only — pair with `matchesCategoryFilter`.
 */
export function CategoryFilter({
  categories,
  value,
  onChange,
  className = "w-44",
}: {
  categories: Category[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const options = [
    { value: "", label: "All Categories" },
    ...categories.map((c) => ({ value: c.id, label: c.notation ? `${c.name} (${c.notation})` : c.name })),
    { value: UNCATEGORIZED, label: "Uncategorized" },
  ];
  return <NativeSelect className={className} options={options} value={value} onChange={(e) => onChange(e.target.value)} />;
}
