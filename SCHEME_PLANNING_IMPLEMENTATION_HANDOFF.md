# Scheme Planning — Implementation Handoff

> **Status of the working tree at the time this document was written:** all Scheme Planning
> Phase-2/3 work is **implemented but uncommitted** on branch `main`, on top of commit
> `1289ba8`. Nothing in this batch has been committed or pushed. See §20 for the exact `git status`.

---

## 1. Purpose of this document

This is a self-contained handoff for the **next coding agent** who will continue the Scheme
Planning module of this application. It assumes **no knowledge of any prior conversation**. Its job
is to describe the module **as the current code actually implements it** — not as it was originally
specified, and not as any earlier plan imagined it.

Read this whole document before touching code. Then, before you rely on any single statement here,
**re-verify it against the repository** using §2. Code is the source of truth; this document is a map,
and maps go stale.

Three things this document is careful about, and you should be too:

1. It distinguishes **what is implemented in code** from **what is planned but not built** and from
   **business decisions** that shaped the implementation.
2. Where the original written requirements and the current code **disagree**, it says so openly (see
   §4, §8, §9 in particular) rather than pretending they match.
3. It marks the parts of the codebase that are **deliberately left untouched** and must stay that
   way unless you are explicitly told otherwise (see §11, §18).

Every claim below was checked against the working tree described in §20. Each section that makes a
factual claim points at the file and, where useful, the line so you can confirm it yourself.

### Legend used throughout

Each significant claim is tagged so you know how much to trust it and what to do with it:

- **[IMPLEMENTED]** — confirmed present in the current code.
- **[UNCHANGED]** — pre-existing behaviour this batch deliberately did not modify.
- **[DECISION]** — a business/product decision made during this work that explains why the code is
  shaped the way it is.
- **[NOT IMPLEMENTED]** — a requirement that is *not* in the code yet.
- **[DISCREPANCY]** — a place where the written brief and the current code do not line up; read the
  note carefully.
- **[FLAGGED — NOT FIXED]** — a known oddity that was intentionally left alone; do not "fix" it
  without establishing the intended behaviour first.

---

## 2. How to verify this document against the code

Do this first. It takes two minutes and it is the difference between trusting a stale map and
knowing the ground truth.

```bash
# Where are we, and what is uncommitted?
git rev-parse --abbrev-ref HEAD          # expect: main
git log --oneline -1                     # expect: 1289ba8 Scheme Planning Phase 2/3 ...
git status --short                       # the modified + untracked set in §20
git diff --stat                          # size of the tracked-file changes

# The scheme module lives in these places:
ls src/features/schemes/                 # feature components + server services
ls src/app/api/scheme-plans/ src/app/api/scheme-follow-up/ src/app/api/schemes/
ls "src/app/(dashboard)/planning/scheme/"   # the three route pages
sed -n '73,240p' prisma/schema.prisma    # the six scheme models
sed -n '1017,1090p' prisma/schema.prisma # the scheme enums
```

**Authoritative type check** (this is the check that actually works in a clean checkout):

```bash
npm run typecheck        # = tsc --noEmit ; expect exit 0
```

**Do not claim the production build passed unless you actually ran it and it succeeded.** `npm run
build` runs `prisma generate` first; in some sandboxes that step cannot fetch the query-engine and
aborts before Next.js ever runs. That is an environment limitation, **not** a code error, and it is
**not** evidence that the build is broken. If you cannot run `npm run build`, say so plainly; do not
substitute a weaker check and imply it was the build. A working ESLint substitute on specific files:

```bash
ESLINT_USE_FLAT_CONFIG=false npx eslint <files>
```

`tsconfig.tsbuildinfo` is tracked and is rewritten on every `tsc` run, so it will always show as
modified after a type check. Ignore it; do not try to "fix" it or revert it selectively.

---

## 3. Overall structure — navigation and routes, per role

Scheme Planning is one module reached from the Planning area. The whole module is gated by an
environment flag; when it is off, each route renders a "Coming Soon" placeholder.

- **`SCHEME_PLANNING_ENABLED`** — code default is **off**; `.env.example` ships it as `"true"`. When
  off, every scheme route page renders `<SchemePlanningComingSoon />`
  (`src/features/schemes/scheme-coming-soon.tsx`).

There are **three routes**, all under `src/app/(dashboard)/planning/scheme/`:

| Route | Page component | Meaning |
|---|---|---|
| `/planning/scheme` | `SchemePlanningPage` | **Create Plan** |
| `/planning/scheme/plans` | `SchemeViewPlansPage` | **View Plan** |
| `/planning/scheme/follow-up` | `SchemeFollowUpPage` | **Follow-up Plans** |

All three page components live in `src/features/schemes/scheme-planning-page.tsx` except the
Follow-up view, which is in `scheme-follow-up-view.tsx`. **[IMPLEMENTED]**

### Role branching (verified in `scheme-planning-page.tsx`)

**`/planning/scheme` — Create Plan** (`SchemePlanningPage`, line 55):

- **Sales Officer** → `SchemeOfficerWorkspace` (`scheme-officer-workspace.tsx`), which renders the
  **new** collapsible Create Plan workspace (§8).
- **Super Admin** → `SchemeAdminCreatePlan` (line 75): the existing **Scheme Master** page reused in
  place, **plus** a read-only "Planned Dealers by Scheme" panel beneath it (§10).
- **Regional Manager** → `SchemeReviewWorkspace` (the review/approve workspace; RM also has a
  "Running Schemes" create tab inside it — §14).

**`/planning/scheme/plans` — View Plan** (`SchemeViewPlansPage`, line 96):

- **Sales Officer** → `SchemeOfficerViewPlan` (`scheme-view-plan.tsx`): tabs **Scheme-wise /
  Dealer-wise / Enrolled Scheme**.
- **Regional Manager** and **Super Admin** → `SchemeReviewWorkspace`. Only the chrome differs: RM
  keeps its 2-item bar and pills; Admin is presented with a `[Create Plan | View Plan | Follow-up
  Plans]` bar and `[Scheme-wise | Dealer-wise | Enrolled Scheme]` tabs where **Scheme-wise is the
  org-wide review table**.

**`/planning/scheme/follow-up` — Follow-up Plans** (`SchemeFollowUpPage`): the read-only recovery
report, `[Scheme Follow-up | Dealer Follow-up]` (§6).

The mode bar (`SchemeManagerModeLinks`, defined in `scheme-follow-up-view.tsx`) renders 3 items for
Admin and the original 2 for RM. The module picker at `/planning/create` still links only to
`/planning/scheme` for every role; the mode bar is how you reach View Plan and Follow-up.
`src/features/navigation/route-parents.ts` maps both `/planning/scheme/plans` and
`/planning/scheme/follow-up` back to `/planning/view` for breadcrumbs. **[IMPLEMENTED]**

