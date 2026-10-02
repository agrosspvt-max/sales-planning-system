"use client";
import * as React from "react";
import { TableBody } from "@/components/ui/table";
import { useDealerMarkers } from "./dealer-name-ui";
import { groupDealerSlots, taggedDealersFirst } from "@/lib/dealer-tags";

/** Opt-in table presentation: only rows explicitly identified as dealers participate. Row event handlers,
 * input indices, totals and financial ranking calculations are already bound before this stable grouping.
 * Expanded row groups move together. Product/scheme/date group headers are never treated as dealers. */
export const DealerTableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ children, ...props }, ref) => {
  const tags = useDealerMarkers();
  const rows = React.Children.toArray(children);
  const getId = (node: React.ReactNode): string | undefined =>
    React.isValidElement<{ "data-dealer-id"?: string }>(node)
      ? node.props["data-dealer-id"]
      : undefined;
  return (
    <TableBody ref={ref} {...props}>
      {groupDealerSlots(rows, getId, tags)}
    </TableBody>
  );
});
DealerTableBody.displayName = "DealerTableBody";

/** Fragment with explicit dealer identity, used to keep a dealer's expanded rows attached. */
export function DealerRowGroup({
  children,
}: {
  children: React.ReactNode;
  "data-dealer-id": string;
}) {
  return <>{children}</>;
}

/** The same grouping for native tables, dealer cards and sidebar dealer lists; emits no wrapper DOM. */
export function DealerOrder({ children }: { children: React.ReactNode }) {
  const tags = useDealerMarkers();
  const getId = (node: React.ReactNode): string | undefined =>
    React.isValidElement<{ "data-dealer-id"?: string }>(node)
      ? node.props["data-dealer-id"]
      : undefined;
  return <>{groupDealerSlots(React.Children.toArray(children), getId, tags)}</>;
}

export function useTaggedDealersFirst() {
  const tags = useDealerMarkers();
  return React.useCallback(
    <T,>(rows: readonly T[], getId: (row: T) => string | null | undefined): T[] =>
      taggedDealersFirst(rows, getId, tags),
    [tags],
  );
}
