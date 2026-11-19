# Tally sales integration — test rollout

Sales uses the existing connector identity and encrypted Windows keys. No accounting imports or voucher writes are sent to Tally.

## Behavior

- Current India calendar month: first day through today, automatic every 15 minutes while Tally and the foreground connector run. Earlier months: explicit Super Admin request only. The approved company/FY remains Agromaxx Industry (2026-27), April 2026–March 2027.
- Read canonical Sales and Credit Note families, discovered through RESERVEDNAME and parent lineage, including renamed/custom child types. Read complete daily slices with explicit date predicates. Reject wrong company/date/family, malformed XML, partial/oversized results and duplicate voucher identities.
- Store monthly bill identities, original product names, decimal base quantities, source item amounts, rates, original quantity strings and financial ledger legs. Cancelled/optional vouchers are retained and excluded from actuals. Product-less financial notes remain separately identifiable; they are not spread across products.
- Product credit quantities are negative, source negative amounts are retained once. Zero-quantity amount adjustments remain valid. Source item value drives Actual Amount; quantity × master rate is never used to invent actual value.
- Translate the observed Tally U+0004 XML marker only in auxiliary metadata; reject it in business fields. Unknown forbidden controls/entities/DTDs remain rejected. This is separate from the existing strict aging parser.
- Exact Dealer Alias names (or the exact master name when no alias exists) and the shared Sales Upload product matcher resolve actuals. Pack cleanup uses the upload parser; canonical/tight/loose/name-similarity matching uses the same catalog resolver and 0.9 threshold. Automatic sync requires a unique best surviving product and holds ambiguous ties. A missing ledger is held for sales, rather than interpreted as zero. A verified ledger with complete zero sales can clear previous actuals. Unknown/ambiguous products or conflicting units hold the entire dealer.
- Publish only MonthlyEntry.saleQty/saleValue for active approved seasonal versions and eligible active dealers for that calendar month. Existing plan inputs, status/approval fields, Daybook values and aging snapshots are not written by sales. Known sold but unplanned products can receive auto-added zero-planning lines.
- Replace the month atomically, rather than accumulating imports. Replays, edits, cancellations and deletions do not double count. Changed-only details show the latest 100 changed product rows; all rows are counted. Held dealer details explain mapping/unit problems.
- Monthly and Territory reports retain decimal quantities and use the same actual records. Approved monthly pages and Territory views check for fresh data every minute. The connector checks its job queues more frequently than its 15-minute snapshot schedule.
- Manual Excel sales commits are blocked for the approved FY while Tally sales is enabled and the connection active, including before the first snapshot, preventing concurrent upload ownership. Disable the connection to use the upload fallback. Manual uploads retain decimals too.

## Isolation and deployment

Only branch codex/tally-billwise-test is used. The Preview build's schema preparer verifies VERCEL_ENV=preview, the exact Git branch, matching pooled/direct/expected hosts and a pinned SHA-256 of the verified Neon test endpoint. It refuses a mismatched test Preview and skips other environments. The reviewed additive SQL is applied in one transaction with an advisory lock; repeated runs verify the new tables and decimal type and do nothing. An incomplete/unexpected schema is not automatically repaired.

The same guarded Preview enables sales without another secret/configuration entry. TALLY_SALES_SYNC_ENABLED=false is an explicit off switch. Existing TALLY_SYNC_ENABLED and expected-host guards still apply. No production promotion, Windows startup, firewall rule or new credential is installed by this work.

Keep the new decimal schema when disabling sales. Do not downcast fractional quantities or roll back to an Int-only app after fractional actuals have been saved. Production migration/baseline handling remains a separate reviewed rollout.

## Office update

Use Tally-Connector-Update-v1.4-test.zip on the already configured Windows Tally PC. Stop the old worker, copy update files into that existing connector folder, update its website origin to the stable test branch address with Update-Test-Website.cmd, and run windows/Run-All-Sync.cmd. The existing config.json and encrypted keys are preserved. Do not run the old and new workers together. The computer must stay awake with Tally open; this update does not add startup behavior.

State: health.json for aging; sales-health.json for sales; sync-all.log for the combined runner. Each worker has a separate encrypted claim/outbox. Lost acknowledgements replay saved data; exhausted sales retries end that attempt and allow a fresh read. Authentication revocation stops access to both queues. Collection/publication errors preserve existing actuals.

## Verification