---

## 4. Requirement 1 — View Plan (Scheme-wise) and the seven-column summary

This section needs a **[DISCREPANCY]** notice up front, because the brief and the code do not agree
on whether the seven-column list is visible.

### What the brief described

A Sales Officer **Scheme-wise List View** with seven columns:

1. **Scheme Name**
2. **Dealers Planned**
3. **No. of Schemes**
4. **Approved Schemes**
5. **Unverified Conversions**
6. **Verified Conversions**
7. **Billed Schemes**

with the counting rule that **columns 3–6 use `SUM(numberOfSchemes)`**, while **Billed Schemes uses
actual billed instance rows**, and a zero-denominator rule (render an em dash when there is nothing
to divide by).

### What the code actually does now — [DISCREPANCY]

The **server-side aggregate that computes those seven columns still exists and is correct**, but the
**List View that displayed them has been removed from the UI** (see §7, the toggle removal). As a
result:

- The Sales Officer's Scheme-wise view is now the **collapsible view only** (§5). Its parent rows are
  deliberately minimal — scheme name, "N Dealers", and a Continue Planning / View button — and do
  **not** render the seven aggregate columns.
- `schemeWiseSummary()` in `scheme-planning.server.ts` (lines 248–285) and the route
  `src/app/api/scheme-plans/scheme-summary/route.ts` are therefore **orphaned but deliberately kept**
  — nothing in the UI calls the route. `grep -rn "scheme-summary" src` returns only the route's own
  definition. They were left in place because the brief that removed the toggle forbade altering
  APIs. **[FLAGGED — NOT FIXED]**

So: the seven-column definition below is **accurate about the server code**, but you will **not** see
those columns anywhere in the running app today. If a future requirement wants them back, the
aggregate is ready to wire to a UI; nothing needs recomputing.

### The counting rules, exactly as implemented (`schemeWiseSummary`, lines 196–285)

Everything except **Dealers Planned** is counted in **scheme units**, never dealers. One
`DealerSchemePlan` represents `numberOfSchemes` units, and approval / conversion / verification all
live as columns on the **plan** (not on the instance), so a plan's state applies to all N of its
units.

- **Dealers Planned** = plan count for the scheme (`row.dealersPlanned += 1`). Because the model is
  unique on `(schemeId, dealerId)`, one plan = one dealer.
- **No. of Schemes** = `Σ numberOfSchemes` over every plan in scope (`row.totalSchemes += units`,
  where `units = numberOfSchemes || 1`).
- **Approved Schemes** = `Σ numberOfSchemes` where `planStatus === APPROVED`.
- **Unverified Conversions** = `Σ numberOfSchemes` where `schemeStatus === CONVERTED` **and**
  `adminVerifiedAt == null`.
- **Verified Conversions** = `Σ numberOfSchemes` where `schemeStatus === CONVERTED` **and**
  `adminVerifiedAt != null`.
- **Billed Schemes** = for each verified-converted plan, `min(count of that plan's
  DealerSchemeInstance rows that carry an adminBillingDate, numberOfSchemes)`, summed. This is the
  helper `billedInstanceUnits` (lines 238–239).

### Why Billed Schemes is instance-based — [DECISION]

Billing is the **one** thing stored per **instance** rather than on the plan. A **legacy** plan
carries only Instance 1 even when `numberOfSchemes > 1` (see §16, the legacy rule). If a legacy plan
with `numberOfSchemes = 3` has its single Instance 1 billed, that is evidence of exactly **one**
billed unit, not three. Counting `SUM(numberOfSchemes)` there would claim billing the data cannot
support. So Billed Schemes counts **actual billed instance rows** (numerator), clamped to the plan's
`numberOfSchemes` (denominator stays in units for consistency with the columns above). On a fully
expanded new-flow plan both rules give the same number; they diverge only on legacy plans — which is
exactly where the plan-level rule would lie. Worked example: `numberOfSchemes = 3`, one billed
instance, verified + converted ⇒ **1 / 3**. **[DECISION]**

### Zero-denominator rule

The em-dash-when-nothing-due rule was a **client-side rendering concern of the removed List View
component** (the `Ratio` helper). Since that component was deleted with the toggle, the em-dash logic
is **not present anywhere in the current UI**. The server aggregate returns raw counts; it does not
format ratios. If you re-introduce a view over `schemeWiseSummary`, you must re-implement the
em-dash-on-zero-denominator behaviour there. **[DISCREPANCY]**

---

## 5. The Collapsible View change (card → parent-row / chevron / nested table)

**[IMPLEMENTED].** The Scheme-wise collapsible view was restructured from an earlier card layout
onto the app's shared **parent-row / chevron / nested-table** pattern, so it matches the other two
collapsible tables in the module (`SchemeReviewWorkspace`, `EnrolledSchemesView`).

The pattern, defined once in `src/features/schemes/scheme-table-theme.ts` (the `schemeTable` object):

- `schemeTable.outer` wraps the table.
- Each scheme is a **parent `TableRow`** carrying `schemeTable.parentRow` (+ `parentRowOpen` when
  expanded) and a **chevron cell** (`ChevronDown` when open, `ChevronRight` when closed).
- When expanded, a **sibling `TableRow`** whose single `colSpan` cell carries `schemeTable.nestedCell`
  → `nestedInset` → `nestedShell` → a nested `Table` of that scheme's dealers.
- State is `expanded: Set<string>` with a **copy-on-write** toggle; **collapsed by default**; never
  persisted.
- Action cells stop propagation (`onClick={(e) => e.stopPropagation()}`) so clicking a button does
  not toggle the row.

The Sales Officer's parent row is deliberately minimal **[DECISION]**: scheme name, "N Dealers", and
the **Continue Planning / View** button (the label is "Continue Planning" when the scheme has any
`DRAFT`/`RETURNED` plan, otherwise "View"). No status summaries or unit totals on the parent row.
The nested table shows, per dealer: Dealer, Planned Conversion, Schemes, Total Amount, Planning Date,
Plan Status, Scheme Status, plus four "verify-tint" conversion columns. This lives in
`scheme-view-plan.tsx` (`SchemeWiseCollapsibleView`).

Crucially, the **Continue Planning / View** button opens `SchemePlanningView` (the original
per-scheme dealer-selection screen), which is left untouched — see §11.

---

## 6. Requirement 3 — Follow-up Plans (business decisions, verified against code)

**[IMPLEMENTED]** in `src/features/schemes/scheme-follow-up.server.ts` (service),
`scheme-follow-up-view.tsx` (UI), and the routes under `src/app/api/scheme-follow-up/`. This is a
**strictly read-only** recovery report over **enrolled** scheme plans. Every rule below was checked
against the service; where the code does something you might not expect, it is called out as
**[FLAGGED — NOT FIXED]** rather than hidden.

