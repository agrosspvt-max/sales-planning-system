# Technical Architecture — Sales Planning

Implementation notes for the Sales Planning module. Business rules live in
`PROJECT_SPECIFICATION.md`; this file documents *how* the code realises them. Written
after the final regression review.

> **Current pricing policy.** Planning reads the live Product Master Rate/NBV% on every request;
> `PlanLine` snapshot fields are retained only for database compatibility and are not read or
> refreshed. Sales Upload stores the workbook's Quantity and Value in `MonthlyEntry.saleQty` and
> `saleValue`; actual-sale amounts always come from `saleValue`, never from quantity × rate.

## 1. Single calculation engine

Every planning figure resolves to `src/lib/calc.ts`. The only definitions of the base
formulas are:

- `amount(qty, rate)` = qty × rate
- `nbv(amountValue, nbvPercent)` = amount × nbv%
- `achievement(actual, plan)` = actual ÷ plan (zero-plan guard)
- `pendingQty(target, actual)` = target − actual
- `seasonVsMonth(target, monthlyPlanned)` = target − monthlyPlanned
- `figuresForMode(mode, value, rate, nbv%)` — Pack Size / Total Qty / Amount / NBV → {totalQty, amount, nbv}
- `assembleWorkbookLine(...)` — composes the above into the full season + per-month workbook line

Consumers, all routed through the above (no re-encoded formulas):

| Consumer | Uses |
|---|---|
| Seasonal grid (`plan-grid.tsx`) | `figuresForMode`, `amount`, `nbv`, `sumFlex` |
| Monthly planner (`monthly-planner.tsx`) | `achievement`, `amount` |
| Workbook View service (`getWorkbook`) | `assembleWorkbookLine` |
| Workbook View UI (`workbook-view.tsx`) | **no arithmetic** — display only |
| Reports (`reports/service.server.ts`) | `figuresForMode`, `amount`, `nbv`, `achievement` |
| Product/Dealer Summary | reuse `ReportsPage` (same engine) |
| Dashboards | reuse `reports/groupSummary` |

Verified by grep: no `qty*rate` / `amount*nbv%` arithmetic exists outside `calc.ts`.

## 2. Workbook View = presentation layer

`getWorkbook(ctx, planId, dealerId)` (in `planning/service.server.ts`) is the only place
that assembles the workbook, and it only calls `assembleWorkbookLine`. The React component
(`workbook-view.tsx`) formats/labels values and performs zero calculation. The plan
workspace "Workbook View" tab and the standalone `/planning/sales/workbook` page share the
same component and service.

## 2a. Planning workflow (refactored) — Create New Plan / View Approved Plans

The sidebar exposes the business lifecycle as two workspaces plus the two independent
workflows (Import, Approvals):

```
Planning
 ├── Create New Plan     → editable (DRAFT / RETURNED / REJECTED) plans
 └── View Approved Plans → APPROVED plans (read-only)
Import Seasonal Plan · Approvals
```

Both open on **module cards** (`planning-modules.tsx`; Sales functional, Recovery/Scheme/
Party = Coming Soon). Inside **Sales Planning** a **Create New Plan | View Approved Plans**
toggle drives the two modes of one component (`sales-planning.tsx`) with Seasonal/Monthly/
Yearly type tabs. The Create/View split is a **client-side status filter** over the existing
`listPlans` DTO — no new query, no schema change. Admins get a Sales-Officer filter; officers
see only their own (existing scope helpers). New Seasonal plans are created from
Season + Year + months via `createSeasonalPlans` → `findOrCreateSeason` + `createSalesPlan`
per officer (the existing dedupe reopens an existing draft — one plan per season+officer+type).

**Seasonal Draft workspace** (`plan-workspace.tsx`) tabs: **Dealer Plan · Product Plan ·
Dealer Summary · History**. Monthly and the old standalone Workbook View are not here.

