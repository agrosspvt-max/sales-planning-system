/** RM Performance consolidation: one sidebar entry, old route redirects, the RM capsule in RM Rating (by the ROW's role), no change for Sales Officer rows. No DB / browser. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { navForRole } from "@/features/navigation/nav";

const { RmBadge } = testLoader({})("src/components/ui/rm-badge.tsx") as { RmBadge: React.ComponentType<{ label?: string; className?: string }> };

// 1) Sidebar: an RM has exactly ONE Performance entry (under Insights); nobody has a Team Performance entry.
for (const role of [Role.REGIONAL_MANAGER, Role.SALES_OFFICER, Role.SUPER_ADMIN, Role.CUSTOM_ADMIN]) {
  const items = navForRole(role, true, undefined, false).flatMap((i) => i.children ?? [i]);
  assert.ok(!items.some((i) => i.href === "/team-performance" || /team performance/i.test(i.label)), `${role}: no Team Performance item`);
}
const rmItems = navForRole(Role.REGIONAL_MANAGER).flatMap((i) => i.children ?? [i]).filter((i) => /performance/i.test(i.label) || /performance/.test(i.href));
assert.deepEqual(rmItems.map((i) => [i.label, i.href, i.group]), [["Performance", "/performance", "Insights"]], "RM: one Performance entry, under Insights");

// 2) The old route redirects to the retained page (bookmarks keep working), for every role.
const redirects: string[] = [];
const route = testLoader({ "next/navigation": { redirect: (to: string) => { redirects.push(to); } } })("src/app/(dashboard)/team-performance/page.tsx") as { default: () => void };
route.default();
assert.deepEqual(redirects, ["/performance"]);
assert.ok(!/auth\(|Forbidden/.test(readFileSync("src/app/(dashboard)/team-performance/page.tsx", "utf8")), "the redirect does not depend on the viewer's role");

// 3) The RM capsule is the Users page's badge: same component, same classes; informational (a span, not a button).
const users = readFileSync("src/features/users/user-table.tsx", "utf8");
assert.ok(users.includes('<RmBadge className="ml-2" />') && users.includes('@/components/ui/rm-badge'), "the Users page uses the shared badge");
const badge = renderToStaticMarkup(<RmBadge className="ml-2" />);
assert.ok(badge.startsWith("<span") && !/<button|onclick|href/i.test(badge) && badge.includes("bg-primary") && badge.includes("rounded-full") && badge.includes("gap-1 ml-2") && /RM<\/span>$/.test(badge), "blue capsule, not interactive");
assert.ok(renderToStaticMarkup(<RmBadge label="Reg. Mgr" />).includes("Reg. Mgr"), "wording can come from the label system");

// 4) The Performance table: the capsule is decided by the role of the row's person, for an RM viewer and an admin viewer alike.
let payload: unknown;
const overrides: Record<string, unknown> = {
  "@/features/labels/label-ui": { useLabel: (key: LabelKey) => DEFAULT_LABELS[key], Th: ({ labelKey }: { labelKey: LabelKey }) => <th>{DEFAULT_LABELS[labelKey]}</th> },
  "@/features/tasks/task-analysis-view": { TaskAnalysisView: () => null }, // own suite: tasks/task-analysis-ui.test.tsx
  "@/lib/api-client": { api: { get: async () => payload } },
  "@tanstack/react-query": { useQuery: () => ({ isLoading: false, isFetching: false, data: payload }), useQueryClient: () => ({ invalidateQueries: () => {} }), useMutation: () => ({ isPending: false, mutate: () => {} }) },
  "@/components/layout/page-header": { PageHeader: ({ title, crumbs }: { title: string; crumbs: { label: string }[] }) => <h1 data-crumbs={crumbs.map((c) => c.label).join(">")}>{title}</h1> },
  "./team-performance-page": { DailyWorkReviewDialog: () => null },
};
const { PerformancePage } = testLoader(overrides)("src/features/daily-work/performance-page.tsx") as { PerformancePage: React.ComponentType<{ role: Role }> };
const sections = Object.fromEntries(["sales", "recovery", "schemeConversion", "appointment", "visits"].map((k) => [k, { planned: 0, actual: 0 }]));
const row = (id: string, name: string, officerRole: Role, rmRating: number | null) => ({ officerId: id, officerName: name, officerRole, groupId: "g1", stateName: "MP", date: "2026-09-28", planSubmittedAt: "2026-09-28T09:00:00.000Z", reportSubmittedAt: "2026-09-28T18:00:00.000Z", reportMissed: false, selfRating: 8, rmRating, submitted: true });
const rows = [row("rm1", "RM One", Role.REGIONAL_MANAGER, null), row("so1", "Rahul", Role.SALES_OFFICER, 7), row("so2", "Amit", Role.SALES_OFFICER, null)];
payload = { role: Role.REGIONAL_MANAGER, from: "2026-09-28", to: "2026-09-28", states: [], officers: [], rows, summary: { salesOfficers: 2, employeeDays: 3, submittedPlans: 3, submittedReports: 3, averageSelfRating: 8, averageRmRating: 7, sections } };
const cellsOf = (html: string, name: string) => [...((html.match(new RegExp(`<tr\\b[^>]*>(?:(?!</tr>).)*${name}(?:(?!</tr>).)*</tr>`)) ?? [""])[0].matchAll(/<td\b[^>]*>(.*?)<\/td>/g))].map((m) => m[1]);
for (const viewer of [Role.REGIONAL_MANAGER, Role.SUPER_ADMIN]) {
  const html = renderToStaticMarkup(<PerformancePage role={viewer} />);
  const rmCells = cellsOf(html, "RM One"), soCells = cellsOf(html, "Rahul"), noRating = cellsOf(html, "Amit");
  const ratingIdx = (cells: string[]) => cells.findIndex((c) => /7 \/ 10|data-testid="rm-badge"|^<span class="text-muted-foreground">—<\/span>$/.test(c) && !/Present|Submitted|\d{2}:\d{2}/.test(c));
  assert.equal((html.match(/data-testid="rm-badge"/g) ?? []).length, 1, `${viewer}: exactly one capsule — on the RM's row only`);
  assert.ok(rmCells.some((c) => c.includes('data-testid="rm-badge"') && c.includes("RM")), `${viewer}: the RM row shows the capsule in a cell`);
  assert.ok(!rmCells.some((c) => c.includes("—") && c.includes("rm-badge")), "capsule replaces the dash");
  assert.ok(soCells.some((c) => c.trim() === "7 / 10") && !soCells.some((c) => c.includes("rm-badge")), `${viewer}: a Sales Officer's rating is unchanged`);
  assert.ok(noRating.some((c) => c.includes('<span class="text-muted-foreground">—</span>')) && !noRating.some((c) => c.includes("rm-badge")), `${viewer}: a missing SO rating still shows the dash`);
  assert.equal(ratingIdx(rmCells) >= 0, true);
}
// The viewer's role never decides it: an SO viewer's own row is an SO row (no capsule), and the RM column index is the RM Rating column.
payload = { ...(payload as object), rows: [row("so1", "Rahul", Role.SALES_OFFICER, 7)] };
assert.ok(!renderToStaticMarkup(<PerformancePage role={Role.SALES_OFFICER} />).includes("rm-badge"));
payload = { ...(payload as object), rows };
const rmHtml = renderToStaticMarkup(<PerformancePage role={Role.REGIONAL_MANAGER} />);
const head = [...rmHtml.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
const rmCol = head.indexOf("RM Rating");
assert.ok(rmCol >= 0 && cellsOf(rmHtml, "RM One")[rmCol - 0 - (head.length - cellsOf(rmHtml, "RM One").length)]?.includes("rm-badge"), "the capsule sits under the RM Rating header");

// 5) One title / breadcrumb for the RM page; own + team stats; counts label stays "Sales Officers".
assert.ok(rmHtml.includes("<h1") && />Performance<\/h1>/.test(rmHtml) && rmHtml.includes('data-crumbs="Insights&gt;Performance"'), "RM page title + breadcrumb: Performance");
assert.equal((DEFAULT_LABELS as Record<string, string>)["daily_work.performance.team_title"], "Performance");
assert.equal((DEFAULT_LABELS as Record<string, string>)["daily_work.performance.rm_badge"], "RM");
assert.ok(/Sales Officers<\/div><div[^>]*>2</.test(rmHtml), "'Sales Officers' shows the Sales Officer count only");
assert.ok(/Not Submitted<\/div>/.test(rmHtml), "the not-submitted count from the old Team page is available to the RM");
assert.ok(rmHtml.includes("View"), "report-view actions kept");

// 6) The View dialog never offers a rating on an RM's own day, and shows the capsule instead of a rating panel.
const page = readFileSync("src/features/daily-work/performance-page.tsx", "utf8");
assert.ok(page.includes("officerRole === Role.REGIONAL_MANAGER") && /readOnly=\{role !== Role\.REGIONAL_MANAGER \|\|/.test(page), "RM rows open read-only");
const dialog = readFileSync("src/features/daily-work/team-performance-page.tsx", "utf8");
assert.ok(dialog.includes("data.officerRole === Role.REGIONAL_MANAGER") && dialog.includes("<RmBadge"), "review dialog: capsule for an RM subject");
assert.ok(!dialog.includes("TeamPerformancePage"), "the separate Team Performance page component is gone");
console.log("rm-performance-merge.test.tsx — all assertions passed");
