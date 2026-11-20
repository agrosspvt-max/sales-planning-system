"use client";

import { cloneElement, useId, useState, type ReactElement } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { partitionProductRows } from "@/lib/product-row-order";

/** Presentation only. Keep the full source dataset for calculations, saving and completion. */
export function ProductRows<T>({ rows, nameOf, idOf, hasValues, columns, scope, children }: {
  rows: readonly T[];
  nameOf: (row: T) => string;
  idOf: (row: T) => string;
  hasValues: (row: T) => boolean;
  columns: number;
  scope: string;
  children: (row: T) => ReactElement;
}) {
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const expanded = expandedScope === scope;
  const controlsId = useId();
  const { active, empty } = partitionProductRows(rows, nameOf, idOf, hasValues);
  // One keyed sibling array preserves an input's focus when an edited zero row moves to the active group.
  const result = active.map(children);
  if (empty.length) {
    result.push(
      <TableRow key="zero-products-toggle" data-row-kind="summary" className="bg-muted/20 hover:bg-muted/20">
        <TableCell colSpan={columns}>
          <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={controlsId}
            onClick={() => setExpandedScope(expanded ? null : scope)}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {expanded ? "Show less" : "Show more"} ({empty.length} zero-value products)
          </Button>
        </TableCell>
      </TableRow>,
    );
    if (expanded) result.push(...empty.map((row, index) => {
      const element = children(row);
      // aria-controls targets the first revealed row; each row retains the caller's stable key.
      return index === 0 ? cloneElement(element as ReactElement<{ id?: string }>, { id: controlsId }) : element;
    }));
  }
  return <>{result}</>;
}
