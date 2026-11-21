import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import type { SalesPlanBinRow } from "./sales-plan-bin.types";

const row: SalesPlanBinRow = { id: "old-month", kind: "MONTHLY", planType: "Monthly", seasonName: "Kharif 2026", monthName: "August", officerName: "Manoj Singh", version: 1, status: "RETURNED", openHref: "/planning/monthly/old-month", deactivatedAt: "2026-08-06T10:00:00Z", inherited: true, parentPlanId: "old-season", reason: "Deactivated with seasonal plan v1. Archived when a replacement plan was imported.", actor: "Administrator", auditSummary: "Archived before a fresh re-import" };
let stateIndex = 0;
let state: unknown[] = [true, "", "", null, ""];
let permitted = true;
let contextError = false;
const Wrapper = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const original = React.useState(initial); const i = stateIndex++; return i < state.length ? [state[i], original[1]] : original; } },
  "next/link": { __esModule: true, default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> },
  "@/lib/api-client": { api: {} },
  "@/features/accounts/permission-ui": { useAdminPermission: () => permitted },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[0] === "sales-plan-bin" ? { data: [row], isPending: false } : { data: { parentVersion: 1, needsParent: true, activeVersions: [{ id: "new-season", version: 2 }] }, isPending: false, isFetching: false, isError: contextError, error: new Error("Plan changed") },
    useMutation: () => ({ reset: () => {}, isPending: false }),
    useQueryClient: () => ({}),
  },
  "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section>{children}</section> : null, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper, DialogDescription: Wrapper, DialogFooter: Wrapper },
  "@/components/ui/dropdown-menu": { DropdownMenu: Wrapper, DropdownMenuContent: Wrapper, DropdownMenuItem: Wrapper, DropdownMenuTrigger: Wrapper },
});
const { SalesPlanBin } = load<typeof import("./sales-plan-bin")>("src/features/planning/sales-plan-bin.tsx");
const render = (role: Role = Role.SUPER_ADMIN) => { stateIndex = 0; return renderToStaticMarkup(<SalesPlanBin role={role} />); };
let html = render();
assert(html.includes("Bin") && html.includes("Manoj Singh") && html.includes("View Info") && html.includes("Recover Plan"));
assert(html.includes('href="/planning/monthly/old-month"') && html.includes("Actions for Manoj Singh"));
state[3] = { row, action: "info" };
html = render();
assert(html.includes("Administrator") && html.includes("Archived before a fresh re-import") && html.includes('href="/planning/old-season"'));
state[3] = { row, action: "recover" };
html = render();
assert(html.includes("Archive Active &amp; Recover") && html.includes("Recover as History") && html.includes("v2") && html.includes("All saved values are preserved"));
contextError = true;
html = render();
assert(html.includes("Plan changed") && !html.includes("Archive Active &amp; Recover"), "a failed context lookup cannot offer recovery");
contextError = false;
state = [true, "unknown officer", "", null, ""];
assert(render().includes("No plans match these filters."));
state = [true, "", "", null, ""];
assert(!render(Role.REGIONAL_MANAGER).includes("Recover Plan"), "RMs can reference archives but cannot recover");
permitted = false;
assert(!render(Role.CUSTOM_ADMIN).includes("Recover Plan"), "custom admin lifecycle permission is respected");
console.log("sales-plan-bin.test.tsx — menus, info, conflict choices, query errors, filtering and role controls passed");
