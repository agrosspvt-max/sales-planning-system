# Sales Planning System

A web application that digitizes the company's Excel-based seasonal sales planning
process. It implements the full Version 1 scope: authentication and role-based
access, master data (products, pack sizes, categories, brands, dealers, users,
seasons), time-aware dealer/RM assignments, **dealer-first seasonal planning** on a
configurable pack-size model, **monthly planning** with manual actual sales and
over-plan warnings, an auto-routed **approval workflow** with revisions and price
snapshots, **reports** (with sorting, drill-down and Excel export), role
**dashboards**, **announcements**, in-app **notifications**, **audit logs**, and
**global search**.

> The authoritative business specification is **`PROJECT_SPECIFICATION.md` (v4.4)**,
> which is the single source of truth for all workflow, calculations, permissions,
> approvals, planning, pack sizes, revisions, snapshots, and reports.

## Tech stack

Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui-style components ·
React Query · Prisma ORM · PostgreSQL · Zod · Auth.js (NextAuth v5) ·
ExcelJS (report `.xlsx` export) · SheetJS `xlsx` (workbook import parsing).
Single monolith — no microservices, Redis, queues, or other enterprise complexity.

## Prerequisites

- Node.js 20+ (tested with Node 22)
- A running PostgreSQL 14+ instance

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#   - set DATABASE_URL to your local PostgreSQL
#   - set AUTH_SECRET   (openssl rand -base64 32)

# 3. Generate the Prisma client
npm run prisma:generate

# 4. Create the database schema
npm run prisma:migrate       # name the first migration e.g. "init"

# 5. Seed sample data (users, products, dealers, one season, assignments)
npm run db:seed

