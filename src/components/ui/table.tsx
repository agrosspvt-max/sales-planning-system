import * as React from "react";
import { cn } from "@/lib/utils";

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
  }
>(({ className, stickyFirstColumn, stickyHeader, ...props }, ref) => (
  <div className={cn("relative w-full overflow-auto", stickyHeader && "h-full min-h-0 flex-1")}>
    <table
      ref={ref}
      className={cn(
        "w-full caption-bottom text-sm",
        stickyFirstColumn && "sticky-first-col",
        stickyHeader && "sticky-head",
        className,
      )}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b bg-muted/40", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("border-b transition-colors hover:bg-muted/50", className)}
      {...props}
    />
  ),
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