The business rules, as the code implements them:

1. **Row scope** — `enrollmentStatus = ENROLLED` plans only, inside the caller's officer scope
   (`loadPlans`, line 197). Every enrolled dealer with a position by period end is listed, including
   fully settled ones.
2. **Month/Week is a financial snapshot (a cutoff), not an "activity in this period" filter.** A
   dealer with an unpaid March installment still appears when August is selected (`resolveWindows`).
3. **Total Due** = `Σ plannedAmount` where `plannedDate ≤ dueCutoff`, and `dueCutoff = min(period
   end, today)` — "due till date" (lines 130, 304–307).
4. **Total Paid** = `Σ receivedAmount` where `receivedDate ≤ period end`, **plus** the Admin-confirmed
   booking amount, which is **dateless** (counted in every cumulative snapshot, never in the
   Month/Week Actual columns). A `receivedAmount` with a null `receivedDate` follows the same dateless
   rule (lines 310–312, 327).
5. **Only Admin-confirmed money counts.** `adminBookingAmount` is used, never the SO-entered
   `soBookingAmount` (line 257). `receivedAmount` is Admin-only by construction (the installment
   update endpoint is gated to Super Admin). Booking does **not** increase Total Due — the
   installment schedule already represents the full scheme value.
6. **Pending** = `max(Total Due − Total Paid, 0)`. **Pending %** = `Pending ÷ Total Due`, or **null**
   (rendered as an em dash) when Total Due = 0 (lines 328, 336).
7. **Month Due/Actual** = the selected calendar month's own range; **Week Due/Actual** = the selected
   business week's range; both null (em dash) under All months / All weeks (lines 337–340).
8. **Scheme Amount is instance-based**: `Σ schemeValueWithGST × (instances that exist)` — NOT
   `numberOfSchemes` (lines 424, 508). A legacy plan keeps only Instance 1 even when `numberOfSchemes
   > 1`, so a unit-based amount would exceed any rupee the schedule can account for.
9. **Missing installment rows are computed in memory, never written.** Where an instance has no
   persisted installments, the schedule is derived with `derivedInstallmentSchedule` +
   `resolveInstanceBillingDate` (lines 239–248) — the very functions the persisting path uses — so
   opening a report can never create rows. (This is why `enrolledSchemeDetail`, which mutates on read,
   was deliberately **not** reused.)
10. **Business weeks** reuse the app's single definition (`businessWeekDayRange`, `BUSINESS_WEEK_COUNT`
    from `recovery/service.server.ts`): W1 = 1–7, W2 = 8–14, W3 = 15–22, W4 = 23–end of month. There
    is never a Week 5.
11. **Ordering** is pending-first (`recoveryOrder`, lines 430–431): rows needing recovery surface at
    the top, then by pending amount descending, then by name.
12. **Sharing** = a `wa.me` deep link built from `Dealer.mobile` plus a copy-to-clipboard fallback. No
    WhatsApp API, no server-side messaging. **Export** = the app's existing server-side ExcelJS
    convention (`buildReportXlsx`), in `src/app/api/scheme-follow-up/export/route.ts`.
13. **Structural** — nothing inside View Plans was renamed or moved to build Follow-up. Role scope is
    enforced server-side by `getOfficerScope` (Admin = all, SO = own, RM = own + team SOs); the
    browser never filters for security.

### Two Follow-up behaviours FLAGGED, deliberately not changed — [FLAGGED — NOT FIXED]

1. **With a week selected, the Month Due / Month Actual columns still describe the whole month.** The
   month window (`w.month`) is the full calendar month regardless of the selected week, so those two
   columns can include amounts dated after the week-end snapshot while the cumulative Total Due /
   Total Paid stop at the week end (lines 320–321). Whether this is desired was never established.
2. **Status is receipt-count based.** `positionStatus(total, received, overdue)` (lines 286–292)
   counts installment **rows** that have *any* received amount; it does not compare rupees. So a row
   can read "Completed" while Pending > 0 — e.g. a part-paid installment, or a receipt dated after the
   snapshot. This mirrors the existing Enrolled Scheme vocabulary on purpose; changing it would alter
   that established vocabulary.

If a future request seems to contradict any rule above, **ask** rather than adjusting the maths —
these are settled product decisions, not accidents.

> **Note on `data.totals`:** the service still computes a `totals` figure set (`sumFigures`), and the
> Excel export uses it. But after the toggle removal (§7) **no totals row is rendered in the
> Follow-up UI** — the `totals` field on `DealerList`/`SchemeList` is defined in the view's types but
> not displayed. This is intentional, not a bug. **[FLAGGED — NOT FIXED]**

---

## 7. Removal of the List / Collapsible toggle — where it was applied

**[IMPLEMENTED].** An earlier iteration of the module offered a **List View ↔ Collapsible View**
toggle in the Scheme-wise and Follow-up views. That toggle was **removed**, and the module now
renders the **collapsible view directly** in the affected places.

**Verify exactly where this was applied — do not assume it was applied everywhere.** It was applied
in **two files**:

- `src/features/schemes/scheme-view-plan.tsx` — the SO **View Plan → Scheme-wise** view. The
  List/Collapsible pill nav and the `SchemeWiseListView` component (plus its `Ratio` helper) were
  deleted; the collapsible view is now the only Scheme-wise view.
- `src/features/schemes/scheme-follow-up-view.tsx` — **Follow-up → Scheme** and **Follow-up →
  Dealer**. Both list views (`SchemeListView`, `DealerListView`) and both pill navs were deleted; the
  collapsible view is the only view. This is also why the totals footer row disappeared from Follow-up
  (§6 note).

Consequences of the removal, all deliberate **[FLAGGED — NOT FIXED]**:

- `schemeWiseSummary()` + `/api/scheme-plans/scheme-summary` are **orphaned but kept** (§4). The
  seven aggregate columns are not visible anywhere in the UI.
- A `hideStatus` prop on the Follow-up `MoneyCells` helper became unreachable; it was left in place
  because the brief fenced off the collapsible view's shared helpers.

The `SchemeReviewWorkspace` (RM/Admin) has **always** been collapsible-only and never had a toggle;
it was not part of this change. Do **not** reintroduce a List/Collapsible toggle anywhere.

---

## 8. Create Plan — the CURRENT state (read this before §9)

**[IMPLEMENTED] — and this is the single most important correction in this document.**

The original handoff brief for this document was written expecting that the **Create Plan redesign
had not yet been built**, and asked this section to "clearly state that the new Create Plan redesign
has NOT yet been implemented unless the current code proves otherwise." **The current code proves
otherwise: the redesign IS implemented.** So this section documents it as built, and §9 flags the
stale framing. **[DISCREPANCY]**

