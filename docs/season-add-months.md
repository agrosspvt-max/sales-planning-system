# Canonical Season Add Months

SUPER_ADMIN adds explicit month/year pairs through `POST /api/seasons/[id]/months`.
The combined calendar set must be continuous, at most 12 months, and the Season
must be OPEN. New months default to OPEN. No dependent planning/financial records
are created. All existing IDs, orders, statuses and operational data stay intact.

SeasonMonth.calendarMonth/calendarYear are the calendar authority. Stored order
is preserved as historical insertion order; list/range DTOs expose chronological
ordinals without persisting them. Season start/end metadata follows the effective
period, while Season.year remains its original identity/key year. Recovery uses
explicit month identity; unresolved legacy months retain the old calendar fallback.
Daily Work resolves the actual work-date year/month rather than month name alone.

## Deployment and legacy records

Apply `20261001000000_season_month_calendar_identity` before deploying this code.
It adds nullable calendar identity, a paired/range check, and a calendar unique
index. It backfills only complete <=12-month layouts whose names/orders match an
explicit original start anchor. IDs, statuses, financial/planning fields, and
relationships are not changed. Missing anchors, gaps, invalid/mismatched names
and larger layouts remain NULL; the migration emits their IDs as a warning.

Read-only review query:

```sql
SELECT m.id, m."seasonId", m.name, m."order", s.name AS season,
       s."startMonth", s."startYear", s."endMonth", s."endYear"
FROM "SeasonMonth" m JOIN "Season" s ON s.id = m."seasonId"
WHERE m."calendarMonth" IS NULL OR m."calendarYear" IS NULL;
```

Add Months rejects unresolved calendar identity. Do not infer a year from Season.year
or a Recovery cutoff; resolve flagged rows from authoritative historical evidence.
The migration is additive and may be tested in a disposable database; it must not be
replaced with a production `db push` or a blanket legacy-date rewrite.

Free-text extension request creation and approval are retired (410 responses).
Existing requests, including PENDING requests, are retained unchanged and remain
readable/declinable. They are never assigned a guessed year or auto-approved.
Admin uses Seasons → Add Months instead. Whole-Season creation continues to use
the validated canonical period generator and writes explicit calendar identity.

An Add Months audit records actor, Season ID, added IDs/months/years and both periods
inside the same transaction. That audit also prevents an otherwise-unplanned Season
from being regenerated later by Edit. Edit/Add serialize on the same Season row.

## Complete Workbook

Each QTY column carries its detected month label and optional explicit year.
Only labels vertically aligned with their QTY column are accepted; neighboring
block labels are never borrowed. Ambiguous monthly labels reject COMPLETE imports
without blocking Seasonal-only imports. Commit resolves that label to exactly one explicit SeasonMonth calendar identity.
A yearless June header is accepted only if it resolves uniquely within the Season;
a missing/ambiguous header or mismatched year is rejected. No positional fallback
exists. June quantities remain attached to June after April/May are added.
Old cached parse payloads without calendar labels must be re-parsed.

## Verification

`npm run test:seasons` runs helper and transaction contract tests.
`npm run test:seasons:db` requires SEASON_MONTH_TEST_URL pointing exclusively to a
disposable `/tmp/season-calendar-pg.*` PostgreSQL Unix socket. It resets ONLY that disposable database, creates the old-schema fixtures, and
applies the migration itself. It must never
run against an application database. The test covers safe/ambiguous backfill,
unchanged historical plan/actual/recovery records, selectors, calendar mapping,
real audit-failure rollback, concurrent additions, and closed-Season rejection.

## Exact changed files

- `docs/season-add-months.md`
- `package.json`
- `prisma/migrations/20261001000000_season_month_calendar_identity/migration.sql`
- `prisma/schema.prisma`
- `prisma/seed.ts`
- `src/app/api/seasons/[id]/months/route.ts`
- `src/features/daily-work/daily-work.test.ts`
- `src/features/daily-work/service.server.ts`
- `src/features/import/seasonal/service.server.ts`
- `src/features/import/seasonal/wizard.tsx`
- `src/features/onboarding/service.server.ts`
- `src/features/planning/approvals-inbox.tsx`
- `src/features/planning/group-plan.server.ts`
- `src/features/planning/group-recovery.server.ts`
- `src/features/planning/month-extension.server.ts`
- `src/features/planning/monthly-plan.server.ts`
- `src/features/planning/monthly-plans-panel.tsx`
- `src/features/planning/monthly.server.ts`
- `src/features/planning/planning-state.server.ts`
- `src/features/planning/select-monthly-plan.tsx`
- `src/features/planning/service.server.ts`
- `src/features/recovery/service.server.ts`
- `src/features/reports/service.server.ts`
- `src/features/sales-upload/service.server.ts`
- `src/features/seasons/add-months-dialog.tsx`
- `src/features/seasons/add-months.integration.ts`
- `src/features/seasons/add-months.server.ts`
- `src/features/seasons/add-months.test.ts`
- `src/features/seasons/season-months-dialog.tsx`
- `src/features/seasons/seasons-page.tsx`
- `src/features/seasons/service.server.ts`
- `src/lib/season-calendar.test.ts`
- `src/lib/season-calendar.ts`
- `src/lib/season-months.ts`
- `src/lib/season-workbook-months.ts`

## Verified results

- Prisma validate/generate: passed.
- Full `npm test`, focused Season tests: passed.
- Disposable PostgreSQL migration/transaction integration: passed.
- TypeScript: passed.
- Lint: passed with four pre-existing warnings in unrelated files.
- Production build: passed.
- Browser: duplicate/gap/12-month validation, cross-year preview and save,
  month/status preservation, locked Edit, and actual January 2027 upload label verified.
- Application migration not deployed. Apply it before deploying the new client/server code.
