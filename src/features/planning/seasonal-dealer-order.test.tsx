/** Real provider + picker + summary: missing global metadata must never hide the plan's approved tags. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import type { PlanDetail } from "./types";
import type { DealerMarkerMap } from "@/lib/dealer-tags";

const legal = { id: "legal", name: "Legal", marker: "Legal", markerType: "TEXT" as const };
const priority = { id: "priority", name: "Priority", marker: "P", markerType: "TEXT" as const };
const tags: DealerMarkerMap = { legalA: [legal], legalZ: [legal, priority], other: [priority] };
const aliases: Record<string, string> = { alias: "Aaron Alias" };
const dealers = [["legalZ", "Zulu Legal"], ["bravo", "bravo"], ["other", "Charlie"], ["legalA", "Alpha Legal"], ["alias", "Zulu Original"], ["alpha", "Alpha"]].map(([dealerId, dealerName], i) => ({
  planDealerId: `pd-${dealerId}`, dealerId, dealerName, dealerActive: true, noPlan: false, noPlanReason: null,
  lines: [{ planLineId: `line-${dealerId}`, productId: "p", productName: "Product", technicalName: null, productActive: true, rate: 10, nbvPercent: 10, inputMode: null, inputValue: null, packs: { pack: 100 - i }, liveMonthlyQty: 0, actualQty: 0, actualAmount: 0 }],
}));
const detail: PlanDetail = { id: "plan", seasonId: "season", seasonName: "Rabi 2026", seasonOpen: true, officerId: "so", officerName: "SO", version: 1, status: "DRAFT", isActiveVersion: true, revisionRequested: false, revisionReason: null, lastSavedAt: "2026-10-18", canEdit: true, seasonalMode: "PACK_SIZE", planningType: "SEASONAL", versionName: null, description: null, source: "MANUAL", packSizes: [{ id: "pack", name: "1L" }], dealers, dealerTags: tags };
const before = JSON.stringify(detail);
let globalData: { overrides: Record<string, string>; tags: DealerMarkerMap } | undefined;
const empty = () => null;
const load = testLoader({
  "@/lib/api-client": { api: {} },
  "@tanstack/react-query": { useQuery: () => ({ data: globalData }), useQueryClient: () => ({ invalidateQueries: async () => {} }), useMutation: () => ({}) },
  "@/lib/use-categories": { useCategories: () => [] },
  "./use-autosave-map": { useAutosaveMap: (seed: unknown) => ({ values: seed, saving: false, update: () => {}, flush: async () => {} }) },
  "@/features/labels/label-ui": { useLabel: (k: string) => k, Th: ({ labelKey, ...props }: { labelKey: string }) => <th {...props}>{labelKey}</th>, LabelSectionHeaderRow: empty },
  "./admin-edit-ui": { AdminEditBar: empty, EditPlanButton: empty, ChangeReviewDialog: empty },
  "./dealer-completion": { DealerProgressBar: empty, NoPlanDialog: empty, dealerStatusOf: () => "REMAINING" },
  "./seasonal-monthly-view": { SeasonalMonthlyView: ({ seasonalTable }: { seasonalTable: React.ReactNode }) => seasonalTable },
  "./plan-grid-month-view": { PlanGridMonthView: empty },
});
const { DealerNameProvider } = load<typeof import("@/features/dealers/dealer-name-ui")>("src/features/dealers/dealer-name-ui.tsx");
const { PlanEditProvider } = load<typeof import("./plan-edit-context")>("src/features/planning/plan-edit-context.tsx");
const { PlanGrid } = load<typeof import("./plan-grid")>("src/features/planning/plan-grid.tsx");
const { DealerSummaryView } = load<typeof import("./dealer-summary-view")>("src/features/planning/dealer-summary-view.tsx");
const render = (component: React.ReactNode, plan = detail) => renderToStaticMarkup(<DealerNameProvider><PlanEditProvider detail={plan}>{component}</PlanEditProvider></DealerNameProvider>);
const ids = (html: string) => [...html.matchAll(/data-dealer-id="([^"]+)"/g)].map((m) => m[1]);
for (const data of [undefined, { overrides: aliases, tags: {} }, { overrides: aliases, tags }]) {
  globalData = data;
  const expected = data ? ["alias", "alpha", "bravo", "other", "legalA", "legalZ"] : ["alpha", "bravo", "other", "alias", "legalA", "legalZ"];
  const picker = render(<PlanGrid />), summary = render(<DealerSummaryView />);
  assert.deepEqual(ids(picker), expected);
  assert.deepEqual(ids(summary), expected);
  assert.equal((picker.match(/\[Legal\]/g) ?? []).length, 2, "Legal labels survive an absent/empty global response");
  assert.equal((summary.match(/aria-label="Legal"/g) ?? []).length, 2, "Legal badges remain in the summary");
  assert.ok(picker.includes("[Legal] [P]"), "all tags remain visible on a multiply tagged dealer");
}
const revoked = { ...detail, dealerTags: { legalZ: [legal, priority], other: [priority] } };
assert.equal((render(<PlanGrid />, revoked).match(/\[Legal\]/g) ?? []).length, 1, "refreshed plan metadata removes only a genuinely revoked marker");
assert.equal(JSON.stringify(detail), before, "sorting/rendering must never mutate tags or plan data");
console.log("seasonal-dealer-order.test.tsx — real plan provider, visible Legal tags, matching alphabetical groups, missing metadata, aliases and refresh passed");

async function serverMetadata() {
  let scoped = false, markerReads = 0;
  const server = testLoader({
    "@/lib/prisma": { prisma: {
      seasonPlan: { findUnique: async () => ({ ...detail, season: { name: "Rabi", year: 2026, status: "OPEN", seasonalMode: "PACK_SIZE" }, officer: { name: "SO", groupId: "g" }, dealers: dealers.map((d) => ({ ...d, id: d.planDealerId, dealer: { name: d.dealerName, isActive: true }, lines: [] })) }) },
      packSize: { findMany: async () => [] },
      dealerTagAssignment: { findMany: async ({ where }: { where: { isActive: boolean; tag: { isActive: boolean }; dealerId: { in: string[] } } }) => {
        assert.ok(scoped, "plan access must be checked before tag metadata is loaded");
        assert.equal(where.isActive, true); assert.equal(where.tag.isActive, true);
        assert.deepEqual([...where.dealerId.in].sort(), dealers.map((d) => d.dealerId).sort());
        markerReads++;
        return Object.entries(tags).flatMap(([dealerId, entries]) => entries.map((tag) => ({ dealerId, tag })));
      } },
    } },
    "@/lib/http": { ApiError: Error },
    "@/lib/api-client": { api: {} },
    "@/lib/scope": { assertOfficerInScope: async () => { scoped = true; }, isPlanOwner: () => true },
    "@/features/users/catalogue.server": { clearanceMapForGroup: async () => new Map() },
    "@/features/products/merge.server": { loadEffectiveProduct: async () => ({ effId: (id: string) => id, meta: () => null }) },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    "@/features/seasons/service.server": {}, "@/features/notifications/service.server": {}, "./monthly.server": {},
  })<typeof import("./service.server")>("src/features/planning/service.server.ts");
  const plan = await server.getPlanDetail({ userId: "so", username: "so", role: "SALES_OFFICER", groupId: "g" }, "plan");
  assert.equal(markerReads, 1, "tags are batched once for all plan dealers");
  assert.deepEqual(JSON.parse(JSON.stringify(plan.dealerTags)), tags);
  console.log("seasonal plan response — approved tags are included after authorization in one batched read");
}
serverMetadata().catch((error) => { console.error(error); process.exit(1); });