The Create Plan workspace is now the component
`src/features/schemes/scheme-create-plan.tsx` → `SchemeCreatePlanWorkspace(...)`. It replaces the
earlier per-scheme "View Scheme" drill-down. What it does, as implemented:

- The running schemes are presented as **one collapsible scheme → dealers table** (the `schemeTable`
  pattern from §5). Each scheme is a parent row; expanding it shows that scheme's planned dealers.
- The per-row action is **Add Dealer** (a "Choose Dealer" modal that adds **one dealer at a time**;
  the modal's options are the officer's assigned dealers minus those already taken/planned).
- Scheme information moved to a per-row **⋮ menu → Info / View Document / Share** (§13). Opening the
  menu or the Info dialog issues **no network request** — important, because every scheme *read* path
  triggers `refreshSchemeStatuses()`, which is a write (see §18).
- **Save Draft** and **Submit** are **per scheme, inside the expanded row** (§12), not page-wide.
- **Document viewing** decodes the base64 `data:` URL to a **Blob URL shown in an `<iframe>`**
  (browsers block top-level navigation to a `data:` URL). No new storage mechanism was introduced.
- **Share** uses the Web Share API with a `File` when `navigator.canShare({files})` is available, else
  `share({title, text})`, else the app's `wa.me` + copy dialog. A deep link cannot attach the file,
  and the UI says so.

The component takes three props and is reused for all three roles:
`SchemeCreatePlanWorkspace({ enableRmScope = false, readOnly = false, userId })`.

- **Sales Officer** — `scheme-officer-workspace.tsx` line 49 renders `<SchemeCreatePlanWorkspace />`
  (own scope).
- **Regional Manager** — `scheme-planning-page.tsx` line 240 renders `<SchemeCreatePlanWorkspace
  enableRmScope userId={userId} />` inside the RM "Running Schemes" tab. RM scope covers **My Dealers**
  (self) and **My Team** (a chosen team SO).
- **Super Admin** — `scheme-planning-page.tsx` line 84 renders `<SchemeCreatePlanWorkspace readOnly
  />` (org-wide, read-only) beneath Scheme Master (§10).

**No schema change and no migration were needed.** `DealerSchemePlan` is unique on `(schemeId,
dealerId)` and already carries a per-dealer `planStatus`, so dealer-level Draft / Submitted / Returned
required nothing new (§16).

Two consequences worth knowing **[FLAGGED — NOT FIXED]**:

- `RunningSchemesTab` in `scheme-officer-workspace.tsx` is now **unreferenced but deliberately kept**
  (doc-commented as such). It was not deleted.
- The old large "Select Dealers" table survives **only** via SO View Plans → Continue Planning
  (`SchemePlanningView`); it is no longer the primary dealer-selection UI. See §11.

---

## 9. The "next Create Plan requirement" — status

The brief asked this section to describe a **future/next** Create Plan requirement and to "clearly
state that this is a FUTURE/NEXT requirement unless it has actually already been implemented."

**[DISCREPANCY] / [IMPLEMENTED].** The redesign the brief treated as "next / not yet built" is the
very one described in §8, and it **has already been implemented** in this uncommitted batch. There is
therefore **no separate, still-unbuilt Create Plan requirement** captured in the code or in this
session's work beyond what §8 documents.

In other words: if you were told "the Create Plan redesign is the next thing to build," that
instruction is **stale** — it was built. Confirm against §8 and the file
`scheme-create-plan.tsx` before you start any Create Plan work, so you do not rebuild something that
already exists. Genuinely unbuilt future work is collected separately in §22.

---

## 10. Admin Create Plan — the decision

**[DECISION] + [IMPLEMENTED].** For a **Super Admin**, "creating a plan" means **authoring the scheme
itself**, not planning dealers into it. So the Admin `/planning/scheme` (Create Plan) page renders:

1. The **existing Scheme Master** page (`SchemeMasterPage`), **reused** in place — not copied. Every
   scheme behaviour (create, edit, Open/Closed + State filters, close/reopen, the installment-rule
   builder, the Enrolled Scheme pill) comes from that one component, which remains the single source
   of truth and stays reachable from its own `/masters/schemes` route. Only a `crumbs` and a `nav`
   prop are passed so it reads as part of Scheme Planning (`scheme-master-page.tsx` gained those two
   **optional, presentational** props; `/masters/schemes` renders identically).
2. Beneath it, a **read-only** "Planned Dealers by Scheme" panel: `<SchemeCreatePlanWorkspace
   readOnly />`. An Admin can see who has been planned into each running scheme and reach Info / View
   Document / Share, but gets **no Add Dealer** and **no Save Draft / Submit**.

**A Regional Manager must NOT be given Admin Scheme-Master authority.** RM was deliberately left
unchanged (§14): RM has no Create Plan / Scheme Master section at all — the page returns Forbidden and
the service enforces `assertAdmin`. Do not "unify" RM and Admin here.

---

## 11. `SchemePlanningView` must remain untouched

**[UNCHANGED] — treat this as a hard constraint.** `SchemePlanningView` (in
`scheme-officer-workspace.tsx`) is the original per-scheme screen with the full **Select Dealers**
table. Even though Create Plan no longer uses it as the primary flow (§8), it is **still reached** from
SO **View Plans → Scheme-wise → Continue Planning / View** (`scheme-view-plan.tsx` opens it when a
scheme is selected for planning).

Rules:

- **Do not delete `SchemePlanningView`.**
- **Do not strip its Select Dealers table** or otherwise change its behaviour.
- `scheme-officer-workspace.tsx` still exports `toDateInput`, `SchemePlanMode`, `MODE_LINKS`,
  `SchemePlanModeLinks`, `RunningSchemesTab`, and `SchemePlanningView`. Keep those exports.

If you need a new dealer-selection experience, build it alongside — do not repurpose this component.

---

## 12. Save / Submit is per-scheme, not page-wide

**[IMPLEMENTED] + [DECISION].** In the new Create Plan workspace, **Save Draft** and **Submit** act on
**one scheme's** working set (the dealers inside that scheme's expanded row), not on the whole page.
The busy state is keyed per scheme (`save.variables?.schemeId`) so acting on one scheme does not lock
the others.

Both actions call the **same single mutation**, hitting one of two existing endpoints:

- `POST /api/scheme-plans/save-draft` → `saveSchemeDraft` → `persistDraft(ctx, raw, submit=false)`
- `POST /api/scheme-plans/submit-draft` → `submitSchemeDraft` → `persistDraft(ctx, raw, submit=true)`