**Dealer completion.** Each dealer ends in exactly one state: **Completed** (≥1 *saved*
quantity — derived, not stored), **No Plan** (`PlanDealer.noPlan` + optional `noPlanReason`,
the only persisted state; set via `setDealerNoPlan` / `POST …/dealers/:dealerId/no-plan`), or
**Remaining**. Dealer Plan shows a live progress bar and colours the dealer picker (green /
purple / grey); Submit is disabled until Completed + No Plan = total, with a confirmation
dialog listing No-Plan dealers. `submitPlan` enforces the same rule server-side. Completion is
derived from the shared `PlanEditProvider`'s saved-state snapshot (updated only on successful
autosave), so typing alone never marks a dealer complete.

**Monthly Planning** is now a **first-class lifecycle** (see §2c). Each month of an approved
seasonal plan is a `MonthlyPlan` with its own Draft → Submit → Approve flow, reached from
**Create New Plan → Monthly** or from the approved seasonal plan's "Select Monthly Plan"
dialog. The old all-months `/planning/[id]/monthly` route is **deprecated** (redirects to the
seasonal plan); `monthly-workspace.tsx` is retained only as the legacy all-months view.

**Dealer Planning status** is a shared vocabulary — `DealerPlanningStatus`
(`REMAINING` / `COMPLETED` / `NO_PLAN`) in `dealer-status.ts` — used by the UI (progress bar,
dropdown colours) and mirrored by the server submit gate. Only `NO_PLAN` is stored
(`PlanDealer.noPlan`); the other two are derived. No string literals.

## 2b. Live edit contexts — one autosave core

Dealer Plan / Product Plan / Dealer Summary share **`PlanEditProvider`** (seasonal); Dealer
Monthly Plan / Monthly Product Plan / Monthly Dealer Summary share **`MonthlyEditProvider`**
(monthly). Editing recomputes the read-only views **instantly** from the same live cells (no
refetch). The two providers are intentionally *not* merged — different DTOs, keys, payloads
and endpoints — but their identical optimistic-state + dirty-set + debounced-save mechanics
are unified in one hook, **`useAutosaveMap<T>(initial, persist)`** (`use-autosave-map.ts`);
each provider only supplies its `persist` (which builds the mode-aware payload and calls the
existing `/lines` or `/monthly` endpoint). Context values are `useMemo`-ised so consumers
re-render only on real dependency changes. **No calculation lives in a provider** — figures
come from `lib/calc` (`figuresForMode`, etc.).

## 2c. Monthly Planning — first-class lifecycle

A **`MonthlyPlan`** (`prisma`) is the lifecycle unit for **exactly one month** of an approved
seasonal plan: `(seasonPlanId, seasonMonthId, officerId, status, submittedAt, approvedAt,
lastSavedAt)`, unique on `(seasonPlanId, seasonMonthId)`. **It reuses the existing monthly
data engine** — the per-dealer/per-line quantities stay in `MonthlyEntry` (keyed
`planLine + seasonMonth`), so there is **no duplicate `MonthlyPlanDealer`/`MonthlyPlanLine`
store and no duplicated calculation**. The shared transform `buildMonthlyDealers(...)`
(`monthly.server.ts`) projects those entries; both the legacy all-months view and the
single-month plan call it.

**Approval reuses the seasonal machine, not a new framework.** `monthly-plan.server.ts`
drives the identical `PlanStatus` states (DRAFT → PENDING_RM → PENDING_ADMIN → APPROVED,
plus RETURNED/REJECTED) via the same routing (`getCurrentManagerId` → RM else Admin), logs to
the **same `ApprovalAction`** table (now with a nullable `monthlyPlanId`; `seasonPlanId` points
at the parent), and sends the **same `Notification`** types. There is no price snapshot or
versioning — the parent seasonal plan already owns those.

**Editing**: `MonthlyEditProvider` is reused unchanged except for an optional `saveUrl`, so the
first-class plan persists to `PATCH /api/planning/monthly-plans/:id` while the legacy view keeps
`/monthly`. The monthly planner drops its in-page month selector when a single month is present
(`data.months.length <= 1`) — one plan = one month, opened directly.