- Optimized Next build, lint and real generated Prisma types passed. Existing unrelated lint warnings remain; test harnesses have explicit-any warnings.
- All 350 real supplied product lines in 115 sales/credit vouchers match the prior audited quantities, source values and base units. That audit reconciled all 325 reference workbook pack rows; additional live bills remain explained separately in Sales-Extraction-Audit.md.
- Real additive SQL applied to the previous schema in a disposable PostgreSQL database, then applied again to prove safe repeat execution.
- Aging and sales database tests cover credentials/roles, scope changes, claim recovery, lease fencing, partial uploads, verified zero, holds, decimals, signed returns, zero-quantity values, cancellations/deletions, replay, 15-minute scheduling, manual historical isolation and revocation.
- Real native curl XML → Python sales collector → certificate-verified local HTTPS → PostgreSQL publication passed with synthetic data. Windows DPAPI is replaced by a test codec only in this local roundtrip.
- Connector regression suite and built-route authentication/cross-site checks passed. Three actual Windows protection/locking smoke checks cannot run on macOS.
- First live sales publication on the office PC still requires installing/running the delivered update; a local synthetic roundtrip does not claim that office installation has happened.


### Month-range refresh and connection recovery (1.4.1-test)

Tally Connection now accepts an inclusive From month / To month range in the approved financial year, through the current India month. Each month is queued and published separately; repeated requests reuse pending jobs. The table shows each month's queue/read/completion/failure and last successful read. No eligible approved sales plans is shown explicitly. Current-month automatic refresh gets a turn when due between historical jobs. Aging retains its separate queue.

A temporary status fetch failure keeps the selectors and last saved snapshot visible, with automatic bounded query retries. It no longer reports that sales is disabled for a generic network/server failure.

Office update 1.4.1-test reads up to seven days per voucher-family request, splitting on a size limit or timeout. Every returned voucher is still checked against the exact interval. A failed single-day read fails the month; partial months cannot replace actuals. Cloud actions retry once when transient and replay-safe, with the same durable claim ID/chunk hashes/publication identity. Authentication, TLS certificate rejection and stale leases are not retried internally. The existing encrypted outboxes remain in place. Safe logs include action/error type only, without keys or payloads. Reading/upload/publication progress is printed in the office window.

Validation: rendered controls during failed status queries, inclusive range and invalid dates, actual disposable PostgreSQL queue deduplication/month isolation/current-month priority, synthetic curl/TLS end-to-end publication, adaptive split and bounded cloud retry tests. Actual office network speed still needs verification on the Windows computer.


### Completion timeout investigation — 31 October, after 18:00 IST

The office log identified `cloud_transport action=complete kind=timeout` repeatedly while aging continued working. A durable sales outbox was being replayed; queued April work did not mean that the failing operation was an April Tally read. `SALES_UPLOAD_RETRIES_EXHAUSTED` was also present. Increasing read timeouts does not address this saving-stage symptom.

The completion path previously performed one `PlanLine.upsert` per new dealer/product combination, reloaded the full pinned scope twice, and rewrote all covered monthly actual rows even when identical. Publication now bulk-inserts missing lines (500 per query), reuses the scope checked inside the same transaction, selects previous values by the relevant line/month indexes, and writes changed actuals only. Existing planning quantities/rates and held dealer values remain preserved. Existing null amount fields are normalized to explicit source amounts without changing their numeric change count. Bills and all product evidence are still saved inside the same atomic transaction. No Windows settings or connector update is required for this server fix.

Safe server timing logs identify plan-line creation, actual comparison, actual saving and bill-detail saving by job/month and row counts. They exclude source names, financial amounts and credentials.

The disposable database test imports 300 previously unplanned products in one historical bill, verifies one PlanLine insert statement, confirms an identical refresh makes no monthly-actual insert/update statements, and checks all 300 bill product lines are stored. The existing credential, atomic-publication, scope-change, historical isolation, decimal, return, replay and aging checks remain in the same run. This establishes the reduced database work; actual hosted timings require the next office retry.


### Missing dealer ledger becomes zero — approved test Preview only (3 November)

After a successfully validated ledger collection, any requested Tally name absent from that collection contributes zero for the requested month. Without a Dealer Alias, the system dealer name remains the exact lookup name. A dealer with no matching ledger has its existing monthly saleQty/saleValue replaced by zero. A readable alias continues contributing actual sales even when another older alias is absent. Ambiguous present names, unresolved product mappings and incompatible units still appear under review.