**Partial submission** is the important behaviour here (`persistDraft`, lines 704–786, with
`draftSchema.submitDealerIds` at line 683):

- The payload carries `{ schemeId, officerId?, dealers: [...], submitDealerIds? }`.
- On **submit**, `submitDealerIds` may name a **subset** of `dealers` to actually send forward.
  Everyone else in the working set is still **persisted as Draft** — never discarded, never submitted.
- Only the dealers **going forward** must be complete (have a Conversion Date); incomplete ones stay
  Draft (line 741). If a submit names a dealer not in the payload, or names none, it is a 422.
- Omitting `submitDealerIds` preserves the original **all-or-nothing** behaviour, so older callers are
  unaffected.
- Per-dealer status resolution: a Sales Officer's forwarded dealer goes to `PENDING_RM`
  (legacy `SUBMITTED`); a Regional Manager **is** the approver, so an RM-forwarded dealer skips RM
  review and goes straight to `PENDING_APPROVAL` (legacy `RM_APPROVED`). Non-forwarded dealers are
  written as `DRAFT` (lines 753–755).
- De-selected editable rows are removed (`toRemove`, line 777); **incomplete-but-present dealers are
  in `selected`, so they are NOT deleted** — the reason partial submit is safe.

The UI splits the editable rows into complete / incomplete and, when any are incomplete, shows a
confirmation dialog (`IncompleteSubmitDialog`) before submitting the complete subset.

---

## 13. The shared DropdownMenu primitive

**[IMPLEMENTED].** `src/components/ui/dropdown-menu.tsx` is a **thin wrapper around the installed
`@radix-ui/react-dropdown-menu`**, mirroring the existing `dialog.tsx` convention. It exports only
`DropdownMenu` (Root), `DropdownMenuTrigger`, `DropdownMenuContent` (Portal, `align="end"`,
`sideOffset={4}`), and `DropdownMenuItem`. It is intentionally minimal — Root / Trigger / Content /
Item only — and is used by the per-row **⋮** menu in the Create Plan workspace (§8). Do not expand it
into a full menu kit unless a real need appears; keep it thin.

---

## 14. Role / scope matrix

Scheme routes use `requireAuth()` plus **in-service role checks**, not `requirePermission` — the
`schemePlanning` RBAC entry is effectively dead. Data scope is always enforced **server-side** by
`getOfficerScope` (and, for planning, `resolveTargetOfficer`); the browser never filters for security.
**[UNCHANGED]**

| | **Sales Officer** | **Regional Manager** | **Super Admin** |
|---|---|---|---|
| **`/planning/scheme` (Create Plan)** | `SchemeCreatePlanWorkspace` — own dealers, full edit (Add Dealer, per-scheme Save/Submit) | `SchemeReviewWorkspace` with a "Running Schemes" create tab → `SchemeCreatePlanWorkspace enableRmScope` (My Dealers / My Team) | **Scheme Master** (author schemes) + `SchemeCreatePlanWorkspace readOnly` panel |
| **`/planning/scheme/plans` (View Plan)** | `SchemeOfficerViewPlan` — Scheme-wise / Dealer-wise / Enrolled | `SchemeReviewWorkspace` — approve / return / reject own team's plans | `SchemeReviewWorkspace` — org-wide; Scheme-wise / Dealer-wise / Enrolled tabs; verify + delete |
| **`/planning/scheme/follow-up`** | Follow-up (own scope) | Follow-up (own + team) | Follow-up (all) |
| **Data scope** | own plans (`salesOfficerId = self`) | self + the SOs in the RM's group | all |
| **Plan submission target** | dealer → `PENDING_RM` | own/team dealer → `PENDING_APPROVAL` (skips RM review) | n/a (Admin authors + verifies, does not plan) |
| **Scheme Master authority** | none | **none** (Forbidden + `assertAdmin`) | full |
| **Scheme deletion** | none | none | Super Admin only (`assertAdmin`, §17) |

Regional Manager behaviour was **deliberately not changed** in this batch (`[DECISION]`): RM keeps its
2-item `[Scheme Planning | Follow-up Plans]` bar and the Review · Running Schemes · Enrolled Scheme
pills. Both RM and Admin share the one `SchemeReviewWorkspace` component; only its chrome is
role-shaped (`isAdmin`), driven by the single `view` state (`review | running | enrolled | dealer`).

---

## 15. Important file map

"Modified?" is relative to committed `HEAD` (`1289ba8`). "Sensitive?" flags files where a careless
edit does real damage. All of this is uncommitted (§20).

### Server / services

| File | What it does | Modified? | Sensitive? | Depends on |
|---|---|---|---|---|
| `src/features/schemes/scheme-planning.server.ts` | Core planning service: `listSchemePlans`, `schemeWiseSummary` (§4), `runningSchemes`, `persistDraft` (§12), `ensureInstances` / `expandInstances` (§16 legacy rule) | **Modified** (+165) | **Yes** — instance/legacy rules and partial-submit live here | `@/lib/prisma`, `@/lib/scope`, `@/lib/http`, `@/lib/audit` |
| `src/features/schemes/scheme-follow-up.server.ts` | Read-only Follow-up recovery aggregation (§6, §18) | **New** | **Yes** — must never write; money maths | `scheme-enrolled.server.ts` (derive helpers), `recovery/service.server.ts` |
| `src/features/schemes/scheme-master.server.ts` | Scheme CRUD + close/reopen + `deleteScheme` / `getSchemeDeletionImpact` (§17) | Unchanged | **Yes** — permanent deletion | `@/lib/prisma`, `@/lib/audit` |
| `src/features/schemes/scheme-enrolled.server.ts` | Enrolled Scheme layer; exported `derivedInstallmentSchedule` + `resolveInstanceBillingDate` for Follow-up | **Modified** (+45, export-only extractions) | Yes — `enrolledSchemeDetail` mutates on read; do not call it from read-only paths | `@/lib/prisma` |
| `src/features/recovery/service.server.ts` | Recovery module; exported `businessWeekDayRange` + `BUSINESS_WEEK_COUNT` reused by Follow-up | **Modified** (+9, export-only) | No | — |

### Client / feature components