**Dealer completion parity with Seasonal.** The Monthly Plan reuses the SAME progress components
as Seasonal (`dealer-completion.tsx`: `DealerProgressBar`, `NoPlanDialog`, `DealerPlanningStatus`)
— progress bar, ✓/⦸ ticks and coloured dealer dropdown, per-dealer **No Plan** button, and a
**completion-gated Submit** (disabled until every dealer is Completed or No Plan, with a No-Plan
confirmation) enforced identically on the server in `submitMonthlyPlan`. "Completed" is derived
(≥1 monthly plan value entered); only **No Plan** is stored, in **`MonthlyPlanDealer`**
(`monthlyPlanId + dealerId`, unique) — the monthly analogue of `PlanDealer.noPlan`, kept separate
so a dealer can be planned seasonally yet skipped for a specific month. Completion refreshes after
each autosave via a query invalidation; the editable grid is seeded per plan identity so the
refetch never wipes in-progress edits. Sales Upload actuals are untouched — "This Month Sold"
stays read-only and Monthly approval governs only the plan.

**Entry points**: *Create New Plan → Monthly* lists Draft/Returned monthly plans and offers
**Create New Monthly Plan** (Step 1 = an approved seasonal plan; Step 2 = a month of that
season; **+ Add Month** → a Month Extension Request). *View Approved Plans → Monthly* lists
Approved monthly plans (read-only). From an approved seasonal plan, **Monthly Planning** opens a
**Select Monthly Plan** dialog (Open Draft / View Approved → months).

**Month Extension Request** (`MonthExtensionRequest`, `month-extension.server.ts`): a Sales
Officer requests a new (future) month; **nothing changes until a Super Admin approves**.
Approval **appends a `SeasonMonth` (OPEN)** at `max(order)+1` inside a transaction (duplicate
month names rejected, case-insensitive) and notifies the officer. Admin review lives on the
**Approvals** page alongside monthly-plan approvals.

**Seasonal view filters**: Seasonal **Product Plan** and **Dealer Summary** gain a *View*
control — **Seasonal Total** (default; the live seasonal table) · **Specific Month** · **Month
Range**. The month/range options aggregate **Approved Monthly Plans only**
(`getApprovedMonthlyForSeasonPlan` → `buildMonthlyDealers`, figures via `figuresForMode`); when
no approved monthly plan exists the view shows *"Monthly Planning has not been initiated for this
month."* instead of an empty table. One shared wrapper `SeasonalMonthlyView` serves both
(grouped by product or dealer).

## 2d. Sales Upload — Tally actual-sales import

Actual Sales are no longer entered by hand. A Super Admin uploads a Tally **Product.xlsx**
("Sales Register" sheet) and the system fills the **Actual** fields for the chosen month. Sales
Officers can only view actuals; **"This Month Sold" is read-only** and **Actual Amount comes
from the uploaded value, never qty × rate**.

- **Parser** (`sales-upload/parser.ts`, pure): the sheet layout is fixed — Col A (Group Name)
  non-empty marks a **dealer header** (name in Col B), an empty Col A is a **product row** for
  the current dealer (Col C qty, Col D amount). Product names are stripped of pack info
  (`CHIMA 10X500GM → CHIMA`) via regex; quantities reduced to a number; **amount taken
  verbatim**. Duplicate products under one dealer are **merged** (qty + amount summed). Verified
  against the reference file: 332 dealers, 2208 rows, 701 merged.
- **Matching** reuses the ONE matcher (`match-key`): **Dealer** = Alias → exact → loose → fuzzy;
  **Product** = exact → loose → fuzzy (cleaned name). The **`DealerAlias`** table is consulted
  first (unique `tallyKey` enforces "duplicate alias").
- **Dealer → Officer is implicit**: a row is importable only when the matched dealer+product map
  to a `PlanLine` in an **APPROVED, active** seasonal plan for the target month's season — that
  `PlanDealer` already encodes the dealer's Sales Officer, so no officer is ever chosen.
- **Analyze** (`analyzeSalesUpload`) writes nothing and reports Dealers/Products found,
  Duplicates merged, Unknown dealers/products, dealers without a plan, and Rows to import.
  **Commit** (`commitSalesUpload`) writes in ONE transaction (`timeout: 60000`), reusing the
  Seasonal-Import bulk pattern: new `MonthlyEntry` rows via **`createMany`**, existing rows
  updated in **batched `Promise.all`** — touching **only `saleQty`/`saleValue`**, never
  `planQty`/`planValue`. History = **`SalesUploadRun`**; audit via `writeAudit`.