# 6. Run the app
npm run dev                  # http://localhost:3000
```

> If you obtained this folder with a partially-installed `node_modules`
> (e.g. copied from a synced drive), run `rm -rf node_modules && npm install`
> for a clean install.

## Seed logins

All seeded users share the password **`Password123!`**.

| Username    | Role             |
|-------------|------------------|
| `admin`     | Super Admin      |
| `rm_north`  | Regional Manager |
| `rm_south`  | Regional Manager |
| `so_rahul`  | Sales Officer    |
| `so_amit`   | Sales Officer    |
| `so_suresh` | Sales Officer    |
| `so_priya`  | Sales Officer    |
| `so_vikram` | Sales Officer    |

## Scripts

| Script                  | Purpose                              |
|-------------------------|--------------------------------------|
| `npm run dev`           | Start the dev server                 |
| `npm run build`         | Production build                     |
| `npm run typecheck`     | `tsc --noEmit`                       |
| `npm run lint`          | ESLint                               |
| `npm run prisma:generate` | Generate the Prisma client         |
| `npm run prisma:migrate`  | Create/apply a dev migration       |
| `npm run prisma:studio`   | Open Prisma Studio                 |
| `npm run db:seed`         | Seed sample data                   |

## Project structure

```
src/
├─ app/
│  ├─ (dashboard)/            # Authenticated app shell + pages
│  │  ├─ dashboard/
│  │  ├─ masters/[resource]/  # Generic master-data CRUD screens
│  │  ├─ seasons/
│  │  └─ assignments/{dealers,rm}/
│  ├─ api/                    # Route handlers (self-guarded by RBAC)
│  ├─ login/
│  ├─ layout.tsx
│  └─ providers.tsx
├─ auth.config.ts            # Edge-safe auth config (middleware)
├─ auth.ts                   # Full Auth.js instance (credentials)
├─ middleware.ts             # Route protection
├─ components/
│  ├─ ui/                    # Reusable primitives (button, table, dialog…)
│  └─ layout/                # App shell, sidebar, breadcrumbs
├─ features/
│  ├─ resources/             # Reusable CRUD engine (config + service + UI)
│  ├─ assignments/           # Dealer/RM assignment module
│  ├─ seasons/               # Season module
│  ├─ planning/              # Seasonal + monthly planning, approvals, revisions
│  ├─ reports/               # Report aggregation, params, sorting, drill-down
│  ├─ dashboard/             # Role dashboards
│  ├─ announcements/         # Announcement viewer + read status
│  ├─ notifications/         # In-app notifications + bell
│  ├─ audit/                 # Audit log viewer
│  ├─ search/                # Global search
│  └─ navigation/            # Role-based nav
├─ lib/
│  ├─ calc.ts                # Central calculation engine (§17 / §36.8)
│  ├─ export/report-xlsx.ts  # Excel export (independent of report logic)
│  └─ …                      # prisma, rbac, http, scope, audit, pagination, utils
└─ types/                    # next-auth type augmentation
prisma/
├─ schema.prisma
└─ seed.ts
```

## Reports & Excel export

Reports are computed **live** from approved plans and actual sales — no report
values are stored. Available reports: Product, Brand, Category, Dealer, Sales
Officer, Regional Manager, Company, Seasonal and Monthly summaries.

- **Filtering:** pick a report type and season; results are always permission-scoped.
- **Sorting:** click any column header to sort (server-side, so the on-screen table
  and the export always match).
- **Drill-down:** click a row to descend the hierarchy
  **Company → Regional Manager → Sales Officer → Dealer → Product** (Brand/Category
  drill to Product). A breadcrumb shows the path and lets you climb back.
- **Excel export:** the **Export to Excel** button downloads exactly what is visible
  after the current filters, drill-down and sorting. Each file includes the report
  title, season, generated date/time, applied filters, a totals row, and proper
  number/currency/percentage formatting with auto-sized columns.

The export lives in `src/lib/export/report-xlsx.ts` and consumes the same
`ReportPayload` the report service produces, so **CSV or PDF exporters can be added
later without changing any report/calculation logic**. (PDF is intentionally not
part of Version 1.)

**Dependency:** Excel export uses [`exceljs`](https://www.npmjs.com/package/exceljs)
(`4.4.0`). It is the only dependency added for this feature — run `npm install`
after pulling these changes.

## Import wizards (Masters → admin only)

Two setup/onboarding importers accelerate initial data entry. Both parse files
**in memory** (nothing is stored) and commit in **one transaction** (all-or-nothing).
They reuse the existing Users, Dealers, Assignments and Product services — no new
tables and no duplicated business logic.

**Dealer Import Wizard** (`Masters → Dealer Import Wizard`)
- Upload a Sales Officer's planning workbook (`.xlsx` / `.xls`).
- Each worksheet becomes a dealer; choose which sheets to ignore (first three —
  PRICELIST, Product Plan, Dealer Summary — default to ignored).
- The Sales Officer is auto-detected from the filename (e.g.
  `(Rahul Patidar-Hoshangabad Harda)` → "Rahul Patidar") and matched to an existing
  user, or a new Sales Officer can be created (default password `Password123!`).
- Bulk-assign all/selected dealers to a Sales Officer, or pick a Regional Manager and
  assign to officers under them. Dealers always store a **Dealer → Sales Officer**
  link; the RM column is derived read-only (the schema is unchanged).

**Product Price Import** (`Masters → Product Price Import`)
- Upload a full workbook or a standalone PRICELIST sheet.
- Columns are **auto-detected by header name** and shown in a mapping step you can
  edit. Product Name is required; Technical, Rate, NBV are mapped when present;
  **Brand/Category/Pack Size are optional** and never overwrite existing values when
  unmapped. NBV accepts a percent (`18`) or a fraction (`0.18`).
- Preview shows New / Update / Duplicate / Missing / Invalid per row (with existing →
  new values), and lets you edit before importing. For existing products, **only the
  mapped fields are updated**. The last successful mapping is remembered per
  header structure.

**Production features (both wizards):**
- **Rich preview** — dealers show Current SO / Current RM / New SO / Derived RM and an
  auto-computed Action (Create / No Change / Reassign / Skipped); prices highlight only
  the fields that actually changed (Rate/NBV old → new).
- **Fuzzy duplicate detection** — near-matches ("Sai Agro" vs "Sai Agro KSK Rehti") are
  flagged as **Possible Duplicate** with a confidence %, and the admin chooses Create /
  Merge with existing / Skip (never auto-merged).
- **Safe reassignment** — reassigning a dealer that belongs to another officer is shown
  with a warning and counted separately; nothing moves silently. If a reassigned dealer
  already has **operational data** (Season Plans, Monthly Plans, Actual Sales or Approval
  History), a prominent confirmation dialog summarizes that history before commit —
  historical records stay attributed to the current officer, only future ownership moves.
  It is advisory, never a block.
- **Officer detection** scans the filename plus the PRICELIST / Product Plan / Dealer
  Summary sheets for labels (Sales Officer, Officer Name, Representative, …) and offers
  all candidates.
- **Validate Only** runs all validations, duplicate/conflict detection, and the full
  summary **without writing** anything.
- **New officer creation** collects full name, username (auto if blank), phone, email, RM
  and a temporary password (auto-generated or manual); credentials can be copied after import.
- **Pack-size safety** — pack sizes are **never created silently**; unknown pack sizes are
  listed and the admin chooses Create / Ignore / Map to existing.
- **Import History** (`Masters → Import History`) — a metadata-only audit record per run
  (date, user, workbook, counts, status). The uploaded workbook is never stored.

**Dependencies & migration:** import parsing uses [`xlsx`](https://www.npmjs.com/package/xlsx)
(SheetJS, `0.18.5`) so both `.xlsx` and `.xls` are supported — run `npm install` after
pulling. These enhancements add a migration: nullable `phone`/`email` on `User` and the
`DealerImportRecord` table (import history). Run `npm run prisma:migrate`.

## Open-Month control

Monthly planning follows the workbook's real process — one month at a time. Each `SeasonMonth` has a
status: **LOCKED** (not yet opened), **OPEN** (management opened it for entry), **CLOSED** (read-only
again). Only an **OPEN** month accepts monthly plan-quantity and actual-sales entry; the rule lives in
one place (`src/features/planning/planning-state*`) and is enforced at a single point in
`saveMonthly` — no scattered checks. Super Admin opens/closes/reopens months from *Seasons → Manage
months*; the Monthly Planner shows each month's status and disables entry when not open. Reports,
approvals and imports are unaffected (imports write monthly data directly, bypassing the gate for
migration). New seasons **auto-open their first month** (locking the rest); imported seasons also
auto-open months that received imported plan data; existing seasons default to OPEN (no regression).
Dashboards show the **Current Planning Month** for operational visibility.

**Migration:** adds `SeasonMonth.status` (default `OPEN`). Run `npx prisma migrate dev`.

## Company Onboarding (migrate from Excel)

*Company Onboarding* (`/onboarding`, Super Admin only) is the first-run setup that brings an
organization's existing data into the app. Upload a completed planning workbook → the wizard
**analyzes** it (detects pack sizes, products from PRICELIST, dealers, the Sales Officer from the
filename, and proposes the season) → you **confirm** the season period and optionally *Import as
Approved* → it **migrates**: idempotent upserts for the masters, then it reuses the lightweight
*Import Seasonal Plan* to create the Sales Plan (packs + monthly), and writes a downloadable
**migration report** to onboarding history.

It is **source-agnostic**: Excel is the first adapter; CSV/ERP/API/Manual adapters implement the same
`OnboardingMasters` shape and feed the same orchestrator. The orchestrator only sequences existing
services — no master or planning business logic is duplicated. Matching is whitespace/punctuation/
case-insensitive (`25ML` = `25 ML` = `25-ML`) via `src/lib/match-key.ts`.

**Migration:** adds the `OnboardingRecord` table. Note the schema also has pending planning/season
columns from earlier work — run `npx prisma migrate dev` once so the DB matches `schema.prisma`
(without this, Season creation and onboarding fail).

## Planning workflow — Create Plan & View Plans

Planning is organised around the business lifecycle as **two primary workspaces** in the sidebar,
with **Import Seasonal Plan** and **Approvals** as independent items:

```
Planning
 ├── Create Plan   → work-in-progress (Draft) plans
 └── View Plans    → approved plans (read-only)
