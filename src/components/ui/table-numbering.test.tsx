/** Shared record-list numbering: rendered order, pagination, nested tables, row grouping and spans. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { testLoader } from "@/features/dealer-tags/test-loader";

const header = <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead></TableRow></TableHeader>;
const row = (name: string) => <TableRow key={name} data-record={name}><TableCell>{name}</TableCell><TableCell>{name.length}</TableCell></TableRow>;
const serials = (html: string) => [...html.matchAll(/<td[^>]*data-serial-cell="true"[^>]*>(\d+)<\/td>/g)].map((m) => Number(m[1]));
const list = (names: string[], start = 1) => renderToStaticMarkup(<Table numbered numberStart={start}>{header}<TableBody>{names.map(row)}</TableBody></Table>);
assert.deepEqual(serials(list(["Alpha", "Beta", "Gamma"])), [1, 2, 3]);
assert.deepEqual(serials(list(["Gamma", "Alpha"])), [1, 2], "filtering/sorting restarts ordinals in display order");
assert.deepEqual(serials(list(["Gamma", "Alpha"], 26)), [26, 27], "pagination offset continues numbering");
assert.deepEqual(serials(list(["Alpha"])), [1], "a later render cannot inherit a previous render's counter");
let html = renderToStaticMarkup(<Table>{header}<TableBody>{row("Existing")}</TableBody></Table>);
assert.ok(!html.includes("data-serial-cell") && !html.includes("S.No"), "opt-out tables and existing serial columns stay unchanged");
html = renderToStaticMarkup(<Table numbered>{header}<TableBody>
  <TableRow><TableCell colSpan={2}>Loading</TableCell></TableRow>
  <React.Fragment key="group">{row("Parent")}<TableRow><TableCell colSpan={2}><Table>{header}<TableBody>{row("Child")}</TableBody></Table></TableCell></TableRow></React.Fragment>
  <TableRow data-row-kind="summary"><TableCell>Total</TableCell><TableCell>5</TableCell></TableRow>
  {row("Second")}
</TableBody><tfoot><TableRow><TableCell colSpan={2}>Footer</TableCell></TableRow></tfoot></Table>);
assert.deepEqual(serials(html), [1, 2], "expanded rows, summaries, footers and nested opt-out tables consume no number");
assert.equal((html.match(/colSpan="3"/gi) ?? []).length, 3, "loading, expanded and footer spans include the new column");
const CustomEmpty = () => <TableRow><TableCell colSpan={1}>Empty</TableCell></TableRow>;
html = renderToStaticMarkup(<Table numbered><TableHeader><TableRow><TableHead>Name</TableHead></TableRow></TableHeader><TableBody><CustomEmpty /></TableBody></Table>);
assert.ok(html.includes('colSpan="2"') && serials(html).length === 0, "custom empty rows and single-column spans remain aligned");
html = renderToStaticMarkup(<Table numbered>{header}<TableBody><TableRow><TableCell colSpan={2}><Table numbered>{header}<TableBody>{row("Child")}</TableBody></Table></TableCell></TableRow>{row("Outer")}</TableBody></Table>);
assert.deepEqual(serials(html), [1, 1], "nested numbered lists each start independently");

// Dealer ordering happens before shared numbering: the visible first row must still be 1 after tag grouping.
const { DealerTableBody } = testLoader({
  "@/components/ui/table": { TableBody },
  "./dealer-name-ui": { useDealerMarkers: () => ({}) },
  "@/lib/dealer-tags": { groupDealerSlots: (rows: React.ReactNode[]) => [...rows].reverse() },
})<typeof import("@/features/dealers/dealer-table-ui")>("src/features/dealers/dealer-table-ui.tsx");
html = renderToStaticMarkup(<Table numbered>{header}<DealerTableBody>{row("Alpha")}{row("Beta")}</DealerTableBody></Table>);
assert.deepEqual(serials(html), [1, 2]);
assert.ok(html.indexOf('data-record="Beta"') < html.indexOf('data-record="Alpha"'), "numbering uses the reordered dealer rows");
console.log("table-numbering.test.tsx — order, pages, grouping, nested tables, totals and spans passed");