| File | What it does | Modified? | Sensitive? |
|---|---|---|---|
| `src/features/schemes/scheme-create-plan.tsx` | The new collapsible Create Plan workspace (§8) | **New** | Yes — the primary new UI; no-request-on-expand rule (§18) |
| `src/features/schemes/scheme-view-plan.tsx` | SO View Plan (Scheme-wise collapsible §5, Dealer-wise placeholder, Enrolled); opens `SchemePlanningView`; `ConversionModal` | **New** | Yes — must not be modified per §11/§19 constraints |
| `src/features/schemes/scheme-follow-up-view.tsx` | Follow-up UI + `SchemeManagerModeLinks` mode bar | **New** | Medium |
| `src/features/schemes/scheme-officer-workspace.tsx` | SO shell → renders new workspace; still hosts the untouched `SchemePlanningView` and the kept-but-unused `RunningSchemesTab` | **Modified** (256 lines churn) | **Yes** — §11 |
| `src/features/schemes/scheme-planning-page.tsx` | Role branching for Create Plan + View Plan; `SchemeReviewWorkspace`; `SchemeAdminCreatePlan` | **Modified** (+130) | Yes |
| `src/features/schemes/scheme-master-page.tsx` | Scheme Master; gained optional `crumbs`/`nav` props for reuse (§10) | **Modified** (+15) | Medium — `/masters/schemes` must stay identical |
| `src/components/ui/dropdown-menu.tsx` | Thin Radix dropdown wrapper (§13) | **New** | No |
| `src/features/navigation/route-parents.ts` | Breadcrumb parents for the two new routes | **Modified** (+2) | No |

### Routes (App Router)

| Path | Purpose | Modified? |
|---|---|---|
| `src/app/(dashboard)/planning/scheme/page.tsx` | Create Plan page (`SchemePlanningPage`), flag-gated | Unchanged |
| `src/app/(dashboard)/planning/scheme/plans/page.tsx` | View Plan page (`SchemeViewPlansPage`), flag-gated | **New** |
| `src/app/(dashboard)/planning/scheme/follow-up/page.tsx` | Follow-up page (`SchemeFollowUpPage`), flag-gated | **New** |
| `src/app/api/scheme-plans/save-draft/route.ts` · `submit-draft/route.ts` | Per-scheme Save / Submit (§12) | Unchanged (call the extended `persistDraft`) |
| `src/app/api/scheme-plans/scheme-summary/route.ts` | Seven-column aggregate — **orphaned** (§4, §7) | **New but unused** |
| `src/app/api/scheme-follow-up/{dealers,dealers/[dealerId],schemes,export}/route.ts` | Follow-up data + ExcelJS export (§6) | **New** |

---

## 16. Database / schema models

No schema change and no migration were made in this batch (§8). All **39 migrations are already
applied to the production Neon database**; the DB is in sync with `schema.prisma`. **Do not run
`prisma migrate dev/deploy`, `db push`, `reset`, or `seed`.**

The scheme subsystem is six models (`prisma/schema.prisma` lines 73–227):

- **`Scheme`** (line 73) — the incentive definition: `schemeName`, `isPerpetual`, `startDate` /
  `endDate` / `bookingLastDate`, `schemeValueWithoutGST` / `schemeValueWithGST` / `bookingAmount`
  (Decimal 14,2), `schemeBenefit` (enum), `benefitDetails` / `otherBenefitDetails`,
  `allowMultipleSchemes`, `documentUrl` (a base64 `data:` URL — see §8 viewing note),
  `status` (`OPEN`/`CLOSED`). Children: `states`, `installmentRules`, `dealerPlans`.
- **`SchemeInstallmentRule`** (line 104) — payout schedule, max 10; one `calculationType`
  (`PERCENTAGE` sums to 100, `FIXED_AMOUNT` sums to the With-GST value); `daysAfterBillingDate`.
  Unique `(schemeId, installmentNumber)`.
- **`DealerSchemePlan`** (line 120) — one dealer planned into one scheme; **unique `(schemeId,
  dealerId)`**. Carries **two independent tracks**:
  - *Planning approval* — `planStatus` (`SchemePlanState`: `DRAFT → PENDING_RM → PENDING_APPROVAL →
    APPROVED`, plus `RETURNED`, `REJECTED`). `EDITABLE = {DRAFT, RETURNED}`. A legacy `planningStatus`
    (`SchemePlanStatus`) is **dual-written** during migration (it has no `APPROVED` member, so
    admin-approve writes `RM_APPROVED`).
  - *Conversion → verification → enrollment* — `schemeStatus` (`SchemeConversionStatus`), SO fields
    (`soBookingStatus`/`soBookingAmount`/`soDocumentStatus`/`billingDate`) and the authoritative
    `admin*` fields written at verification (`adminBookingAmount`, `adminBillingDate`,
    `adminVerifiedAt`, …). `enrollmentStatus` (`SchemeEnrollmentStatus`: `PENDING_DOCUMENT` →
    `ENROLLED`). `numberOfSchemes` (multi-scheme count) and `totalSchemeAmount`.
- **`DealerSchemeInstance`** (line 181) — one occurrence of the scheme for that dealer; owns its own
  `soBillingDate` / `adminBillingDate` and installment schedule. Unique `(dealerSchemePlanId,
  instanceNumber)`. This is what makes multi-scheme dealers first-class without duplicating plan rows.
- **`DealerSchemeInstallment`** (line 199) — per-instance installment; `plannedAmount`/`plannedDate`
  (SO/RM/Admin-editable), `receivedAmount`/`receivedDate` (**Admin-only**), `status` string
  (`PENDING`/`RECEIVED`; **`OVERDUE` is derived on read, never stored**). Unique `(instanceId,
  installmentNumber)`. This is the **leaf** — nothing references it.
- **`SchemeState`** (line 219) — join to `UserGroup` publishing a scheme to a State. Composite id
  `(schemeId, groupId)`; **both** FKs `onDelete: Cascade`.

The chain `Scheme → DealerSchemePlan → DealerSchemeInstance → DealerSchemeInstallment` is **all
`onDelete: Cascade`**.

### The legacy rule — do NOT break this (verified in `scheme-planning.server.ts`)

There is **no legacy boolean flag**. The distinction is made by **which function you call**:

- **`ensureInstances(planId)`** (line 411) guarantees **Instance 1 only** and never reads
  `numberOfSchemes`. Used by the read / verify / enrolled paths.
- **`expandInstances(planId)`** (line 428) is the **only** place `numberOfSchemes` becomes a count. It
  is called from exactly one site: `persistDraft` (line 782, the SO/RM planning save). It refuses
  ENROLLED plans and prunes surplus instances only while `DRAFT`/`RETURNED`.

Why it matters: on legacy plans `numberOfSchemes` was an **amount multiplier, not a schedule count**.
If a read path expanded a legacy `numberOfSchemes = 3` plan, it would gain Instances 2–3 and then
fabricate two extra installment schedules on top of real payment history — **merely reading a record
would corrupt its financials**. Never add expansion to a read/verify/enrolled path.

Enum name traps (three enums share value names — never grep blindly): `SchemeSoDocStatus`
(`SIGNED_BUT_NOT_SENT | SIGNED_AND_SENT | DOC_RECEIVED`), `SchemeBookingStatus` (`RECEIVED |
NOT_RECEIVED | PARTIAL`), `SchemeAdminDocStatus` (`RECEIVED_SOFT | RECEIVED_HARD | NOT_RECEIVED`).

