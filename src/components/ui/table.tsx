"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const Numbering = React.createContext<{ start: number; label: React.ReactNode } | null>(null);
type CellProps = { children?: React.ReactNode; colSpan?: number };
type RowProps = React.HTMLAttributes<HTMLTableRowElement> & { "data-serial-processed"?: boolean; "data-row-kind"?: string };

/** Pure render-time numbering. Filtering, sorting and pagination cannot leave stale ordinals. */
function numberedRows(children: React.ReactNode, kind: "header" | "body", start: number, label: React.ReactNode): React.ReactNode {
  let next = start;
  const visit = (nodes: React.ReactNode): React.ReactNode => React.Children.map(nodes, (node) => {
    if (!React.isValidElement<RowProps>(node)) return node;
    if (node.type === TableRow || node.type === "tr") {
      const cells = React.Children.toArray(node.props.children);
      const first = cells[0];
      const spanned = React.isValidElement<CellProps>(first) && first.props.colSpan != null;
      const summary = node.props["data-row-kind"] === "summary";
      const numbered = spanned
        ? [React.cloneElement(first, { colSpan: first.props.colSpan! + 1 }), ...cells.slice(1)]
        : [kind === "header"
          ? <TableHead key="serial" scope="col" className="w-14 whitespace-nowrap" data-serial-cell>{label}</TableHead>
          : <TableCell key="serial" className="w-14 whitespace-nowrap tabular-nums text-muted-foreground" data-serial-cell>{summary ? null : next++}</TableCell>, ...cells];
      return React.cloneElement(node, { "data-serial-processed": true }, numbered);
    }
    // Explicit fragments/row groups are traversed; cell contents and nested tables are left alone.
    if (node.type !== Table && node.type !== "table" && node.props.children) return React.cloneElement(node, {}, visit(node.props.children));
    return node;
  });
  return visit(children);
}

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    /**
     * Freeze the first column (Product / Dealer) so it stays visible while the rest of the table
     * scrolls horizontally. Shared behaviour — see `.sticky-first-col` in globals.css. Every planning
     * grid opts in with this one prop; no table markup is duplicated.
     */
    stickyFirstColumn?: boolean;
    /**
     * Keep the column header (`<thead>`) pinned while rows scroll. The table's own wrapper is the
     * single scroll region for the grid: it fills its (flex) parent's height, so the workspace lays
     * this out as `… flex-1 min-h-0` and the wrapper becomes the one place the grid scrolls — the
     * header stays put across every row (products, additional products, the Total footer) down to the
     * very bottom, with no competing outer-page scroll. Header styling lives in `.sticky-head` in
     * globals.css. Combine freely with `stickyFirstColumn`; the frozen corner cell layers above both.
     */
    stickyHeader?: boolean;
    /**
     * Opt-in: an ANCESTOR is the scroll container (both axes), not this wrapper. Used where the whole
     * page section is one scroll region so the surrounding content (e.g. a page header) can scroll away
     * while the table's sticky header/first-column pin against that outer scroller. When set, the wrapper
     * adds NO overflow and NO flex sizing — the `.sticky-head`/`.sticky-first-col` rules then resolve
     * against the nearest scrolling ancestor the caller provides. Default (unset) is unchanged: this
     * wrapper is the single scroll region, exactly as every existing grid relies on.
     */
    externalScroll?: boolean;
    /** Opt in for record lists; existing serial columns and planning matrices are unaffected. */
    numbered?: boolean;
    /** First visible record's ordinal, including any pagination offset. */
    numberStart?: number;
    numberLabel?: React.ReactNode;
  }
>(({ className, stickyFirstColumn, stickyHeader, externalScroll, numbered, numberStart = 1, numberLabel = "S.No", ...props }, ref) => (
  <Numbering.Provider value={numbered ? { start: numberStart, label: numberLabel } : null}>
  <div className={cn("relative w-full", !externalScroll && "overflow-auto", stickyHeader && !externalScroll && "h-full min-h-0 flex-1")}>
    <table
      ref={ref}
      className={cn(
        "w-full caption-bottom text-sm",
        stickyFirstColumn && "sticky-first-col",
        stickyFirstColumn && numbered && "numbered-sticky",
        stickyHeader && "sticky-head",
        className,
      )}
      {...props}
    />
  </div>
  </Numbering.Provider>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, children, ...props }, ref) => {
  const numbering = React.useContext(Numbering);
  return <thead ref={ref} className={cn("[&_tr]:border-b bg-muted/40", className)} {...props}>{numbering ? numberedRows(children, "header", numbering.start, numbering.label) : children}</thead>;
});
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, children, ...props }, ref) => {
  const numbering = React.useContext(Numbering);
  return <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props}>{numbering ? numberedRows(children, "body", numbering.start, numbering.label) : children}</tbody>;
});
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, RowProps>(
  ({ className, children, "data-serial-processed": processed, ...props }, ref) => {
    const numbering = React.useContext(Numbering);
    // Custom loading/empty-row components and footers render after the body walk; align them without counting them.
    if (numbering && !processed) {
      const cells = React.Children.toArray(children);
      const first = cells[0];
      children = React.isValidElement<CellProps>(first) && first.props.colSpan != null
        ? [React.cloneElement(first, { colSpan: first.props.colSpan! + 1 }), ...cells.slice(1)]
        : [<TableCell key="serial-spacer" data-serial-cell />, ...cells];
    }
    return <tr ref={ref} className={cn("border-b transition-colors hover:bg-muted/50", className)} {...props}>{children}</tr>;
  },
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn("px-3 py-2 align-middle", className)} {...props} />
));
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