- **Read path**: `buildMonthlyDealers` and `getPlanDetail` now expose `saleAmount`/`actualAmount`
  from `saleValue`; the monthly planner, seasonal Dealer Summary and Product-Plan month views
  read those instead of qty × rate. `saveMonthly*` write plan fields only, so imports are never
  clobbered by plan edits. Sidebar: **Sales Upload** + **Dealer Alias** under Planning (admin).

## 2e. Recovery Planning — the third planning module

Recovery Planning reuses the whole planning architecture; it is not a new one. Replaces the
"Coming Soon" Recovery cards under Create New Plan / View Approved Plans (no new sidebar item).

- **Model (normalised, never JSON).** `RecoveryPlan` (per season-month + officer) is the
  lifecycle unit, reusing `PlanStatus` + `ApprovalAction` (new nullable `recoveryPlanId`;
  `seasonPlanId` made nullable since recovery has no seasonal parent). `RecoveryPlanDealer`
  holds read-only aging (outstanding/overdue/due/running) + editable month plan + No Plan.
  `RecoveryWeekPlan` = Week View rows. Aging history lives in `AgingSnapshot` → normalised
  `AgingSnapshotDealer` → `AgingSnapshotBill` (raw bills), so future features (payments,
  actual recovery) need no schema change.
- **Import.** The admin uploads the Tally **Bills Receivable** Aging Report (`recovery/parser.ts`,
  built to the exact workbook — dealer header, bill rows, total rows; verified 590 dealers /
  1612 bills). Dealer matching **reuses `matchByName`** (Alias → exact → loose → fuzzy). Bills
  are bucketed by the chosen **cutoff** (`Due < cutoff → Overdue`; within the cutoff's month →
  `Due`; later → `Running`; `Outstanding = Overdue+Due+Running`, verified exact). The report is
  **split per officer** by current dealer assignment into a Draft `RecoveryPlan` each.
- **Approval reuses the exact workflow** (`recovery/approval.server.ts`): Officer → RM → Admin
  via the same `PlanStatus` machine, `ApprovalAction` log and notifications — no finalize, no
  new framework. Recovery plans appear in the existing **Approvals** page.
- **Plan screen** (`recovery-workspace.tsx`): **Month View** (editable Recovery Plan / Running
  Recovery, auto Recovery %, Month Total, Weekly Total, Difference) and **Week View** (editable
  per-week, auto Week Total + Difference), both autosaving through the shared **`useAutosaveMap`**.
  Dealer progress reuses **`DealerProgressBar` / `NoPlanDialog` / `DealerPlanningStatus`** and a
  completion-gated **Submit** (`RecoveryActions`, mirroring `MonthlyPlanActions`) enforced
  server-side. Month View locks once approved; Week View re-opens on a weekly upload when the
  "allow weekly edit" toggle is on (never while pending).
- **Weekly re-upload** (`uploadWeeklyAging`) creates a NEW snapshot (never overwrites), refreshes
  ONLY the read-only aging figures (month/weekly plans + history preserved), sets the edit
  toggle, and returns a **change-tracking summary** (outstanding increased/decreased, new/removed
  dealers) computed against the previous snapshot.
- **Deferred (next increment):** the standalone **Recovery Dashboard** page (summary cards +
  Outstanding/Recovery trend, Top Overdue, Officer Comparison charts). All the data it needs —
  snapshots, aggregates, per-week plans, per-dealer deltas — is already stored.

## 2f. Monthly Planning — Additional Products & Create Dealer

Officers can plan beyond the approved Seasonal Plan without ever changing it, reusing the
existing Monthly lifecycle/approval/autosave/progress:

- **Additional Products.** An additional product is a real **`PlanLine` with `isAdditional=true`
  and zero seasonal quantity**, so `MonthlyEntry` works unchanged, but seasonal views exclude it
  (`getPlanDetail` filters `isAdditional=false` / `fromMonthlyPlan=false`) — approved seasonal
  figures/structure are untouched. `buildMonthlyDealers` always includes `isAdditional` lines so
  they appear in the monthly table (badged **ADDITIONAL PRODUCT**) and plan through the normal
  autosave. Candidates (active products not on the dealer) come from
  `getAdditionalProductCandidates`; `addAdditionalProduct` creates the flagged line. They flow
  through Monthly approval / summary / product plan / reports via their entries.