---

## 17. Scheme deletion — safety graph

**[UNCHANGED]** — this was built in `HEAD` and not modified this batch, but you must understand it.
`DELETE /api/schemes/[id]` (+ `GET /api/schemes/[id]/deletion-impact`) is **Super Admin only**
(`assertAdmin`), requires a reason **≥ 10 characters** validated on **both** client and server, and
runs one interactive transaction (`deleteScheme`, `scheme-master.server.ts` lines 187–231).

The deletion boundary is **closed** and was exhaustively verified. Inbound FKs form a closed subtree:

```
Scheme ──cascade──┬── SchemeState              (also cascades from UserGroup)
                  ├── SchemeInstallmentRule
                  └── DealerSchemePlan ──cascade── DealerSchemeInstance ──cascade── DealerSchemeInstallment (leaf)
```

The transaction deletes **explicitly, bottom-up** — installments → instances → plans → installment
rules → scheme states → scheme (lines 209–214) — even though the cascades alone would suffice. The
explicit order exists so the boundary is auditable and the counts are real. Then, **on the same
transaction**, it writes an audit row with action `SCHEME_PERMANENTLY_DELETED` carrying
`{ schemeName, reason, actor, counts, deletedAt }` (lines 218–227).

Verified facts you can rely on (re-verify only if a change adds a model, an FK, a `Json` column, or
raw SQL):

- **Preserved:** every shared master — `User`, `Dealer`, `UserGroup`, `Product`. None is a child of
  `Scheme`; the `RESTRICT` FKs all run child→parent, so they restrict deleting a *Dealer or User*,
  never a plan or scheme.
- **The one id that outlives deletion:** `AuditLog.entityId` has **no FK** and there is no
  delete/update path for `AuditLog` in `src/` — it is append-only in practice, an intentional
  string-based historical reference. Plan/instance/installment audit ids become unresolvable
  post-delete, by design.
- The whole schema has **zero `Json` columns, zero scalar arrays, zero raw SQL, and zero DB
  views/triggers/functions.** Every Prisma access to the four plan-family models lives in exactly
  three files: `scheme-master.server.ts`, `scheme-planning.server.ts`, `scheme-enrolled.server.ts`.

Three items **FLAGGED — NOT FIXED** (confirmed behaviour, intent not established):

1. `deleteGroup` (`users/groups.server.ts`) hard-deletes a `UserGroup`, and `SchemeState.groupId` is
   `onDelete: Cascade`, so deleting a group silently un-publishes schemes from that state, with no
   impact preview and no audit of what went.
2. `adminVerifiedById` has **no FK**, while its siblings `rmActedById` / `enrolledById` both got
   `ON DELETE SET NULL`. The asymmetry may be deliberate.
3. The `SCHEME_PERMANENTLY_DELETED` audit keeps only aggregate counts — per-dealer financial history
   is unrecoverable. A retention-policy question.

**Do not test permanent deletion against production.**

---

## 18. Follow-up and Create Plan read-safety

**[IMPLEMENTED] — a correctness constraint, not a style preference.**

Two write-triggers in the read layer make "read safety" a real concern:

1. **`refreshSchemeStatuses()` is a WRITE** (`updateMany`) and is invoked by **every scheme read path**
   (`runningSchemes`, `planningContext`, `listSchemes`, `getScheme`). This is why, in the Create Plan
   workspace (§8), **expanding a scheme row and opening the ⋮ Info dialog must issue no network
   request** — the data needed for Info is already loaded up front. If you add a fetch on expand/Info,
   you turn a passive UI gesture into a database write storm.
2. **`ensureInstances` / `expandInstances` / `ensureInstanceInstallments` create or expand rows.** The
   Follow-up service (§6) is **strictly read-only** and must **never** call any of them. It derives
   missing schedules in memory with `derivedInstallmentSchedule` + `resolveInstanceBillingDate`
   instead. Do not "simplify" it by reusing `enrolledSchemeDetail`, which **mutates on read**. Opening,
   filtering, expanding, downloading, or sharing a Follow-up report must never create an instance or an
   installment row, or touch a billing date.

If you extend either surface, keep this invariant. A quick way to prove read-only behaviour locally is
a strict Proxy `prisma` stub that throws on any unexpected `model.method` (see §19).

---

## 19. Testing / verification

Be honest about what was and was not run. **Do not claim a build passed if it did not.**

- **`npm run typecheck` (= `tsc --noEmit`) → exit 0.** This is the authoritative static check for
  this work and it passes on the current tree.
- **`npm run build` was not run to completion in this environment.** It starts with `prisma generate`,
  which cannot fetch the query engine in the sandbox and aborts before Next.js compiles. That is an
  **environment limitation, not a code error** — and it is **not** proof that the app builds. If you
  can run `npm run build` in a proper environment, do, and report the real result.
- **ESLint** works as a per-file substitute: `ESLINT_USE_FLAT_CONFIG=false npx eslint <files>`.
- Server modules **can** be runtime-tested here without a database by emitting to CommonJS and
  stubbing `@/lib/*`; a strict Proxy `prisma` stub doubles as a read-only proof (used on the Follow-up
  service). Worth doing whenever money maths changes.
- `tsconfig.tsbuildinfo` always shows modified after a type check — ignore it.

What has **not** been done: no end-to-end/browser testing, no test against the production database, no
new automated test files. There is no scheme-module unit-test suite in the repo.

---

## 20. Git state (do not modify)

Branch `main`, HEAD `1289ba8` *"Scheme Planning Phase 2/3: multi-scheme instances, SO doc enum,
per-instance billing, scheme delete"*, up to date with `origin/main`. **Everything below is
uncommitted.** Do **not** commit, push, stash, reset, restore, or checkout anything unless explicitly
asked.

**Tracked, modified** (`git diff --stat`):

```
 src/features/navigation/route-parents.ts          |   2 +
 src/features/recovery/service.server.ts           |   9 +
 src/features/schemes/scheme-enrolled.server.ts    |  45 +++-
 src/features/schemes/scheme-master-page.tsx       |  15 +-
 src/features/schemes/scheme-officer-workspace.tsx | 256 +++++-----------------
 src/features/schemes/scheme-planning-page.tsx     | 130 +++++++++--
 src/features/schemes/scheme-planning.server.ts    | 165 +++++++++++++-
 tsconfig.tsbuildinfo                              |   2 +-
```

(`tsconfig.tsbuildinfo` is a build artifact — see §19.)

**Untracked (new):**