The zero rule is enabled only on the pinned `codex/tally-billwise-test` Vercel Preview and pinned test Neon database. An explicit sales-enable flag on another environment does not enable the zero rule. Other environments retain the previous preservation behavior. The policy is included in the job scope fingerprint, so an in-flight result reserved under the prior policy must be refreshed.

The claim adds the existing approved company-anchor ledger to the requested ledger names, even when it is outside the planning scope. Connector 1.4.1 already returns requested names from the full Ledger collection, so no protocol/schema/Windows update is required. Completion checks the anchor's exact name and GUID inside that collection before accepting missing names as zero. Empty/incorrect collections fail with `SALES_LEDGER_COVERAGE_NOT_VERIFIED`; a failed read cannot clear actuals.

Summary `zeroed` lists affected dealers and missing names separately from `held`. The refresh UI explains the zero action and selected month. Source bill records remain stored; zeroing only changes actual sales fields in the requested month, preserving plan fields, other months and aging.

Validated using disposable PostgreSQL: no-alias missing name clears quantity/amount, configured missing alias clears, exact no-alias match imports decimals, missing older alias does not erase a readable alias, empty ledger collection preserves values, explicit historical refresh affects only its month, production-mode policy preserves previous behavior, and bill/aging regression checks. Rendered UI tests verify the zero explanation and the Preview/database guard tests reject production, other branches and other databases.

### Daybook unsupported voucher types — 18 November

The office scan reported a blank-number `Cheque Return` on 2 November as
`VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE`. The server previously rejected the whole month
for this diagnostic even though the manual Daybook importer deliberately ignores
types other than exact Receipt, Credit Note or Sales Return (including suffixes
for the latter two).

The capture validator now independently checks that a type really is outside
those rules before treating that diagnostic as an exclusion. Valid receipts and
SR/CR publish normally. Successful sync summaries and local capture previews list
the excluded voucher date, type, number, identity and reason. Cancelled and
optional vouchers remain excluded too. No amount is inferred for Cheque Return.
`CREDIT_AMBIGUOUS`, `CREDIT_MISSING`, and inconsistent review diagnostics for an
otherwise supported type still reject publication and preserve prior figures.
Company/date/GUID validation, complete-period coverage and replay checks remain
in force.

This is compatible with the existing `daybook.capture.v1` payload from connector
1.6.1-test; no Windows update or database migration is required. The queued next
scan or a manual refresh uses the new handling. Disposable PostgreSQL tests cover
a mixed batch with Cheque Return, exact receipt/SRCR totals, visible exclusion
details, replay, review holds, replacement and Last Payment; typecheck passed.

### Daybook dealer and excluded-voucher tables — 18 November, 1.6.2-test

Daybook sync and local capture preview now share tables for Dealer, SR/CR,
Receipts, Other and match notes, followed by Excluded vouchers (dealer/Tally
ledger, voucher type, source party amount, Dr/Cr direction, date, number and
reason). Successful summaries retain all matched dealer totals, unmatched Tally
names and accounting rows. Needs dealer link distinguishes no exact/alias match,
multiple confirmed candidates and only suggested loose/fuzzy names, with a link
to Dealer Alias. Suggestions never become automatic financial matches.

Connector 1.6.2-test changes the read-only Daybook collection from Receipt/Credit
Note families to all Voucher objects in seven-day date-filtered slices, splitting
oversized/timed-out intervals. Each voucher still passes company-prefix, date,
flag and duplicate checks; the company anchor is read before and after collection.
The collection has a seven-minute guard and 10,000-voucher limit; the existing
2 MiB cloud payload limit still applies. Failure preserves the prior publication.
The payload remains daybook.capture.v1 with optional coverage=all_vouchers.

Receipt and SR/CR classification and credit selection remain unchanged. Other
voucher types carry excluded=unsupported_type and category=other. Cancelled and
optional vouchers remain excluded. For display evidence, the collector uses the
named PartyLedgerName, or exactly one IsPartyLedger name, and sums only that
party's ledger entries. Amount is its absolute source value with debit/credit
or zero direction. Missing/ambiguous parties or malformed display amounts are
left unknown rather than guessed from a bank/accounting leg. Other sums the
absolute amounts of unsupported types only; cancelled/optional entries do not
contribute. A partial unknown Other total is shown as unknown, not a partial sum.
Other is informational and never written to Recovery, SR/CR, receipts or Last
Payment. Recognized Receipt/SRCR types cannot be disguised as unsupported_type.

