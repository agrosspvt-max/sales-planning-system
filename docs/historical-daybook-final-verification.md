# Historical Daybook final verification — 2 October 2026

This report records the original cutoff-based verification, before the approved calendar-month rule. The current implementation and month/year tests are documented in `historical-daybook.md`: Last Payment now uses explicit `SeasonMonth` calendar month-end, never the aging cutoff. The historical production/deployment findings below are snapshots from that earlier audit, not a fresh production status check.

## Verdict for the five core requirements

| Requirement | Result | Evidence |
|---|---|---|
| Actual receipt date and authoritative cutoff | PASS | Real Recovery Plans with ten different cutoffs; exact April/July/December scenario, year boundaries, pre-open-season receipt and a September-labelled plan whose cutoff is 14 July. |
| Strict Last Payment-only isolation | PASS | Full 68-table operational snapshots, including timestamps, unchanged on successful/duplicate/rejected/rolled-back historical operations. Analyze also leaves import/receipt/audit tables unchanged. |
| Normal Daybook remains correct | PASS, scoped fix made | Original parser, aggregation and financial transaction unchanged. Multi-dealer Receipts, Sales Return, Credit Note, Journal and Sales tested; same-row Last Payment; old/new receipts; new Recovery rows through existing assigned-dealer behavior; unrelated tables and protected Recovery fields unchanged. |
| Separate upload paths, no financial double-counting | PASS for tested scenarios; identity/concurrency limits below | Both upload orders, equal cross-source receipts, distinct same-day receipts, exact-file retry, overlapping historical commits, rollback, stale previews and regular alias-remapping tested. Last Payment never sums receipt amounts; normal financial totals consume only the normal workbook. |
| Independent values for each month | PASS | Real `getRecoveryPlan` results and actual Month/Week component rendering agree for April, May, June, July, August, November and December, plus custom cutoff. |

This is verification using disposable PostgreSQL fixtures. No real historical data was imported, no production migration was applied, and no production operational records were changed. It does not establish cross-file transaction identity or benchmark production latency.

## Exact calculation and scenario results

`getRecoveryPlan` passes its stored `RecoveryPlan.cutoffDate` to `latestReceiptAsOfByDealer`. The shared pure selector chooses `max(receiptDate <= cutoff)` and returns the amount from that same receipt row. It never aggregates amounts, replaces monthly targets or changes financial formulas. Empty eligible history returns the existing empty Last Payment state.

One historical workbook contains 10 April 2025 / 10,000; 15 July 2025 / 20,000; 10 December 2025 / 15,000, plus a pre-season 10 January 2024 / 100.

| Recovery cutoff | Returned date | Returned amount |
|---|---|---:|
| 30 April 2025 | 10 April 2025 | 10,000 |
| 31 May 2025 | 10 April 2025 | 10,000 |
| 30 June 2025 | 10 April 2025 | 10,000 |
| 31 July 2025 | 15 July 2025 | 20,000 |
| 31 August 2025 | 15 July 2025 | 20,000 |
| 30 November 2025 | 15 July 2025 | 20,000 |
| 31 December 2025 | 10 December 2025 | 15,000 |
| 14 July 2025 (September-labelled plan) | 10 April 2025 | 10,000 |
| 31 December 2024 | 10 January 2024 | 100 |
| 31 January 2026 (open 2026 season) | 10 December 2025 | 15,000 |

The Month/Week tests render the existing `RecoveryWorkspace`, `MonthView`, `WeekView`, `WeekGrid` and `LastPaymentCell` with the real database-derived detail response. Only peripheral UI/providers, transport, tab initialization and autosave/mutation hooks are substituted for a server render; the actual table cells/date/money display and source fields are used. No server cutoff or receipt selector is mocked. Browser interactivity was tested in the preceding implementation task; this final audit reran automated component rendering rather than a new browser session.

Fixtures create test plans before import. Import never creates missing plans; the plan count and complete operational snapshots remain unchanged.

## Write/read set and source independence

**Historical analyze/review:** workbook parsing plus reads of Dealer, DealerAlias, RecoveryPlanDealer/RecoveryPlan cutoffs, LastPaymentImport and LastPaymentReceipt. No writes, including no audit write.

