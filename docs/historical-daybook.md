# Historical Daybook — Last Payment only

## Architecture findings and implementation

Normal Daybook Upload previously retained only the latest Receipt date/amount per dealer/upload month in `RecoveryPlanDealer`, alongside its operational SR/CR and Live Recovery writes. Earlier individual receipts were lost, which prevented a cutoff between two receipts from finding the earlier one. There was no safely isolated existing receipt-history store.

Historical Daybook is the fourth tab on `/planning/sales-upload`. It uses separate Admin-only analyze, dealer-review and commit endpoints. The existing workbook reader, Day Book sheet/header conventions, Receipt classifier, dealer-name matching tiers, aliases, authorization, API errors, labels, table components and AuditLog writer are reused. A historical parser adapter adds strict date/amount validation, multi-year support, physical source-row provenance and ambiguity reporting without changing the monthly parser's conversions or aggregation.

The existing pure `latestReceiptAsOf` selector and `RecoveryPlan.cutoffDate` remain authoritative. One batched shared server helper supplies the same `lastPaymentDate` / `lastPaymentAmount` fields to the unchanged Month and Week views. No other metric consumes the new receipt tables.

## Schema and exact write/read sets

Migration: `prisma/migrations/20261002010000_last_payment_receipt_history/migration.sql`.

- `LastPaymentImport`: kind, monthly scope metadata (SeasonMonth ID for regular uploads; empty for historical), SHA-256 identity (raw file hash for historical; raw file plus resolved receipt mapping fingerprint for regular), workbook name, uploading user, active flag, review/result summary and creation timestamp. Unique `(kind, scopeKey, fileHash)`.
- `LastPaymentReceipt`: import/dealer references, source row identity/order, actual DATE, positive Decimal(14,2) credit amount, optional voucher reference and creation timestamp. Unique `(importId, rowKey)`; dealer/date lookup index.
- Only these two new tables, constraints/indexes and inverse Prisma relations were added. Existing tables/records are not migrated or backfilled.

**Historical commit writes exactly:** `LastPaymentImport`, `LastPaymentReceipt`, `AuditLog`. It never calls the normal Daybook commit service, creates dealers/plans, deactivates previous historical batches or writes operational tables.

**Last Payment reads exactly:** legacy `RecoveryPlanDealer.lastReceiptDate` / `lastReceiptAmount`, plus active `LastPaymentReceipt` rows joined to `LastPaymentImport`. It selects the latest eligible date ≤ the existing plan cutoff and the amount of that single receipt, never a summed amount.

**Analyze/revalidation additionally reads:** current Dealer and DealerAlias matching data and existing RecoveryPlanDealer → RecoveryPlan cutoff relationships. It performs no writes.

**Future regular Daybook uploads:** the original financial transaction remains unchanged. After it succeeds, a separate isolated transaction retains individual valid, matched Receipt rows, deactivating only previous REGULAR batches for that upload month. Historical batches are never reset. Current financial values are read/revalidated before retention to reject an older upload that has been overtaken. A regular retention batch is keyed by file bytes plus the resolved receipt mapping; the raw SHA-256 is retained in its summary. A same-file re-upload after matching/scope changes creates or reactivates the appropriate mapping version and supersedes only prior REGULAR batches, preserving all stored rows. Retention failures roll back only receipt metadata/history, preserve successful financial writes, and return a visible retry warning. Existing monthly reset-and-replace semantics make retry non-accumulative.

The migration was applied and verified only in the guarded local `historical_daybook_test` database. It has **not** been applied to the application's database; deployment must apply the migration before running this code.

## Preview, identities, duplicates and retry

The UI provides receipt counts, matching candidates, invalid/unmatched rows, potential overlaps, explicit KEEP-as-distinct / EXCLUDE decisions and previous/projected Last Payment for existing plan cutoffs. Changing a decision requires an updated preview. Commit requires explicit confirmation and a preview token; the server re-analyzes matching/history/cutoffs inside the transaction and rejects stale previews.

Exact-file identity uses SHA-256 of workbook bytes; receipt identity uses import plus sheet/physical row. Re-importing that exact committed historical file returns its original result without new rows or audit side effects. Previously excluded rows remain excluded. Revised files append reviewed receipts; missing rows never delete history.

Voucher numbers are captured when available but were not demonstrated to be globally unique. Dealer/date/amount or dealer/date/voucher overlaps are review candidates, not automatic deletion keys. Identical same-day legitimate receipts survive explicit confirmation. Historical import plus audit is atomic; a scoped advisory lock serializes receipt-store writers and the unique keys guard retries. No operational rows are locked or rewritten by historical import.

## Verification results

