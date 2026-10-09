/** Seasonal / Monthly LIST pages: a list across seasons (no automatic season / month), Create asks for the season (and month), Open links go to the plan by id. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

let hooks: unknown[] = [];
let cursor = 0;
const posts: { url: string; body: unknown }[] = [];
const gets: string[] = [];
let invalidations = 0;
let seasonalSheets: unknown[] = [];
let monthlySheets: unknown[] = [];
let seasonalOptions: unknown = { seasons: [] };
let monthlyOptions: unknown = { seasons: [] };
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let selects: { placeholder?: string; value?: string; disabled?: boolean; options: { value: string; label: string }[]; onChange?: (e: { target: { value: string } }) => void }[] = [];

const overrides = {
  react: {
    ...React,
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }];
    },
  },
  "next/link": { __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{DEFAULT_LABELS[k]}</>, useLabel: (k: LabelKey) => DEFAULT_LABELS[k] },
  "./party-planning-page": { PartyPlanModeLinks: ({ mode, stage, actions }: { mode: string; stage?: string; actions?: React.ReactNode }) => <nav data-mode={mode} data-stage={stage}>{actions}</nav> },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "@tanstack/react-query": {
    useQuery: ({ queryKey, queryFn }: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => {
      void queryFn();
      const key = String(queryKey[0]);
      if (key === "seasonal-sheets") return { data: seasonalSheets, isLoading: false };
      if (key === "party-monthly-sheets") return { data: monthlySheets, isLoading: false };
      if (key === "seasonal-sheet-options") return { data: seasonalOptions };
      if (key === "party-monthly-sheet-options") return { data: monthlyOptions };
      return { data: undefined };
    },
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: () => Promise<unknown>; onSuccess?: () => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: () => { void o.mutationFn().then(() => o.onSuccess?.(), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async (url: string) => { gets.push(url); return []; }, post: async (url: string, body: unknown) => { posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/select": { NativeSelect: (p: (typeof selects)[number]) => { selects.push(p); return <select data-placeholder={p.placeholder} />; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const load = testLoader(overrides);
const { SeasonalPlanListPage } = load("src/features/party-planning/seasonal-plan-list-page.tsx") as { SeasonalPlanListPage: React.ComponentType<{ role: Role; stage?: string }> };
const { MonthlyPlanListPage } = load("src/features/party-planning/monthly-plan-list-page.tsx") as { MonthlyPlanListPage: React.ComponentType<{ role: Role; stage?: string }> };

function render(Page: React.ComponentType<{ role: Role; stage?: string }>, role: Role = Role.SALES_OFFICER, stage?: string) {
  cursor = 0; buttons = []; selects = [];
  const html = renderToStaticMarkup(<Page role={role} stage={stage} />);
  hooks.length = cursor;
  return html;
}
const click = (label: string) => { const b = buttons.filter((x) => String(x.children).includes(label)); assert.ok(b.length >= 1, `button "${label}"`); b[b.length - 1]!.onClick!(); };
const pick = (placeholder: string, value: string) => selects.filter((s) => s.placeholder === placeholder || s.placeholder === "Select a season…" && placeholder === "season").at(-1)!.onChange!({ target: { value } });
const links = (html: string) => [...html.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => [m[1]!, m[2]!]);
const tick = () => new Promise((r) => setTimeout(r, 0));

const SEASONAL = [
  { id: "sh-k", seasonId: "s-kharif", seasonName: "Kharif 2026", seasonOpen: true, ownerName: "Officer One", status: "Draft", itemCount: 2, pendingCount: 0, needsMyReview: 0, counts: { create: 2, submitted: 0, approved: 0 }, updatedAt: "2026-10-07T10:00:00.000Z", own: true },
  { id: "sh-r", seasonId: "s-rabi", seasonName: "Rabi 2026", seasonOpen: true, ownerName: "Officer One", status: "Draft", itemCount: 1, pendingCount: 1, needsMyReview: 0, counts: { create: 1, submitted: 0, approved: 0 }, updatedAt: "2026-10-06T10:00:00.000Z", own: true },
];
const MONTHLY = [
  { id: "ms-a", seasonId: "s-kharif", seasonName: "Kharif 2026", seasonOpen: true, monthLabel: "April 2026", ownerName: "Officer One", status: "Draft", counts: { create: 0, submitted: 0, approved: 0, pendingRm: 0, rejected: 0 }, submittedAt: null, itemCount: 0, needsMyAction: 0, updatedAt: "2026-10-07T10:00:00.000Z", own: true },
  { id: "ms-n", seasonId: "s-rabi", seasonName: "Rabi 2026", seasonOpen: true, monthLabel: "November 2026", ownerName: "Officer One", status: "In Progress", counts: { create: 2, submitted: 0, approved: 0, pendingRm: 0, rejected: 0 }, submittedAt: null, itemCount: 2, needsMyAction: 1, updatedAt: "2026-10-06T10:00:00.000Z", own: true },
];

async function main() {
  /* ---------------- Seasonal list ---------------- */
  seasonalSheets = SEASONAL;
  let html = render(SeasonalPlanListPage);
  assert.ok(!html.includes("Season: ") && !/Apr 2026 → Nov 2026/.test(html), "no automatic current-season context on the list");
  for (const gone of ["My plans", "To review", "All plans", "Add plan"]) assert.ok(!html.includes(gone), `no "${gone}" on the list`);
  assert.ok(html.includes('data-mode="seasonal"'), "Planning › Seasonal stays the active navigation");
  assert.ok(html.includes("Kharif 2026") && html.includes("Rabi 2026"), "plans of DIFFERENT seasons are listed together");
  for (const col of ["Season", "Status", "Markets", "Last Saved", "Open"]) assert.ok(html.includes(`>${col}</th>`), `column ${col}`);
  assert.ok(!html.includes(">Officer</th>"), "the owner column only appears when there are other people's plans");
  assert.deepEqual(links(html).filter(([, t]) => t === "Open"), [["/planning/party/seasonal/sh-k?stage=create", "Open"], ["/planning/party/seasonal/sh-r?stage=create", "Open"]], "Open goes to the exact plan by id");
  assert.equal(buttons.filter((b) => String(b.children).includes("Create Seasonal Plan")).length, 1);
  assert.ok(html.includes("<nav data-mode=\"seasonal\" data-stage=\"create\"><button>"), "Create Seasonal Plan is rendered inside the Seasonal | Monthly row (actions slot)");
  assert.ok(gets.some((u) => u.startsWith("/api/seasonal-sheets")));
  // reviewers: owner column + the 'needs my review' filter replace the old tabs
  seasonalSheets = [{ ...SEASONAL[0], own: false, ownerName: "Officer Two", needsMyReview: 1, status: "Pending Approval", counts: { create: 0, submitted: 1, approved: 0 } }];
  html = render(SeasonalPlanListPage, Role.REGIONAL_MANAGER, "submitted");
  assert.ok(html.includes(">Officer</th>") && html.includes("Officer Two") && html.includes("1 to review"));
  seasonalSheets = [{ ...(seasonalSheets[0] as object), status: "Draft" }];
  html = render(SeasonalPlanListPage, Role.SUPER_ADMIN);
  assert.equal(buttons.filter((b) => String(b.children).includes("Create Seasonal Plan")).length, 1, "Admin gets Create Seasonal Plan (the backend creates it as Admin, in their own right)");
  assert.ok(html.includes("Officer Two"), "Admin sees other officers' plans with the Officer column");
  for (const role of [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER, Role.SALES_OFFICER]) { html = render(SeasonalPlanListPage, role); assert.ok(!html.includes("Needs my review") && !html.includes("All seasons") && !html.includes("<label>Season</label>"), "the Season filter row (and review checkbox) is gone"); }
  seasonalSheets = [];
  assert.ok(render(SeasonalPlanListPage).includes("No Seasonal Plans in progress."));

  // Create: a dialog asking for the season (every OPEN season, nothing pre-selected), then POST { seasonId } and back to the list.
  seasonalOptions = { seasons: [{ id: "s-kharif", name: "Kharif", year: 2026, period: "Apr 2026 → Nov 2026", hasPlan: false }, { id: "s-rabi", name: "Rabi", year: 2026, period: "Nov 2026 → Mar 2027", hasPlan: true }, { id: "s-zaid", name: "Zaid", year: 2026, period: "Mar 2026 → Jun 2026", hasPlan: false }] };
  render(SeasonalPlanListPage);
  click("Create Seasonal Plan");
  html = render(SeasonalPlanListPage);
  assert.ok(html.includes("data-dialog") && html.includes("Create Seasonal Plan") && html.includes("Season *"));
  const seasonSelect = selects.find((s) => s.placeholder === "Select a season…")!;
  assert.deepEqual(seasonSelect.options.map((o) => o.label), ["Kharif 2026", "Rabi 2026 (plan exists)", "Zaid 2026"], "all OPEN seasons come from the Seasons module — none hard-coded, none auto-chosen");
  assert.equal(seasonSelect.value, "", "no season is pre-selected");
  assert.ok(buttons.filter((b) => String(b.children).includes("Create") && !String(b.children).includes("Seasonal")).at(-1)!.disabled, "Create stays disabled until a season is chosen");
  click("Cancel"); html = render(SeasonalPlanListPage);
  assert.ok(!html.includes("data-dialog") && posts.length === 0, "Cancel changes nothing");
  click("Create Seasonal Plan"); render(SeasonalPlanListPage);
  pick("season", "s-zaid"); html = render(SeasonalPlanListPage);
  assert.ok(html.includes("Create"));
  buttons.filter((b) => String(b.children) === "Create").at(-1)!.onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/seasonal-sheets", body: { seasonId: "s-zaid" } }], "the CHOSEN season is sent — never a current season");
  assert.ok(invalidations >= 1, "the list refreshes");
  assert.ok(!render(SeasonalPlanListPage).includes("data-dialog"), "the dialog closes after creating");

  /* ---------------- lifecycle sections (Seasonal list: filtered by plan status; closed season → Older) ---------------- */
  {
    // One logical plan per owner + season: its entries are counted per section.
    const mk = (id: string, counts: { create: number; submitted: number; approved: number }, seasonOpen = true) => ({ ...SEASONAL[0], id, counts, seasonOpen, seasonName: id, itemCount: counts.create + counts.submitted + counts.approved });
    seasonalSheets = [mk("EMPTY", { create: 0, submitted: 0, approved: 0 }), mk("MIXED", { create: 1, submitted: 2, approved: 3 }), mk("SUB", { create: 0, submitted: 1, approved: 0 }), mk("OLD", { create: 0, submitted: 0, approved: 2 }, false), mk("OLD2", { create: 4, submitted: 0, approved: 0 }, false)];
    const shown = (stage: string) => links(render(SeasonalPlanListPage, Role.SALES_OFFICER, stage)).filter(([, t]) => t === "Open").map(([h]) => h.split("/").pop()!.split("?")[0]);
    assert.deepEqual(shown("create"), ["EMPTY", "MIXED", "SUB"], "Create is a persistent workspace: every open-season plan stays, even after submissions");
    assert.deepEqual(shown("submitted"), ["MIXED", "SUB"], "Submitted: the plan appears ONCE, however many batches");
    assert.deepEqual(shown("approved"), ["MIXED"], "Approved: only a plan holding approved entries");
    assert.deepEqual(shown("older"), ["OLD", "OLD2"], "closed seasons → Older Plans");
    const counts = (stage: string) => [...render(SeasonalPlanListPage, Role.SALES_OFFICER, stage).matchAll(/tabular-nums">(\d+)</g)].map((m) => Number(m[1]));
    assert.deepEqual([counts("create"), counts("submitted"), counts("approved"), counts("older")], [[0, 1, 0], [2, 1], [3], [2, 4]], "the Markets column counts the entries of THAT section");
    assert.ok(render(SeasonalPlanListPage, Role.SALES_OFFICER, "submitted").includes("/planning/party/seasonal/MIXED?stage=submitted"), "Open keeps the section, so Back / detail land in the right place");
    render(SeasonalPlanListPage, Role.SALES_OFFICER, "submitted"); assert.equal(buttons.filter((b) => String(b.children).includes("Create Seasonal Plan")).length, 0, "Create button only in Create");
    assert.ok(render(SeasonalPlanListPage, Role.SALES_OFFICER, "older").includes('data-stage="older"'), "the nav is told which section is active");
    seasonalSheets = SEASONAL;
  }

  /* ---------------- Monthly list ---------------- */
  posts.length = 0; hooks = []; invalidations = 0;
  monthlySheets = MONTHLY;
  html = render(MonthlyPlanListPage);
  assert.ok(!html.includes("Season: ") && !/Apr 2026 → Nov 2026/.test(html), "no automatic current season / month context");
  for (const gone of ["My plans", "All in my scope", "All plans", "All months"]) assert.ok(!html.includes(gone), `no "${gone}"`);
  assert.ok(html.includes('data-mode="monthly"'));
  for (const col of ["Season", "Month", "Overall Status", "Markets", "Last Saved", "Open"]) assert.ok(html.includes(`>${col}</th>`), `column ${col}`);
  assert.ok(html.includes("April 2026") && html.includes("November 2026") && html.includes("Kharif 2026") && html.includes("Rabi 2026"), "several seasons AND months in one list");
  assert.deepEqual(links(html).filter(([, t]) => t === "Open").map(([h]) => h), ["/planning/party/monthly/ms-a?stage=create", "/planning/party/monthly/ms-n?stage=create"]);
  assert.ok(html.includes("1 to action") && !html.includes("Needs my action") && !html.includes("All seasons") && !html.includes("<label>Season</label>"), "the Season filter row is gone from Monthly");
  assert.ok(html.includes("<nav data-mode=\"monthly\" data-stage=\"create\"><button>"), "Create Monthly Plan moved into the Seasonal | Monthly row");
  assert.equal(buttons.filter((b) => String(b.children).includes("Create Monthly Plan")).length, 1);
  render(MonthlyPlanListPage, Role.SUPER_ADMIN); assert.equal(buttons.filter((b) => String(b.children).includes("Create Monthly Plan")).length, 1, "Admin gets Create Monthly Plan");
  render(MonthlyPlanListPage, Role.CUSTOM_ADMIN); assert.equal(buttons.filter((b) => String(b.children).includes("Create Monthly Plan")).length, 1);
  monthlySheets = []; assert.ok(render(MonthlyPlanListPage).includes("No Monthly Plans in progress."));

  // Create: Season → Month (that season's months, calendar order), explained when there is no approved market, then POST { seasonId, seasonMonthId }.
  monthlyOptions = { seasons: [
    { id: "s-kharif", name: "Kharif", year: 2026, period: "Apr 2026 → Nov 2026", eligibleCount: 2, takenMonthIds: ["sm-june"], months: [{ id: "sm-april", label: "April 2026" }, { id: "sm-may", label: "May 2026" }, { id: "sm-june", label: "June 2026" }] },
    { id: "s-rabi", name: "Rabi", year: 2026, period: "Nov 2026 → Mar 2027", eligibleCount: 0, months: [{ id: "sm-r-nov", label: "November 2026" }], takenMonthIds: [] },
  ] };
  render(MonthlyPlanListPage); click("Create Monthly Plan");
  html = render(MonthlyPlanListPage);
  assert.ok(html.includes("Season *") && html.includes("Month *"));
  assert.deepEqual(selects.find((s) => s.placeholder === "Select a season…")!.options.map((o) => o.label), ["Kharif 2026", "Rabi 2026"], "every OPEN season is a choice");
  assert.equal(selects.find((s) => s.placeholder === "Select a month…")!.disabled, true, "Month waits for a Season");
  selects.find((s) => s.placeholder === "Select a season…")!.onChange!({ target: { value: "s-kharif" } }); html = render(MonthlyPlanListPage);
  assert.deepEqual(selects.find((s) => s.placeholder === "Select a month…")!.options.map((o) => o.label), ["April 2026", "May 2026", "June 2026 (plan exists)"], "the months of the CHOSEN season");
  selects.find((s) => s.placeholder === "Select a month…")!.onChange!({ target: { value: "sm-may" } }); render(MonthlyPlanListPage);
  assert.equal(buttons.filter((b) => String(b.children) === "Create").at(-1)!.disabled, false);
  buttons.filter((b) => String(b.children) === "Create").at(-1)!.onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-sheets", body: { seasonId: "s-kharif", seasonMonthId: "sm-may" } }], "the chosen Season + Month are sent");
  assert.ok(!render(MonthlyPlanListPage).includes("data-dialog") && invalidations >= 1, "closes and refreshes");
  // A season with no approved Seasonal Plan market: explained, Create disabled — never silently creating an invalid plan.
  click("Create Monthly Plan"); render(MonthlyPlanListPage);
  selects.find((s) => s.placeholder === "Select a season…")!.onChange!({ target: { value: "s-rabi" } }); html = render(MonthlyPlanListPage);
  assert.ok(html.includes("You have no approved Seasonal Plan market in Rabi 2026"), "the dialog explains why");
  selects.find((s) => s.placeholder === "Select a month…")!.onChange!({ target: { value: "sm-r-nov" } }); render(MonthlyPlanListPage);
  assert.equal(buttons.filter((b) => String(b.children) === "Create").at(-1)!.disabled, true, "Create is disabled without an eligible market");

  /* ---------------- Monthly sections: labels / counts / Open keep the section ---------------- */
  {
    const m = (id: string, counts: Record<string, number>) => ({ ...MONTHLY[0], id, counts: { create: 0, submitted: 0, approved: 0, pendingRm: 0, rejected: 0, ...counts }, itemCount: 9 });
    monthlySheets = [m("A", { create: 0 }), m("B", { create: 2, rejected: 1 }), m("C", { submitted: 3, pendingRm: 3 }), m("D", { submitted: 1, pendingRm: 0 }), m("E", { approved: 4 })];
    const page = (stage: string) => render(MonthlyPlanListPage, Role.SALES_OFFICER, stage);
    assert.ok(page("create").includes("Ready for new markets") && page("create").includes("Needs changes"), "Create labels: empty workspace / rejected entries");
    assert.ok(page("submitted").includes("Awaiting RM review") && page("submitted").includes("Awaiting Admin review"));
    assert.ok(page("approved").includes("Approved") && page("approved").includes(">4<"), "Markets = entries of THAT section (4), not the plan total (9)");
    assert.ok(page("submitted").includes("/planning/party/monthly/C?stage=submitted"));
    assert.ok(gets.some((u) => u.includes("stage=approved")), "the section is sent to the API, which lists a plan only while it holds entries in it");
  }

  /* ---------------- source-level guards ---------------- */
  for (const f of ["seasonal-plan-list-page.tsx", "monthly-plan-list-page.tsx"]) {
    const src = readFileSync(`src/features/party-planning/${f}`, "utf8");
    assert.ok(!/getCurrentSeason|currentOpenSeason|currentBusinessDate/.test(src), `${f} has no current-season / today logic`);
  }
  console.log("plan-lists-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