**Historical confirm/import:** only `LastPaymentImport.create`, `LastPaymentReceipt.createMany`, `AuditLog.create` in one interactive transaction. The raw advisory-lock SELECT has no persistent data-write side effect. Normal `commitDaybook` is never invoked.

**Last Payment sources:** legacy `RecoveryPlanDealer.lastReceiptDate` / `lastReceiptAmount`, and active `LastPaymentReceipt` joined to `LastPaymentImport`. Two batched reads; no per-dealer query. Month/Week use identical detail fields; changing the selected week does not substitute AgingSnapshot's week cutoff.

**Normal Daybook:** original financial reset/upsert/raw latest-pair transaction and its audit are unchanged. Receipt retention is a separate post-financial-commit transaction limited to the isolated tables/audit. It reads current monthly financial summaries before retention, supersedes only REGULAR batches for that SeasonMonth scope, never resets HISTORICAL batches and surfaces failure without rolling back/replaying successful financial writes.

Tested sequences:

- Historical first → newer normal: Alpha's December history is followed by normal 12 December / 5,000 and 20 December / 7,000. Cutoff 15 December shows 12 December / 5,000; cutoff 31 December shows 20 December / 7,000; November remains 15 July / 20,000.
- Normal first → older historical: Delta normal 17 December / 8,000 followed by historical 5 December / 4,000. Cutoff 10 December shows 5 December / 4,000; cutoff 31 December retains 17 December / 8,000.
- Older normal receipt: Epsilon's historical 19 December / 700 is not replaced by normal 2 December / 50 at the later cutoff.
- Same underlying receipt in both: Alpha's 10 December / 15,000 is stored once per source, because reliable cross-source identity is unavailable. Last Payment is 15,000, never 30,000; the normal Live Recovery aggregate includes only its own workbook row.
- Legitimate equal-valued receipts: Gamma has two normal 14 December / 9,000 source rows; both survive. Last Payment is a single 9,000. Equivalent historical same-day rows also survive explicit KEEP-as-distinct review.
- Revised historical file: overlap is flagged, explicitly excluded in the test, and omitted old rows are retained.
- Concurrent historical imports: exact-file retries produce one import; two different overlapping previews yield one committed batch and one 409 requiring renewed review. Audit failure rolls back batch plus all receipt rows; retry succeeds.

Normal workbook totals are **53,050 Live Recovery and 325 SR/CR**, including multiple dealers, legitimate same-day rows and one cross-source overlap. Normal analyze reports the same totals and makes no writes. All other tables remain unchanged; existing RecoveryPlanDealer fields may change only their original Daybook-owned values and updatedAt. Assigned dealers missing a Recovery row are created through the existing zero-aging upsert behavior.

## Confirmed defect fixed in this verification

`retainRegularReceipts` previously keyed regular history by raw file bytes alone. After an alias changed Alpha → Delta, re-uploading the exact normal workbook correctly reassigned the financial results but reactivated history still mapped to Alpha. The failing regression returned Alpha's **20 December / 7,000** instead of its historical **10 December / 15,000**.

The fix keys REGULAR retention batches by the raw file hash plus ordered resolved receipt tuples (source row, dealer, date, amount). Raw file hash remains in import summary metadata. Unchanged retries reuse the batch; changed matching/scope creates another retained version and deactivates the earlier REGULAR version. Restoring the previous mapping can safely reactivate its matching version. No existing receipt rows are deleted or rewritten, no transaction identity is invented, and HISTORICAL raw-file identity is unchanged.

Post-fix tests verify the old dealer stops showing those stale regular receipts, Delta gets its correctly mapped earlier receipt, and restoring the alias/re-upload restores the original mapping. No schema/migration, API, UI, matching rule, financial calculation or financial transaction change was needed.

## Isolation evidence

`operationalSnapshot` discovers every public table from PostgreSQL, excluding only LastPaymentImport, LastPaymentReceipt, AuditLog and Prisma migration metadata. It serializes every row, including timestamps, in deterministic order. All **68 operational tables** are compared exactly.