- `npm run test:historical-daybook`: passed (dates including Excel 1904, amounts, multi-year parsing, blank/repeated headers/totals, source identity, matching ambiguity, requested cutoff examples, monthly aggregation regression, initial UI).
- `npm run test:historical-daybook:db`: passed against real isolated PostgreSQL, connection limit 1, with the actual SQL migration. Covers all required cutoff examples, pre-season receipt, permissions, explicit confirmation, ambiguous/unmatched/invalid review, legitimate identical receipts, conflict review, exact-file retry/concurrent retry, stale preview, audit rollback/retry, 1,000 receipts, real normal Daybook retention, normal retry, stale regular retention and isolated-retention failure.
- Full `npm test`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with three pre-existing unused-symbol warnings (`DUP_THRESHOLD`, onboarding `Upload`, profile `PlanStatus`). No new warnings.
- `npm run build`: passed.
- `git diff --check`: passed.

The integration test snapshots **all 68 operational tables**, including timestamps, excluding only the two new receipt tables, AuditLog and Prisma migration metadata. Exact before/after equality is asserted after historical imports and rollback/retry. Fixtures include nonzero sales actuals and plan values, Recovery targets/weeks/SR/CR/Live Recovery/outstanding, aging bills, a closed season, assignments, aliases, Scheme planning, CN and Daily Work records. The existing Actual Running Recovery result stays unchanged. This is fixture evidence, not a production-data comparison.

Browser verification used the local production build and disposable fixtures: four tabs; no historical month selector; actual multipart analyze; cutoff preview; disabled commit until confirmation; successful import; unchanged Month/Week views both display the imported `10/06/2025 · 555` for cutoff `30/06/2025`. Browser error/warning logs were empty.

## Limits and retained compatibility

- Existing monthly summaries cannot recover receipts previously discarded. Import the original historical files to fill those gaps; no synthetic backfill is performed.
- Existing equal-date legacy precedence is preserved. New receipt ties use stable import/source order and the existing first-on-tie selector. A Last Payment amount is not a same-day total.
- Voucher references alone cannot establish identity across revised exports. Admin must resolve ambiguous overlap; there is no automatic correction, reversal or deletion workflow.
- The existing active-only dealer matcher is retained. Inactive/unmatched names require exclusion or a reviewed eligible existing dealer; no dealers are created/reactivated.
- Historical upload limits: `.xlsx`, 25 MB, 20,000 rows, 256 columns; one Day Book sheet selected by the existing convention. Other sheets are explicitly reported as ignored.
- Regular retention uses the original monthly parser's dates/amounts and retains valid positive receipts; it cannot invent missing dates or support reversals. It adds no month filtering to the existing monthly financial parser. Legacy monthly fields remain available if retention fails; earlier individual history may then be incomplete until a successful retry.
- Regular financial commit and informational retention intentionally remain separate. There is no new cross-system transaction or concurrency redesign of the existing monthly uploader. Revalidation cannot distinguish two concurrent files whose financial summary is exactly identical; the existing flow has no authoritative file-version token. Same-file regular retention follows the current resolved dealer mapping; older mapping versions remain stored but inactive. No production Neon latency or real two-year customer workbook was benchmarked; rollback/load tests used local PostgreSQL and synthetic workbooks.

## Exact changed files

Existing files:

1. `package.json` — focused unit/integration scripts; unit suite included in npm test.
2. `prisma/schema.prisma` — two isolated models/inverse relations.
3. `src/features/labels/labels.ts` — Historical Daybook label defaults/metadata.
4. `src/features/recovery/daybook-parser.ts` — shared layout/header/sheet recognition exports.
5. `src/features/recovery/service.server.ts` — shared Last Payment reader and isolated post-commit individual receipt retention.
6. `src/features/sales-upload/daybook-wizard.tsx` — optional retention-failure warning.
7. `src/features/sales-upload/upload-tabs.tsx` — fourth independent upload wizard.
8. `src/lib/dealer-display-name.server.ts` — optional transaction read client, unchanged default behavior.
9. `src/lib/dealer-resolver.ts` — optional transaction client and matching-candidate review; existing resolution unchanged.

New files:

10. `prisma/migrations/20261002010000_last_payment_receipt_history/migration.sql`.
11. `src/lib/last-payment.server.ts`.
12. `src/app/api/historical-daybook/analyze/route.ts`.
13. `src/app/api/historical-daybook/commit/route.ts`.
14. `src/app/api/historical-daybook/dealers/route.ts`.
15. `src/features/historical-daybook/types.ts`.
16. `src/features/historical-daybook/parser.ts`.
17. `src/features/historical-daybook/service.server.ts`.
18. `src/features/historical-daybook/upload-route.server.ts`.
19. `src/features/historical-daybook/wizard.tsx`.
20. `src/features/historical-daybook/historical-daybook.test.ts`.
21. `src/features/historical-daybook/historical-daybook.integration.ts`.
22. `docs/historical-daybook.md` — this implementation/verification report.

For the subsequent read-only production migration review, expanded April/July/December regression checks, and the confirmed regular-retention remapping fix, see `docs/historical-daybook-final-verification.md`.