```
src/app/(dashboard)/planning/scheme/follow-up/page.tsx
src/app/(dashboard)/planning/scheme/plans/page.tsx
src/app/api/scheme-follow-up/dealers/[dealerId]/route.ts
src/app/api/scheme-follow-up/dealers/route.ts
src/app/api/scheme-follow-up/export/route.ts
src/app/api/scheme-follow-up/schemes/route.ts
src/app/api/scheme-plans/scheme-summary/route.ts
src/components/ui/dropdown-menu.tsx
src/features/schemes/scheme-create-plan.tsx
src/features/schemes/scheme-follow-up-view.tsx
src/features/schemes/scheme-follow-up.server.ts
src/features/schemes/scheme-view-plan.tsx
```

(This document, `SCHEME_PLANNING_IMPLEMENTATION_HANDOFF.md`, will appear as one more untracked file at
the project root once written.)

---

## 21. Known issues / warnings intentionally NOT fixed

Everything here is confirmed behaviour that was **left alone on purpose**. Do not "fix" any of it
without first establishing the intended business behaviour — ask.

- **Orphaned seven-column aggregate** — `schemeWiseSummary` + `/api/scheme-plans/scheme-summary` are
  unused after the toggle removal (§4, §7).
- **Follow-up `data.totals` not rendered**, and `MoneyCells.hideStatus` unreachable (§6, §7).
- **`RunningSchemesTab` unreferenced but kept** in `scheme-officer-workspace.tsx` (§8).
- **Follow-up: whole-month Month columns under a week filter**, and **receipt-count-based status**
  that can read "Completed" while Pending > 0 (§6).
- **Verify/Conversion dialogs build N date inputs from `numberOfSchemes`** but `verifyScheme` persists
  only to instances that exist — on a legacy 3-scheme plan an Admin fills 3 dates and 2 are silently
  discarded (`AdminVerifyDialog` in `scheme-planning-page.tsx`; SO `ConversionModal` has the same
  shape).
- **Deletion trio** — group-delete cascade, `adminVerifiedById` FK asymmetry, aggregate-only deletion
  audit (§17).
- **`.env.example` ships `SCHEME_PLANNING_ENABLED="true"`** while the code default is off (this is a
  known configuration nuance, not a code change to make here).
- **Legacy `planningStatus` / `SchemePlanStatus` still dual-written**; `SchemeDocType` /
  `documentType` / `documentCompleted` are read-only relics never written.

---

## 22. Future work checklist (planned — NOT yet implemented)

Kept **separate** from everything above precisely because none of it is in the code. Confirm scope
with the product owner before starting any of it.

- [ ] **Dealer-wise View Plan** is a placeholder (`DealerWiseComingSoon`) for both SO and Admin — the
      real dealer-wise view is not built.
- [ ] **Decide the fate of the orphaned seven-column summary** (§4): either surface it in a UI again
      (re-implementing the em-dash-on-zero rule) or remove the aggregate + route. Do not leave it
      orphaned indefinitely without a decision.
- [ ] **Resolve the flagged behaviours in §21** once the intended business rules are established (the
      verify-dialog silent-discard is the highest-value one to settle).
- [ ] **Documentation drift:** `PROJECT_SPECIFICATION.md` still calls Scheme Planning "Coming Soon"
      and does not document Schemes, recovery, CN, or sales-upload. Update it to match the shipped
      module.
- [ ] **Commit strategy** — this large batch is uncommitted; a human should decide how to slice it
      into commits (see §23).
- [ ] **Tests** — there is no scheme-module test suite; money maths (Follow-up, `schemeWiseSummary`,
      `persistDraft` partial submit) would benefit from one.

---

## 23. Instructions for the next coding agent

1. **Start by running §2.** Confirm HEAD is `1289ba8` and the working tree matches §20. If it does
   not, this document is partly stale — trust the code, and re-derive the affected sections.
2. **Do not assume anything is unbuilt just because a brief says so.** The clearest example: the
   Create Plan redesign (§8) was described as "next / not yet implemented" but **is already built**.
   Check the file before you build.
3. **Respect the untouchables.** `SchemePlanningView` (§11) and `scheme-view-plan.tsx` must not be
   modified unless you are explicitly told to. The RM experience was deliberately left unchanged (§14).
4. **Never add a write to a read path.** No fetch on expand/Info in Create Plan; no
   `ensureInstances`/`expandInstances`/`ensureInstanceInstallments` in Follow-up or any read/verify
   path (§18). `refreshSchemeStatuses()` is a write.
5. **Never break the legacy instance rule (§16).** `ensureInstances` = Instance 1 only;
   `expandInstances` = the only counter, only from `persistDraft`.
6. **Do not run destructive DB commands** (`migrate`, `db push`, `reset`, `seed`) — migrations are
   already applied to production. Do not test deletion against production (§17).
7. **Verify honestly (§19).** Run `npm run typecheck`. Only claim the build passed if you actually ran
   `npm run build` and it succeeded.
8. **Do not silently "correct" a discrepancy** between docs and code, or a flagged oddity (§21) —
   surface it and ask. Never invent business rules.
9. **Read secrets carefully.** Config files may be read, but never print or expose secret values.
10. **Committing/pushing is a human decision.** Do not commit, push, stash, reset, restore, or checkout
    unless explicitly asked. This batch is large and unreviewed.

---

## 24. Final summary

- **This document:** `SCHEME_PLANNING_IMPLEMENTATION_HANDOFF.md` at the project root.
- **The module in one paragraph:** Scheme Planning is a three-route module (Create Plan / View Plan /
  Follow-up Plans), flag-gated by `SCHEME_PLANNING_ENABLED`, role-aware across Sales Officer /
  Regional Manager / Super Admin. This batch (uncommitted, on top of `1289ba8`) redesigned Create Plan
  into one collapsible scheme→dealers table with per-scheme, partially-submittable Save/Submit; added a
  read-only Follow-up recovery report; restructured the Scheme-wise view onto the shared collapsible
  pattern; removed the List/Collapsible toggle; and reused Scheme Master as the Admin Create Plan page.
  No schema change, no migration.
- **The discrepancies you must carry forward** (flagged, not hidden):
  1. The Create Plan redesign the brief framed as "not yet implemented" **is implemented** (§8, §9).
  2. The seven-column Scheme-wise **List View is gone** from the UI after the toggle removal; its
     server aggregate + route are **orphaned but kept** (§4, §7). The em-dash-on-zero-denominator rule
     lived in the deleted view and is not present anywhere now.
  3. Two Follow-up behaviours (whole-month columns under a week filter; receipt-count status) and the
     verify-dialog silent-discard remain **flagged, not fixed** (§6, §21).
- **Git:** branch `main`, HEAD `1289ba8`, nothing committed or pushed for this work; see §20 for the
  exact modified + untracked set.