Representative nonzero fixtures cover Sales actual/plan quantities and values, seasonal/approved plans, Recovery targets/week plans/outstanding/SR/CR/Live Recovery, aging snapshots and bills, aliases/assignments, closed and open seasons, Scheme plan, CN and Daily Work. Existing Actual Running Recovery remains -26,000 throughout historical tests.

`isolatedSnapshot` adds all receipt/import/audit rows to those comparisons. It proves analyze, exact duplicate, rejected/unconfirmed/unauthorized/modified-preview attempts, and injected audit failure change nothing. Successful historical imports change only the three permitted stores. Historical import after normal commit is separately snapshot-checked. Stale regular retention is rejected without replacing the currently active batch.

Scheme installment/payment and some other tables are empty in these fixtures; they are included in the complete comparison but were not individually populated or exercised. No payment/ledger generation code is reachable from the historical commit path.

## Migration and production deployment readiness

Verified target: the **configured Neon database `neondb`, schema `public`**, which the user explicitly confirmed is production. DATABASE_URL is pooled; DIRECT_URL is non-pooled; both resolve to the same configured target (host fingerprint `3a8643a2d2fa`). Credentials and full connection URLs are intentionally omitted. No Vercel/project link is configured in this checkout, so hosting-job specifics were not assumed.

Read-only production transactions verified:

- 81 successfully applied migrations; every applied checksum matches the repository.
- No applied migrations absent from the repository and no failed migration records.
- Neither LastPaymentImport nor LastPaymentReceipt exists.
- `20261002010000_last_payment_receipt_history` is the **only** pending local migration.
- The configured deployment connection has database/public-schema CREATE privileges.

Migration SQL creates only two new tables, four explicit indexes plus two primary-key indexes, three Restrict foreign keys and two CHECK constraints. Existing data is neither rewritten nor deleted. Schema/client date and Decimal types match. Exact unique index keys and FK/CHECK definitions were independently inspected after applying that SQL in disposable PostgreSQL.

Correct future deployment order, **not executed in this task**:

1. Arrange the normal production backup/restore point and confirm the deployment job points to this approved target. Recheck migration status immediately before rollout.
2. From the release checkout with its approved production environment, run `npx prisma migrate deploy --schema prisma/schema.prisma`. Prisma's configured `directUrl` uses DIRECT_URL. This applies all pending migrations; at audit time only this one is pending.
3. Generate/build with `npm run build` (includes `prisma generate`) and activate the new application release **after** migration success. Old code remains compatible with the additive tables; the new Recovery reader requires them, even before the first historical import.
4. Run normal smoke checks and begin with a small reviewed file before larger imports.

`npm run prisma:migrate` invokes `migrate dev` and is not the production command. Do not use `db push`, reset or dev migrations for production deployment.

Rollback/recovery: rolling application code back can leave the additive tables/data in place. Do not drop receipt tables after imports as an automatic rollback. The SQL has no explicit transaction wrapper, so a failed/interrupted DDL migration may leave partial new objects and a failed migration record. Inspect schema and migration metadata, repair the exact failure through the approved deployment process, and use migration resolution only after confirming database state. No automatic rollback/repair/destructive production command was run or recommended blindly.

## Commands actually run

| Command/check | Actual result |
|---|---|
| `npm run test:historical-daybook` | PASS |
| `HISTORICAL_DAYBOOK_TEST_URL=<guarded local DB> npm run test:historical-daybook:db` | PASS after confirmed fix; actual SQL migration, 1,000-row import, snapshots, retries and Month/Week rendering |
| `node --import tsx src/lib/daybook-aggregate.test.ts` | PASS: 11 existing tests |
| `node --import tsx src/lib/last-payment.test.ts` | PASS: 13 existing tests |
| `npm test` | PASS full repository suite |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with three existing unused-symbol warnings: DUP_THRESHOLD, onboarding Upload, profile PlanStatus |
| `npm run build` | PASS production build, database configuration pinned to isolated local test DB |
| `git diff --check` | PASS |
| Production migration metadata/checksum/permissions | Read-only check PASS; no DDL or real imports |
| Local PostgreSQL index/FK/CHECK inspection | PASS; exact expected definitions |

The new alias-remapping regression was run before the fix and failed with the exact stale Alpha result above. It then passed after the fix. Deliberate fault injection produces an expected isolated-retention warning; it is not an unhandled test failure. Local PostgreSQL uses a one-connection Prisma pool. No unrun test is reported as passed.