Import Seasonal Plan   (Super Admin)
Approvals              (RM / Super Admin)
```

Both workspaces open on **module cards** (Sales Planning functional; Recovery / Scheme / Party show
**Coming Soon** — they are modules here, not sidebar items). Inside **Sales Planning** a
**Create Plan | View Plans** toggle is the primary navigation, with **Seasonal / Monthly / Yearly**
type tabs beneath it. **Create Plan** lists only editable plans (`DRAFT` / `RETURNED` / `REJECTED`);
**View Plans** lists only `APPROVED` plans. Nothing new was added to the plan schema for this — the
split is a status filter over the existing plan list.

**Seasonal create dialog** asks only **Season** (Kharif / Rabi / Zaid), **Year**, **Start Month**,
**End Month**. A Super Admin additionally chooses the **Sales Officer** (Single / Multiple / All);
a Sales Officer plans for themselves. The season is resolved by the shared `findOrCreateSeason`, then
one draft is created (or the existing draft **reopened**) per officer via the existing
`createSalesPlan` — a Sales Officer may hold only **one** Seasonal plan per Season + Year, and a
rejected plan reopens the same draft (never a duplicate). A single-officer create opens the new Draft
workspace immediately (Dealer Plan tab, autosave on).

### Seasonal Draft workspace

Tabs: **Dealer Plan · Product Plan · Dealer Summary · History** (Monthly and the old Workbook View are
not here — Monthly is a separate post-approval lifecycle).

- **Dealer Plan** — the only editable page. Per-dealer grid; every edit autosaves.
- **Product Plan** — read-only Excel "Product Plan" sheet: pack quantities, Total Qty/Amount, Planned
  NBV, Actual Qty/Amount/NBV, with a **TOTAL** footer.
- **Dealer Summary** — read-only Excel "Dealer Summary" sheet: Sales Plan/NBV, Live Month Plan/NBV,
  Actual Sales/NBV, Sales & NBV Achievement %, with **TOTALS**.

Dealer Plan, Product Plan and Dealer Summary share one **`PlanEditProvider`** (live state) — editing a
quantity recomputes Product Plan and Dealer Summary **instantly, without a refresh**. All figures come
from the one `lib/calc` engine (no duplicated calculations). Submission and approval reuse the existing
workflow; once approved the plan moves to **View Plans** and its screens become read-only.

### Monthly Planning lifecycle (post-approval)

Monthly Planning is a **separate workspace**, reachable from an **approved, active** seasonal plan
(`/planning/[id]/monthly`). It **reuses the existing monthly lifecycle** — months are `LOCKED` /
`OPEN` / `CLOSED` via Season month management; there is **no separate monthly draft/submit/approval
engine**. Tabs: **Dealer Monthly Plan** (editable; last two columns are **Planned Amount** and
**Planned NBV**) · **Monthly Product Plan** · **Monthly Dealer Summary** (both read-only, live via a
`MonthlyEditProvider`, with **TOTAL** rows). The monthly summaries support month filters — **Season
Total / Till Current Month / Selected Months / Custom Range** — which change only the displayed
aggregation, never stored data. (Seasonal Product Plan / Dealer Summary remain season totals by
design; the seasonal DTO has no per-month breakdown and was not expanded.)

### Admin vs Sales Officer

Both roles use the **same screens**. A Sales Officer sees only their own drafts/approved plans (no
officer selector). A Super Admin gets one extra **Sales Officer** filter on the lists (All / any
officer) and may create drafts on behalf of any officer — everything else is identical (reuses the
existing scope helpers and permissions).

New plan fields are additive: `SeasonPlan.planningType` (default `SEASONAL`), `versionName`,
`description`, `source` (`MANUAL`/`IMPORT`); the version unique key includes `planningType`.

**Import Seasonal Plan** (*Sales Planning → Import Seasonal Plan*, Super Admin only) loads the
company's completed Excel workbook into a Season Plan instead of re-keying it. Upload → choose
Season & Sales Officer (auto-detected from the filename when possible) → preview → validate →
import. It skips Price List / Product Plan / Dealer Summary, reads every dealer sheet, matches
dealer/product/pack size to existing masters (unmatched rows are shown and skipped, never invented),
and commits the whole plan in **one transaction** as an ordinary draft `SeasonPlan` (`source=IMPORT`)
— so approvals, monthly planning, reports and history treat it exactly like a manual plan. Each run
writes a `SeasonPlanImportRecord` (imported by, time, workbook name, season, officer, counts,
status); the workbook is never stored. Parsing reuses the shared SheetJS reader (`.xlsx`/`.xls`).

**Migration:** adds `SeasonPlan.planningType`/`versionName`/`description`/`source`, changes the
`SeasonPlan` unique key to include `planningType`, and adds the `SeasonPlanImportRecord` table. Run
`npm run prisma:migrate`.

> **Note (workflow refactor):** the standalone **Workbook View**, **Product Summary** and **Dealer
> Summary** planning screens were replaced by the in-plan **Product Plan** / **Dealer Summary** tabs
> above; their old routes (`/planning/sales/{workbook,product-summary,dealer-summary}`) now redirect
> to View Plans, and cross-plan analysis remains under **Reports** (same Reports engine, no duplicated
> aggregation). Corrected metrics are unchanged: **Pending = Target − Actual**, **Season-vs-Month =
> Target − Monthly Planned**. Manual and imported plans behave identically.

**Import Seasonal Plan** now offers two modes — *Seasonal Only* (packs) and *Complete Workbook* (packs +
existing monthly plan quantities) — plus an optional **Import as Approved** (authorised users) that runs
the same approval finalisation as a normal approval. Import is a migration tool; **Create Sales Plan** is
the primary workflow. No schema migration for this step.

Plan management (view, continue draft, duplicate, delete draft, approve, history) lives on the
**Create Plan** / **View Plans** lists and the plan workspace described above — Create Plan for
editable drafts, View Plans for approved plans, with a Super Admin **Sales Officer** filter. A
"Manual/Imported" badge is the only visible difference between the two sources. Everything reuses the
existing `listPlans` query and the draft `DELETE` / `duplicate` endpoints. No migration.

## Seasons (period-based creation)

A season is created from a **period**, not a hand-typed month list. The admin enters a **Name**
and **Start month + year → End month + year**; the app **auto-generates** the `SeasonMonth` rows
in order, spanning year boundaries (e.g. *Dec 2026 → Mar 2027* ⇒ December, January, February,
March). A live **preview** shows exactly which months will be created, validated as: End ≥ Start,
**1–12 months**, no duplicates. Seasonal and Monthly planning modes are shown too, prefilled from
the global default and stored on the season.

A season becomes **locked** once it holds any operational data (any Season Plan — draft or later,
monthly plans, actual sales, or approval history): its **period and planning modes are frozen**
(rename is still allowed), enforced on both client and server so historical seasons are never
altered. The Seasons list shows **Season · Period · Seasonal Mode · Monthly Mode · Status**.

The **Monthly Planning** tab stays visible before the seasonal plan is approved and shows a clear
locked message plus the workflow (*Seasonal Planning → Submit for Approval → Approved → Monthly
Planning Opens → Actual Sales*) instead of being a dead disabled tab. Availability itself is
unchanged — monthly planning still opens only after approval.

**Migration:** adds nullable `Season.startMonth`/`startYear`/`endMonth`/`endYear`; `SeasonMonth` is
reused unchanged; existing seasons stay valid (the Period column falls back to their month list).
Run `npm run prisma:migrate`.

## Planning Configuration (Masters → admin only)

By default the planning grids are **Pack Size** based. *Master Data → Planning Configuration*
(Super Admin only) lets you choose, **independently** for **Seasonal** and **Monthly** planning,
what Sales Officers enter:

- **Pack Size** — a quantity per configured pack size (current behaviour).
- **Total Quantity** — one Total Quantity per product (no pack columns).
- **Amount** — a planned Amount per product (NBV derived).
- **NBV** — a planned NBV per product (Amount derived when NBV % is known).

These global settings are the **default only**. **Each season stores its own Seasonal and Monthly
modes**, prefilled from the default when the season is created (editable on the New Season screen)
and fixed afterwards. Planning, monthly planning, approvals and reports always use the **season's**
modes — so changing the default here never affects existing seasons or historical reports. A
pre-existing season migrates to Pack Size.

The planning and monthly screens re-render to match the season's mode, and reports/exports compare
the values available in that mode. All mode math is centralized in `src/lib/calc.ts`
(`figuresForMode`) — no duplicated business logic. Amount/NBV modes intentionally leave quantity
blank rather than inventing fractional pack counts.

**Migration:** this feature adds `Season.seasonalMode`/`monthlyMode` (default `PACK_SIZE`) plus
nullable `PlanLine.inputMode`/`inputValue` and `MonthlyEntry.inputMode`/`planValue`/`saleValue`.
Existing Pack-Size data stays valid. Run `npm run prisma:migrate`.

## Notes

- **Master data** is managed only by the Super Admin; Sales Officers and Regional
  Managers are read-only consumers (per the specification).
- **Assignments** use explicit from–to date ranges; reassigning closes the current
  range and opens a new one, preserving history.
- **Permissions** are enforced server-side on every API route (never UI-only), and
  planning data is scoped by officer/RM hierarchy.
- Records are **deactivated, never hard-deleted** (except keyed system settings).
- **Calculations are centralized** in `src/lib/calc.ts` (total = sum of per-pack
  quantities; amount = qty × rate; NBV = amount × NBV%). Reports, dashboards and the
  planning UI all use it — no duplicated business math.
- **Pack sizes** are a configurable master; the planning grid renders one column per
  active pack size. Approved plans **snapshot** rate/NBV%, so historical figures
  never change when master prices are later edited.
- **Over-planning** in monthly planning is allowed and highlighted, never blocked.
- Running `npm run prisma:migrate` applies the full schema, including the planning
  tables (`PackSize`, `PlanLinePack`, versioned `SeasonPlan`, `MonthlyEntry`, …) and
  the notification tables (`Notification`, `AnnouncementReadStatus`).