Old 1.6.1 captures still publish and display their available details. Older saved
summaries without dealerRows use their saved unmatched/accounting data until a
refresh. Old excluded vouchers did not carry the party/amount, so these cells
remain unknown and the UI explains the needed connector update. Full details
require installing the supplied 1.6.2-test update and refreshing the month. No
schema migration, reauthorization or configuration change is required.

Verification: TypeScript checks, shared table rendering, isolated PostgreSQL
publication/replay/replacement/holds/Last Payment tests, and 115 Python connector
checks (three Windows-only checks skipped on macOS). New cases cover Cheque
Return debit amounts, Journal exclusion, missing/flagged parties, invalid display
amounts, bounded all-voucher requests, matching notes and unchanged actuals.

The dealer summary's Voucher types / match column displays the original Tally
voucher type names (deduplicated per dealer/source ledger) instead of the generic
Review only note. Matched rows retain their matching status and also list their
Other voucher types. This uses saved excluded-voucher evidence immediately; no
connector update or fresh capture is needed for existing 1.6.2-test results.

### Territory dealer drilldown: Bill wise / Product wise — 19 November

The Territory Plan dealer drawer now has Bill wise and Product wise tabs. Product
wise retains its existing aggregated quantities/actual amounts and is the initial
view. Bill wise lazily requests only this dealer's stored source vouchers, grouped
by bill date with newest dates first. Each bill starts collapsed and shows its
original number/type and product subtotal; expanding it shows original Tally stock
names, quantities (six-decimal precision), units and source amounts. Blank numbers
use a readable placeholder while distinct database voucher identities keep equal
numbers separate. Credit Note quantities/amounts stay negative. Cancelled/optional
bills are labelled and remain excluded from sales totals. Financial-only vouchers
show that they have no product lines. Product subtotals are not invoice totals with
taxes or charges.

The authenticated read-only endpoint is
`/api/planning/groups/[groupId]/dealer-sales-bills`. It reuses getGroupProductPlan's
role/group checks, season/month range normalization, active group officers, current
dealer ownership (including the existing plan-owner fallback for legacy dealers),
and monthly status / Unplanned inclusion. Only snapshot IDs admitted by that same
policy can be queried. A shared group-plan-query.server parser keeps report and
bill query parameters identical. Category filtering keeps the source lines whose
resolved product IDs are in the dealer's current category-filtered Product wise
rows; all-category mode also shows unmatched source products with a mapping note.

Source-party attribution uses the exact alias/master-name policy from sales
publication, extracted unchanged into sales-party-names.ts. It detects collisions
across all aliases and avoids fuzzy guessing. Current alias changes affect source
bill lookup; an old name that no longer maps is not guessed. Product resolution
uses the shared source-name cleanup/unique resolver, including merged products.
No new connector, credential, data write or migration is required. Summary uploads
without source vouchers remain visible in Product wise; no bills are invented.

Files: dealer-sales-drawer.tsx, dealer-bill-list.tsx, dealer-sales-bills.ts,
dealer-sales-bills.server.ts, group-plan-query.server.ts, group-plan-page.tsx,
group-plan.server.ts and the dealer-sales-bills API route. Tally's sales.server.ts
uses the same extracted sales-party-names helper; its financial behavior is
unchanged. Verification covers real disposable PostgreSQL publication and bill
reads, signed returns, blank/duplicate numbers, date ordering, source product
names/quantities/amounts, alias changes, roles/groups/officer/status/month/range
filters, and existing aging/sales/Daybook regressions. Render checks cover both
tabs, lazy loading, retained Product wise output, collapsed bills and category
filtering. TypeScript checks passed.

### Daybook error information button — 19 November, 1.6.3-test

The Daybook failure message now has an accessible info button. Its dialog shows
company, read stage and exact requested date slice; voucher number/date/type,
party/dealer name, problem ledger, original signed amount, IsDeemedPositive,
IsPartyLedger, ledger line number, GUID, MasterID, AlterID, cancellation/optional
flags and narration. Up to 50 original ledger entries are listed with the problem
line highlighted when present. The total entry count and truncation explanation
remain visible; the offending line's details are retained even beyond the list.
Missing/invalid source values are shown as unavailable/raw text, never inferred
amounts. A timeout identifies its stage/date slice without inventing a voucher.

Connector daybook_capture.py now attaches bounded diagnostics to voucher parsing
errors and ambiguous/missing-credit review records. Optional MasterID, AlterID and
Narration are fetched for diagnosis. Metadata read failures have contextual date
ranges too. Control characters are represented visibly and text is length-limited.
The ledger-sign validation and fail-whole-month publication policy are unchanged;
this update identifies the issue rather than changing debit/credit calculations.