## Remaining limits

- Cross-file/cross-source identity is inherently ambiguous without a proven transaction ID. Voucher references are not globally unique. Historical preview flags overlaps for explicit review; regular upload retains source provenance and does not sum historical records into financial totals. This does not claim there is only one physical metadata row for a shared payment.
- Equal-date receipts have no reliable intra-day ordering. Existing legacy precedence and stable new-source order are preserved; Last Payment is not a same-day sum. Legacy equal-date ordering across multiple summaries is inherited rather than redesigned.
- Regular financial commit and isolated retention are intentionally separate. Current-state revalidation rejects an overtaken upload when financial summaries differ. Two concurrent normal files with identical financial summaries but different intermediate receipt history cannot be distinguished authoritatively by that check; fixing this fully would require a normal-upload version/serialization change outside the present focused fix. Avoid overlapping normal monthly uploads and monitor retention warnings. Historical imports themselves serialize their receipt writes and retain atomic rollback.
- Retention failure does not undo successful normal financial writes. Legacy latest pairs remain readable, but individual earlier receipts may be incomplete until retention succeeds.
- Active-only existing dealer matching, positive historical credit validation, `.xlsx`/25 MB/20,000-row limits, one selected Day Book sheet and absence of a correction/reversal/delete workflow remain unchanged.
- The 1,000-row test is local, not a Neon latency benchmark or a real two-year workbook test. No real workbook was supplied for final verification.

## Files inspected and incremental changes

Inspected:

- `src/features/historical-daybook/service.server.ts`: reviewSchema, buildAnalysis, receiptLock, analyzeHistoricalDaybook, commitHistoricalDaybook, retainRegularReceipts.
- `src/features/historical-daybook/parser.ts`: calendarDate, receiptDate, receiptAmount, parseHistoricalDaybook.
- `src/features/historical-daybook/{types.ts,upload-route.server.ts,wizard.tsx}`: DTO/review contract, historicalUpload, analyze/review/confirmation UI.
- `src/app/api/historical-daybook/{analyze,commit,dealers}/route.ts`: auth and independent routes.
- `src/lib/{last-payment.ts,last-payment.server.ts}`: latestReceiptAsOf, loadLastPaymentPoints, latestReceiptAsOfByDealer.
- `src/features/recovery/{daybook-parser.ts,service.server.ts,recovery-workspace.tsx,recovery-calc.ts}`: parseDaybook, classification, resolveDaybook, analyzeDaybook, commitDaybook, getRecoveryPlan, Month/Week/LastPaymentCell and unchanged financial consumers.
- `src/app/api/recovery/daybook/{analyze,commit}/route.ts`; `src/app/api/recovery/plans/[id]/route.ts`; `src/app/(dashboard)/planning/sales-upload/page.tsx`.
- `src/features/sales-upload/{upload-tabs.tsx,daybook-wizard.tsx}`; `src/features/labels/{labels.ts,label-ui.tsx}`.
- `src/lib/{dealer-resolver.ts,dealer-display-name.server.ts,match-key.ts,import/workbook.ts,audit.ts,http.ts,prisma.ts}`: shared matching/display, parsing, audit/auth and connection configuration.
- Prisma schema, exact new migration, migration history/checksums, package scripts, README and `.env` connection configuration (secrets not reported).
- Historical unit/integration tests, existing daybook-aggregate and last-payment tests, and full feature diff.

Only four files were changed further by **this final verification task**:

1. `src/features/historical-daybook/service.server.ts` — scoped REGULAR receipt-batch remapping fix.
2. `src/features/historical-daybook/historical-daybook.integration.ts` — expanded scenarios, complete no-write snapshots and real Month/Week rendering coverage.
3. `docs/historical-daybook.md` — corrected regular batch identity/compatibility documentation and linked this audit.
4. `docs/historical-daybook-final-verification.md` — this report.

Other dirty files were already part of the preceding Historical Daybook implementation. The Last Payment selector/reader, APIs, UI, schema and migration were not changed during final verification. Generated tsconfig.tsbuildinfo is restored after checks. No unrelated cleanup/refactor or business change was made.