- **Create Dealer.** `createMonthlyDealer` reuses the **existing Dealer model** with lifecycle
  metadata (`status="PENDING_APPROVAL"`, `createdFrom="MONTHLY_PLAN"`, `createdByUserId`) and adds
  a `PlanDealer` flagged **`fromMonthlyPlan`** (its monthly home; excluded from seasonal views). A
  new dealer starts with zero seasonal products and is built entirely from Additional Products,
  badged **NEW DEALER**.
- **After approval.** On FINAL approval, `approveMonthlyPlan` activates each pending
  monthly-created dealer (`status=ACTIVE`) and permanently assigns it to the officer via the
  existing `applyDealerAssignment` — so it then flows into future Seasonal Planning, Recovery,
  Sales Upload matching, Reports and Dealer lists with no manual reassignment.
- **Dealer Alias coverage.** The Dealer Alias page adds filters (All / With / Without / SO
  Created / Pending) with counts and an inline **Add Alias**, reusing the same `DealerAlias`
  model/matcher. (Full `/reports` fact-engine badges are the remaining follow-up; monthly
  product/dealer views already badge additional/new.)

## 2g. Dealer creation & lifecycle (unified)

Dealers are created from two places into the **same `Dealer` model / lifecycle** (no parallel
system, no schema change — `status`/`createdFrom`/`createdByUserId`/`isActive` already exist):

- **Monthly Planning (Sales Officer)** — `createMonthlyDealer` → `status=PENDING_APPROVAL`,
  `createdFrom=MONTHLY_PLAN`, `PlanDealer.fromMonthlyPlan`. Visible ONLY in that officer's monthly
  plan until approval. Editable (same dialog, Edit mode → `updateMonthlyDealer`) while the plan is
  DRAFT/RETURNED; read-only after submit.
- **Admin (User Details page)** — `createDealerForOfficer` → `status=ACTIVE`, `createdFrom=ADMIN`,
  immediate `applyDealerAssignment` + first `DealerAlias` (from the name). No approval. Reuses the
  same service/dialog; `assignExistingDealer` is the "assign existing" shortcut.
- **Approval** (`approveMonthlyPlan`, unchanged workflow) — on FINAL approval the pending dealer
  becomes `ACTIVE`, gets a permanent `DealerAssignment`, and its first `DealerAlias`.