DaybookWorker.collect converts collector exceptions into an internal
`daybook.failure.v1` payload. It uses the existing encrypted outbox before sending
an authenticated `fail` with code and optional `details`. Lost acknowledgments
replay the same evidence without rereading Tally. The final retry-exhaustion
notification preserves the original diagnostic rather than replacing it with a
generic upload error. Successful captures retain daybook.capture.v1. No shared
SalesWorker transport behavior changed.

The website validates strict bounded diagnostics, binds company/month/date range
to the active connector lease, and stores them in the failed job's summary JSON.
Failure hashes make identical failure acknowledgments replay-safe; changed stale
attempts cannot overwrite the evidence. Existing fail messages without details
remain accepted, and the info dialog explains the 1.6.3-test upgrade/fresh-read
requirement for those older failures. Review-record diagnostics travel with the
existing complete-capture rejection. No database migration is needed.

Files: daybook-diagnostics.ts, daybook-error-details.tsx, daybook-sync.tsx,
daybook-preview.ts, daybook.server.ts and daybook.integration.test.ts; office
changes are daybook_capture.py, daybook_worker.py, sync_all.py and
tests/test_daybook_worker.py. Verification: real Python sign-error evidence through
the authenticated agent into disposable PostgreSQL/status; out-of-scope/oversized
diagnostics rejected; identical failed uploads replayed; existing Recovery/SRCR/
Last Payment preserved; 119 Python tests passed (three Windows-only checks skipped
on macOS); UI renders the info button, fields and escaped source strings; TypeScript
checks passed. Install the supplied 1.6.3-test package then request May's scan again
for the actual office voucher details; historical errors cannot be reconstructed
from their old error code alone.

### Exact encoding-failure evidence — 19 November, 1.6.4-test

The shared UTF-8 reader still rejects undecodable responses. Its EncodingRejected
exception now carries bounded byte evidence: original-file zero-based start/end,
decoder reason, rejected hex bytes, context start/hex/escaped text, total byte count,
XML encoding declaration when readable, recognized BOM and the full response hash.
A nearby simple ASCII XML field can be identified. Voucher metadata is recovered
only from independently valid UTF-8 fields inside byte-delimited voucher/ledger
blocks. This is labelled diagnostic recovery, not accepted accounting data. A BOM
at the response start does not implicate the first voucher. No replacement decoder
or guessed alternate encoding supplies any financial value.

Daybook captures encoding failures before attempting smaller intervals, saves the
original unchanged bytes under the existing state directory's sibling diagnostics
folder, and bisects failed date intervals down to one day when possible. Transport
or collection-budget failure during isolation retains the original encoding
response/evidence and records isolationError. Distinct file content is deduplicated
by its hash; at most 20 .bin captures are saved per month. File write/limit failures
are reported alongside the remaining evidence. A successful smaller read still
passes every existing XML/date/company/amount check. An unresolved failure keeps the
previous published month. No invalid response is repaired or directly imported.

The Daybook info dialog now presents exact byte/one-based position, rejected hex,
nearest field, decoder reason, declaration/BOM, escaped context, response size/hash,
and the path to the local .bin file. Available dealer/bill metadata remains visible
with the byte-recovery caveat. The full original response stays on the Tally PC;
only bounded diagnostic evidence is uploaded through the existing authenticated,
lease-scoped failure payload. Its original .bin file can be supplied for a deeper
audit; an earlier failed read's discarded response cannot be recovered retroactively.

Office changes: encoding_diagnostics.py (new helper), sales_sync.py,
daybook_capture.py, daybook_worker.py, sync_all.py, tests/test_encoding_diagnostics.py.
Website changes: daybook-diagnostics.ts, daybook-error-details.tsx, daybook-sync.tsx
and daybook.integration.test.ts. No schema or credential update. Install 1.6.4-test,
restart the existing combined runner and request June 2026 again. Verification:
127 Python checks passed (three Windows-only skipped on macOS), including invalid
UTF-8 in narration/ledger names, BOM offsets, UTF-16 markers, truncated sequences,
valid Unicode, single-day isolation, exact saved bytes, hash deduplication and
narrowing timeouts. Real Python byte evidence was saved/read through the agent API
in disposable PostgreSQL without changing financial values. Info dialog rendering
and TypeScript checks passed.