- **Reject** (`rejectMonthlyPlan`) — the plan's monthly-created dealers become `status=REJECTED,
  isActive=false` (terminal); no permanently-pending strays. **Return** keeps them PENDING/editable.

**Matching is ACTIVE-only (single rule).** `loadDealerResolver` and `findProbableDealers` filter
`status="ACTIVE"`, and Sales Upload's plan query filters `dealer.status="ACTIVE"` — so Pending and
Rejected dealers never participate in the alias resolver, Sales Upload, Recovery, fuzzy matching,
seasonal planning or reports. Seasonal views already exclude `fromMonthlyPlan`/`isAdditional`;
`getMonthlyPlan` hides REJECTED dealers.

**Duplicate protection.** Both create paths first run `findProbableDealers` (Alias → exact
tightKey → loose → fuzzy≥0.6 over ACTIVE dealers). Matches return a **"Possible Existing Dealer"**
step in the shared `DealerFormDialog` (Cancel / Create-anyway `force` / Admin "Assign existing")
instead of silently duplicating.

## 2h. User & Organization Management

Extends the existing `User`/`Dealer`/`DealerAssignment`/auth — no parallel systems.

- **Soft delete everywhere.** `User.deletedAt` and `Dealer.deletedAt` (+ `isActive`) — nothing is
  hard-deleted, so all plans/approvals/audit/uploads keep referencing the rows. Deactivate =
  `isActive:false`; Delete = `isActive:false + deletedAt`.
- **Auth (reused `requireAuth`).** Every request re-verifies the DB user: exists, `!deletedAt`,
  `isActive` — so deactivate/delete take effect immediately even for a live JWT. **Session
  invalidation**: `User.sessionValidAfter` is bumped on password reset/change and deactivation;
  `requireAuth` rejects any session whose JWT `iat` predates it (login also blocks deleted users).
- **Passwords (reused bcrypt).** Admin `resetUserPassword` (no old password); self
  `changeOwnPassword` (old + confirm) at `/account`. Both bump `sessionValidAfter`.
- **User Groups.** `UserGroup` + `User.groupId` (one officer ↔ one group, no join table). The flat
  Users page is replaced by `UsersManagement` — **Group View | All Users** toggle. Group View =
  cards + create + members (add from the Unassigned pool, remove → Unassigned); All Users = server-
  filtered list (Active/Inactive/Deleted/All) with inline Reset/Deactivate/Delete. Officer profile
  gains the same admin toolbar + Create Dealer.
- **Dealer management.** `editDealer` (all fields + alias), `deactivate/activate/deleteDealer`
  (soft). Visibility is **server-side**: Monthly/Seasonal/Recovery dealer queries filter
  `dealer.isActive:true`, and the ACTIVE-only matcher (§2g) already covers Sales Upload/Recovery/
  fuzzy — so deactivated/deleted dealers vanish from all planning/selectors while history remains.
- **Audit.** Reused `writeAudit` (action union extended with `DELETE`) logs password reset/change,
  user activate/deactivate/delete, group create/edit/add/remove, and dealer activate/deactivate/
  delete/edit.

## 3. Data-consistency model

All screens read the same stored inputs (pack quantities, monthly plan/sale qty) and the
same rate/NBV% source (`rateSnapshot ?? product.rate`, `nbvPercentSnapshot ?? product.nbvPercent`),
so figures match by construction. **Intentional scope difference:** Reports / Dashboards /
Product-Dealer Summary include only `APPROVED` + `isActiveVersion` plans (`computeFacts`),
whereas Seasonal/Monthly/Workbook View show the specific plan regardless of status. A DRAFT
plan therefore appears in Workbook View but contributes 0 to Reports until approved — expected.

## 4. Manual vs Imported plans

Both build the identical entity graph `SeasonPlan → PlanDealer → PlanLine → PlanLinePack`
(+ `MonthlyEntry.planQty` for Complete-Workbook import). `source` (`MANUAL`/`IMPORT`) is the
only business-data difference; the rest of the app has no import-specific code path.

**Known structural difference (reported):** manual `createSalesPlan` scaffolds a line for
*every active product* per dealer (including zeros); import creates lines only for products
present in the workbook. Both are valid; downstream code filters to qty>0 so numbers are
unaffected. See §Recommendations.

## 5. Approval — one code path

`finalizeApproval(tx, plan)` (private) / `finalizeApprovalTx` (exported) is the single
routine that snapshots Rate/NBV%, supersedes the prior active version of the same
`planningType`, and activates the version. Used by:
- Normal flow: `approvePlan` (Super Admin final step).
- Migration: `commitSeasonalImport` when `importAsApproved` is set (Super-Admin-only import).

**Monthly plans** run the same `PlanStatus` state machine and routing but do **not** call
`finalizeApproval` (no rate snapshot / versioning — the parent seasonal plan owns those); see
§2c. The status transitions, approver checks and notifications mirror `submitPlan`/`approvePlan`
exactly, so there is one conceptual approval workflow, not two.

## 6. Permissions

| Actor | Plans visible | Editable |
|---|---|---|
| Sales Officer | own (scope via `getOfficerScope` / `assertOfficerInScope`) | own seasonal packs (`saveLines`), own monthly plan + actual sale qty (`saveMonthly`), own **MonthlyPlan** create/edit/submit, **request** month extensions |
| Regional Manager | officers under them (read) | none — but **approves/returns/rejects** submitted seasonal and monthly plans of officers under them |
| Super Admin | all | manual actuals, create on behalf, import, Import-as-Approved, final approve (seasonal + monthly), **decide** month extension requests |

**Monthly Plan & extension APIs** (all under `/api/planning`, guarded by the same
`requireAuth` + service-layer scope/role checks): `monthly-plans` (GET list, POST create),
`monthly-plans/:id` (GET detail, PATCH save), `monthly-plans/:id/{submit,recall,approve,return,
reject,history}`, `season-plans/:id/months`, `season-plans/:id/approved-monthly`,
`month-extensions` (GET list, POST request), `month-extensions/:id/decide`.

## 7. Query patterns (no N+1)

- `getWorkbook`: one `seasonPlan.findUnique` with nested `dealers → lines → {product, packs, monthlyEntries}` + one `seasonMonth.findMany` = **2 queries**.
- `getPlanDetail`: one nested `findUnique` + active pack sizes = **2 queries**.
- `computeFacts` (reports): one nested `findMany` + one `rmAssignment.findMany` = **2 queries**.

No per-row queries anywhere in these paths.

## 8. Dynamic months

Month count/order always come from `seasonMonth.findMany(orderBy: order)`. Import maps
detected "QTY" columns to season months by order, truncated to the season's month count.
No literal month-count assumption exists in planning/import/reports code.

## Company Onboarding (orchestration layer)

`src/features/onboarding/` is a **source-agnostic orchestrator**, not a business layer:

- `excel-adapter.server.ts` → `extractExcelMasters(buffer, filename)` yields `OnboardingMasters`
  (products from PRICELIST, dealer names, officer from filename, season hint). Future CSV/ERP/API/
  Manual adapters implement the same shape.
- `service.server.ts` → `analyzeOnboarding` (read-only preflight: exists/missing counts) and
  `commitOnboarding` (idempotent master upserts → `applyDealerAssignment` → find/create season →
  **reuse `commitSeasonalImport`** for the plan → write `OnboardingRecord`). It creates *records*
  (products/dealers/pack sizes) but contains **no calculation or planning business logic** — the plan
  is built entirely by the existing seasonal importer, and prices/NBV come from the Product master.
- Routes: `/api/onboarding/{analyze,commit,history}`.

**Matching** is centralized in `src/lib/match-key.ts` — the ONE matcher for the whole app:
`tightKey` (strip all non-alphanumerics), `looseKey` (collapse to spaces), `similarity` (fuzzy),
`decorate` (precompute keys), and `matchByName` (tightKey exact → looseKey exact → optional fuzzy).
**All four importers use it** — Seasonal Import, Company Onboarding, Dealer Import and Product Price
Import — and none define their own `norm`/`levenshtein`/`similarity` any more. So `25ML`/`25 ML`/
`25-ML` resolve to one pack size, and `SHOOT OUT`/`SHOOT-OUT` to one product, everywhere.

**Season creation** has a single owner: `seasons/service.server.ts`. `findOrCreateSeason` (idempotent)
is reused by Company Onboarding; `createSeason` is the manual path. Onboarding no longer creates
seasons directly. Onboarding routes enforce the `onboarding` RBAC resource
(`requirePermission("onboarding", …)`), and every run is a permanent `OnboardingRecord` surfaced on
the **Onboarding History** page with JSON/CSV report download.

**Idempotency/atomicity:** masters upsert (re-runnable, no duplicates); the plan is created in the
seasonal importer's single transaction. `OnboardingRecord` stores the migration report (JSON).

## Recommendations before the next module

1. **Import line scaffolding (optional):** to make manual and imported plans byte-identical,
   have import also create zero-qty lines for all active products per dealer (or, conversely,
   have manual creation lazily create lines). Low urgency — no numeric impact today.
2. **Workbook payload scoping:** `getWorkbook` loads all dealers' lines even though it renders
   one dealer. For very large workbooks, scope the `dealers`/`lines` include to the selected
   dealer (keep the lightweight dealer list separately). Not N+1; a payload-size optimisation.
3. **Reports NBV inversion:** the `saleValue / nbvPercent` inverse for NBV-mode actuals is the
   one arithmetic expression not wrapped in a named helper (mirrors `figuresForMode`); consider
   a `amountFromNbv(nbv, nbvPercent)` helper if a third caller appears.
