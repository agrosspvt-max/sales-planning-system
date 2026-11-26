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


## 19 November: Identify unnamed Daybook vouchers (connector 1.6.5-test)

Unnamed excluded entries now show their original voucher type, number and date in the dealer summary. A ledger/stock-name overview and an initially collapsed Voucher details section identify each record; the same section is available for every excluded voucher. It displays available narration, individual ledger names, original signed amounts, debit/credit flags, stock names, actual/billed quantities, stock amounts and the voucher GUID. Missing party identification never assigns a bank/expense ledger as a dealer or creates a guessed aggregate amount. Other remains unknown when a single party amount cannot be identified.

`daybook_capture.py` requests inventory fields using the same AllInventoryEntries and nested ledger InventoryAllocations paths already used by the sales collector. Excluded vouchers now retain bounded diagnostic metadata, including up to 50 ledger and 50 stock lines with full source counts. Stock and ledger display values never feed receipt/SRCR totals, matching, Recovery or Last Payment. Source text controls are escaped for display; React escapes markup. Existing response/upload size limits and month publication guards remain in force. No migration or financial-rule change.

Website files: `daybook-voucher-details.tsx`, `daybook-result-tables.tsx`, `daybook-result-types.ts`, `daybook-diagnostics.ts`, `daybook-preview.ts` and `daybook-preview.server.ts`. Optional excluded-voucher details use the existing scoped diagnostic schema; company/date/month/voucher-GUID checks bind the evidence to the enclosing capture and record. Old connector captures remain accepted: their existing voucher references display immediately; missing ledger/stock breakdown requires connector 1.6.5-test and a fresh refresh. Both summaries remain collapsed initially.

Verification: actual Python Journal/Stock Journal output through TypeScript validation and React rendering; anonymous ledger evidence, signed amounts, stock quantities, safe markup, closed disclosures, older captures and mismatched evidence rejection. Disposable PostgreSQL publication/replay tests retain excluded ledger evidence without changing receipt/SRCR totals. TypeScript passed. Connector suite: 129 tests, 126 passed and 3 Windows-only skipped (the local-server tests were rerun successfully with local-server permission).

Update package: `outputs/Tally-Connector-Voucher-Details-Update-v1.6.5-test.zip` in the shared task directory. Includes all runtime files from 1.6.4 plus the new evidence capture. Preserve configured Windows folder, config/keys/state; install files, restart Run-All-Sync.cmd, then refresh the selected Daybook month. No live Windows/Tally run was performed from this Mac.


## 19 November: Payment allocations against multiple bills (connector 1.6.6-test)

Daybook now requests `AllLedgerEntries.BillAllocations.Name`, `.BillType` and `.Amount`. The original nested `BILLALLOCATIONS.LIST` entries are retained as optional `billAllocations` display evidence, with source ledger/allocation line numbers, ledger name, bill/reference name, reference type and original signed amount. Empty Tally list placeholders are skipped. Supported receipt/SRCR records retain allocations only from the exact credit ledger already selected by the existing parser; excluded/review vouchers retain all ledger contexts explicitly labelled. Financial totals continue to come solely from the original voucher credit amount. Allocation values do not alter Recovery, Last Payment, classification, matching or invoice balances.

The dealer summary retains individual credit vouchers (including alias-grouped dealers, unmatched ledgers and accounting ledgers). Under each named dealer, initially collapsed **Vouchers / bill adjustments** lists receipt/SRCR and excluded vouchers newest first. Each voucher opens its bill-reference table, including one row for each split adjustment. Excluded-voucher details show the same table. Duplicate reference names remain distinct source lines. Original `Agst Ref`, `Advance`, `On Account`, `New Ref` and custom labels are retained; blank names on advance/on-account entries display No specific bill. An absent evidence field means an older capture; an empty fresh list means no allocations were returned. Both have distinct messages. Existing stored summaries without individual credit rows require a fresh scan to expose receipt references.

Bill references are the names recorded in Tally, which may differ from printed sales voucher numbers; no invoice link, settlement status, allocation sum or bill date is inferred. Receipt source allocations are checked against the selected credit ledger before publication. Display arrays are bounded at 500 allocations per voucher, with the full source count and a visible truncation notice. Existing 2 MiB upload/8 MiB read limits apply. Missing source amounts remain unavailable, never fabricated zero. No schema migration.

Website files: `daybook-bill-allocations.ts`, `daybook-bill-allocation-table.tsx`, `daybook-dealer-vouchers.tsx`, `daybook-preview.ts`, `daybook-preview.server.ts`, `daybook-result-types.ts`, `daybook-result-tables.tsx`, `daybook-voucher-details.tsx`. Connector: `daybook_capture.py`, `daybook_worker.py`, `sync_all.py`. Official field and reference semantics checked against https://help.tallysolutions.com/sample-xml/ and https://help.tallysolutions.com/allocate-bills-for-payments-or-receipts/.

Verification: actual Python multi-bill receipt output through cloud validation and React rendering, split/partial allocations, source text escaping, advance/on-account distinctions, older captures, empty lists, duplicate identity rejection, and foreign-ledger attribution rejection. Python checks cover bank-side exclusion, duplicate bill names, signed excluded-payment amounts, fallback ledger XML, and 500-line/count handling. All 133 Python checks completed (130 passed, 3 Windows-only skipped). TypeScript and disposable PostgreSQL suites passed; saved dealer/excluded summaries retain exact bill references/amounts, replay succeeds and Recovery/Last Payment behavior remains unchanged.

Install `outputs/Tally-Connector-Bill-Allocations-Update-v1.6.6-test.zip` in the existing configured Windows connector folder, restart Run-All-Sync.cmd, and refresh each required Daybook month. This includes earlier 1.6.5 voucher-details and 1.6.4 encoding-diagnostic runtime files. Live Windows/Tally data capture remains to be confirmed on the office PC.


## 19 November: Resolve or diagnose dual ledger layouts (connector 1.6.7-test)

The blanket Daybook rejection when both `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` appear is replaced by conservative full-content comparison. A genuinely empty alternate list is ignored. Matching multisets of complete ledger-entry content are used once, preserving multiplicity within the selected section. Only outer whitespace, child order and the alternative root-list name are normalized; attributes, unknown fields, signs, zero amounts, flags, bill references, inventory allocations and their repeated occurrences remain part of comparison. Different or complementary populated groups are never summed or guessed. Iterative subtree hashes avoid recursion failures. The same selected layout drives credit parsing, excluded party evidence and bill allocations, so a placeholder primary list cannot suppress the populated fallback.

Populated conflicting layouts in supported Receipt/SRCR vouchers still fail with `DAYBOOK_LEDGER_LAYOUT_AMBIGUOUS`. The failed summary now contains both original ledger groups (source tag, counts, first 50 ledger lines, original names/amounts/flags, complete normalized-entry hashes and up to 20 bill-reference samples per group with per-line full counts). An unchanged original response `.bin` is archived on the Tally PC under diagnostics/daybook-layout-YYYY-MM-SHA.bin, SHA-256 identified and capped at 20 distinct files/month. File save failure or cap does not erase the bounded evidence. No full response is uploaded. Excluded voucher conflicts retain both source groups as display evidence without a guessed party amount or combined bill list and do not change Recovery rules.

The info dialog displays both sections and source-file/hash details, hides misleading single Problem ledger/amount fields for a whole-layout failure, and explains that no individual amount was identified as wrong. Older layout errors explicitly require a fresh read with 1.6.7 because they retained only one group. Ordinary voucher details show dual-layout evidence where available. Optional diagnostics additions are in `daybook-diagnostics.ts`; display components are `daybook-ledger-layout-details.tsx`, `daybook-error-details.tsx`, `daybook-sync.tsx`, `daybook-voucher-details.tsx`, and `daybook-bill-allocation-table.tsx`. No migration, Tally write, money correction or change to classifications/matching/Recovery/Last Payment.

Checks: 141 Python tests completed (138 passed, 3 Windows-only skipped). Added cases cover reordered duplicate fields, empty primary/fallback placeholders, amount conflicts, allocation-only differences, repeated-row count mismatches, flag-only/unknown-content alternatives, excluded conflicts, exact original-response saving, bounded evidence and deep source trees. Actual Python conflict output passes TypeScript schema/render tests and shows both sections plus nested bill differences; old errors get update guidance without fabricated problem-ledger labels. Disposable PostgreSQL tests publish a compatible dual layout once, replay safely, retain both conflicting groups and source-file metadata on failure, and preserve previous financial values. TypeScript checks passed.

Install `outputs/Tally-Connector-Ledger-Layout-Update-v1.6.7-test.zip` over the configured office connector, preserve config/keys/state, restart Run-All-Sync.cmd and refresh April. The actual alternate layout of CR/26-27/0001 has not been captured from the Tally PC by this Mac. A new read will either resolve a proven compatible pair or retain both conflicting groups and the original bytes for diagnosis.


## 19 November: Verified complete versus reduced Tally views (connector 1.6.8-test)

Inspection of the supplied unchanged April 8–14 response established that the native `LEDGERENTRIES` view omits requested party flags, bill reference labels and empty defaults which are present in `ALLLEDGERENTRIES`. Inventory-based returns also have complete-view accounting rows independently represented by the root inventory accounting allocations. The earlier full-signature equality rule therefore rejected valid complete/reduced pairs. This update supplements exact-duplicate handling with a narrowly verified complete-view policy; it does not prefer a tag solely by its name.

Every direct row must match a distinct complete-view row through full XML comparison with only these comparison-copy omissions: optional `ISPARTYLEDGER`, bill allocation `NAME`/`BILLTYPE`, and empty known VAT/inventory/cost-tracking/bill defaults. Financial fields, remaining attributes, unknown content and repeated rows are preserved. Present party flags/reference names/reference types must agree; missing labels may only be supplied by the complete view. Bill-allocation amount/count matching remains mandatory. A bounded one-to-one matcher preserves repeated allocations and row multiplicity (ambiguous comparison buckets above 128 stay held). Original trees and response bytes are never edited.

Additional complete-view rows require stronger proof: each is explicitly non-party, every signed amount and debit/credit/last-direction key must reconcile exactly with the independently returned root inventory accounting allocations, any second inventory representation must agree, and the complete ledger must balance exactly. Unknown additional rows, unmatched source totals, contradictory references/flags/amounts or unbalanced complete views remain rejected. Native requests now explicitly fetch inventory accounting name/amount/direction fields. Existing credit selection, sign guard, totals, classifications and Recovery/Last Payment behavior are unchanged.

New diagnostic resolutions are `enriched` and `inventory_complete`; schema/UI describe these successful comparisons accurately while retaining both groups. Website files: `daybook-diagnostics.ts`, `daybook-ledger-layout-details.tsx`, `daybook-ledger-layout.test.tsx`, `daybook.integration.test.ts`. Runtime implementation: `daybook_capture.py`; worker/banner version 1.6.8-test. No migration.

Actual response verification: SHA-256 `76de4a0b7ebe1f119582ef0795f7a520e51a7f771b391b05f141d801fc478b91`, 1,084,311 bytes, 152 vouchers. All 8 receipts and 16 SR/CR records parse without unresolved credit reviews and exactly match an independent single-complete-view baseline, including original bill allocations. All 51 dual sections reconcile (9 enriched, 41 inventory-complete and 1 empty alternate); all 152 financial/reference records also match the single-complete-view baseline. Signed round-off values are compared exactly in the view-consistency check; the posting parser retains its original separate sign guard. Excluded vouchers remain outside supported credit totals. Five deliberate actual-packet mutations (amount, reference, party flag, multiplicity, inventory-account amount) were rejected. Original file/checker/report remain private in the task workspace; no source accounting packet or real party data is committed or packaged.

Verification: 146 Python tests completed (143 passed, 3 Windows-only skipped), including focused assertions for unbalanced complete-view rejection and unchanged posting sign rules. Actual parser/schema/render tests and TypeScript checks passed. Isolated PostgreSQL tests publish enriched pairs once, preserve bill references/replay behavior, retain conflicts and leave previous values intact on failure. Official object-model references reviewed: https://help.tallysolutions.com/how-to-customise-voucher-and-invoice-using-tdl/ and https://help.tallysolutions.com/appendix/. These distinguish ledger and inventory collections; the compatibility policy itself is justified by explicit packet comparisons and source reconciliation, not inferred from collection names alone.

Install `outputs/Tally-Connector-Complete-Ledger-Update-v1.6.8-test.zip`, preserve config/keys/state, restart Run-All-Sync.cmd and refresh April. The supplied file is one April date range, not the complete month; a fresh office read remains necessary to confirm all April intervals and publication. No actual Tally or website financial records were changed during packet verification.


### Daybook referenced-bill products — 19 November

Published Daybook bill allocations now offer a collapsed **Products in bill** view for each nonblank `Agst Ref` reference. It reads the same `TallySalesVoucher` / `TallySalesItem` records used by Territory Plan → dealer → Bill wise. Product names, decimal quantities, units and source line amounts are preserved, including unmapped product names. The full bill amounts are labelled separately from the payment adjustment; no amount is spread across products. Cancelled/optional bills and product-less bills are explicitly identified. No connector update, migration or fresh Daybook capture is needed for already published allocations.

The read-only `/api/tally/daybook-bill-products` route requires the approved Daybook Preview and Super Admin access. It verifies the successful saved job, voucher and allocation before resolving the original party/reference; client-supplied party names cannot drive lookup. Matches stay within that capture’s enabled connection, use exact reference numbers and the shared Territory exact dealer/alias attribution, and search all saved months. Identical saved copies are deduplicated; conflicting bills/versions remain ambiguous. Missing bills (including uncaptured older-year bills) explain why products are unavailable. Advance/on-account entries do not become invoice links. Supplier payment/purchase references are outside the saved sales-bill lookup.

Validation covers lazy disclosure loading, original escaped names and decimal quantities/amounts, error retry, empty/cancelled/missing/ambiguous bills, advances, multiple allocations, earlier-month sales, exact aliases, forged-reference rejection, role/connection boundaries and unchanged Recovery/SRCR/outstanding values.


## 20 November: Daybook-only product display and read-only Sales comparison (1.6.9-test)

The Daybook bill-product view no longer reads `TallySalesVoucher`/`TallySalesItem`. It reads independent product evidence captured from the same Daybook Voucher responses, including original quantities, units, amounts and creating New Ref names. Included Sales/return/credit-note vouchers can also open their own product lines. Missing/legacy/incomplete Daybook data explicitly remains unavailable, with no fallback to Sales. Exact company, captured voucher/allocation, party/confirmed aliases and printed/creating reference checks remain required. Latest successful Daybook captures from other approved months may supply older referenced bills; conflicting matches are held.

Connector `daybook_products.py` obtains real canonical voucher-type families and applies the existing Sales normalization to independently read Daybook XML. It preserves all product lines within global bounds, repetitions, original actual/billed quantity text, rates and financial ledger amounts. Product-only read/normalization errors produce unavailable evidence while retaining the established financial capture. Blank price-credit quantities are displayed as unrecorded; normalized return quantities retain their negative convention with original Tally quantity text shown alongside. Existing Sales collector, Sales publication, MonthlyEntry/TallySalesActual and Territory code are unchanged.

The product evidence is optional and stored under `_daybookProducts` in the successful Daybook job summary, committed with that capture. It is stripped from normal status responses and fetched on demand. No database migration or config-key change is required. Existing encrypted outboxes without evidence remain valid. The bounded Daybook request/outbox limits are increased from 2 MiB to 4 MiB on both sides, below the hosted request-body ceiling. The supplied June financial plus complete product payload is 2,567,539 ASCII JSON bytes; it would not fit the prior limit. Oversized comparison evidence is explicitly unavailable rather than displacing financial rows.

The new `/api/tally/daybook-sales-comparison` read-only Super Admin route compares exact-period saved company-wide Sales/Credit Note sources by GUID, identity/status, product-line multisets (including repeats), quantities, units, signed amounts, source quantity text/rates and financial ledger multisets. It does not compare filtered Territory rollups or write financial/planning data. Different periods or incomplete/missing captures cannot return matched. The info dialog shows capture times, all matched/different/missing counts, and bounded side-by-side detail. Different capture times may reflect intervening Tally edits.

Verification: 162 Python tests completed, 159 passed and 3 Windows-only skipped; new tests cover canonical renamed types, product/reference preservation, financial versus quantity credits, unchanged financial output on product failure and size fallback. Rendered product/comparison UI and schema tests, TypeScript, full Next lint (existing warnings only), and all isolated PostgreSQL aging/sales/Daybook suites passed. Database tests publish complete evidence through the normal agent, verify omission from polling, change independent Sales quantities/ledger amounts to prove display independence and comparison differences, and cover matched/missing/ambiguous/cancelled/duplicate/empty/history/period/role/company cases. The supplied June responses yield 307 product vouchers and validate with no financial reviews using an offline catalogue of audited type labels; the office update reads its real catalogue from Tally. No actual saved Sales figures or office accounting records were modified during verification.

Install `outputs/Tally-Connector-Daybook-Products-Comparison-v1.6.9-test.zip` (in the shared task workspace) over the configured runtime, preserving config/keys/state. Restart Run-All-Sync, refresh the selected Daybook month, then use Compare with Sales. Archive SHA-256: `349e2a9f8163a2d3b7b82b8496615c92b4de165f5a29f0fe67ff1e1ec0d3feab`. Actual Windows installation and the live comparison remain to be performed on the office PC.

### 20 November: Simplified dealer-first Daybook display

The Daybook review now uses full-width dealer disclosures with Sales first, then Receipts, Returns & credit notes, and Other. Bills open directly to their independently captured Daybook product/quantity/unit/amount table. Receipts retain all split bill references and their separate adjusted amounts. Dealer/bill search is available. Repeated voucher titles, ledger names and explanatory paragraphs are removed from the primary view; original voucher, product, raw quantity, reference, ledger, narration, source and matching information remains in collapsed info disclosures. Cancelled/optional transactions remain under Other; ambiguous/unnamed vouchers remain separately accessible as Unassigned vouchers, without repeating them in an excluded archive.

This is a presentation-only change. Existing published dealer totals, Recovery/Last Payment behavior, product lookup/comparison routes, connector capture, Sales collection and Territory Plan calculations are unchanged. No connector update or database migration is required. Validation covers exact alias grouping, transaction order, deduplication, cancelled-only and unassigned retention, search, unchanged totals, original information rendering, lazy product disclosure and prior layout diagnostics. TypeScript and full Next lint pass (existing unrelated warnings only). The layout was visually reviewed with synthetic dealer/bill/receipt data.

### 20 November: Daybook batch upload (connector 1.6.10-test)

Daybook captures larger than 256 KiB now travel as numbered 256 KiB ASCII-JSON batches rather than one monthly request. Each encoded request stays below 1 MiB; the bounded complete capture is up to 32 MiB. The earlier 4 MiB product-evidence fallback no longer discards ordinary larger months. The existing financial fallback applies only if the complete capture exceeds the new overall bound. Existing small inline uploads and old encrypted outboxes remain compatible.

The authenticated agent accepts an immutable byte-count/batch-count/SHA-256 manifest, validates each source-lease-bound batch's length and checksum, and reassembles by sequence. It validates the final size/hash and all existing company/date/voucher/product constraints before one atomic publication. Partial captures never replace published figures or become comparable. Duplicate batches and lost final acknowledgements are safe; the encrypted office outbox persists its next acknowledged batch for restart without rereading Tally. Valid batches renew the active lease. Staged content is deleted on publication, explicit/validation failure, or expired-job cleanup; it is never stored in public status summaries.

Additive migration `20261120000000_tally_daybook_batches` adds the job manifest and `TallyDaybookChunk`. The existing pinned test-Preview schema guard applies it, rejects partial schema state, and is idempotent. There is no change to Sales collection, Aging, Territory actuals, receipt/SRCR calculations or product comparison rules.

Validation: 164 Python checks (161 passed, 3 Windows-only skipped), TypeScript and Next lint (existing warnings only), plus the full disposable PostgreSQL Aging/Sales/Daybook suite. The real Python sender streamed a synthetic month exceeding 4 MiB with 12,000 original product lines through the actual cloud agent/database. Checks cover missing, changed, duplicate, out-of-order, bad-hash and oversized batches; lease rotation/renewal/expiry; interrupted uploads, completion replay, cleanup, and unchanged financial figures before complete publication. The schema upgrade was applied twice to the previous schema successfully. Install `outputs/Tally-Connector-Daybook-Batches-v1.6.10-test.zip` over the configured office runtime, preserve config/keys/state, restart Run-All-Sync, then refresh the affected Daybook month. Actual office installation/live July recapture remains to be performed on the Tally PC.


### 20 November: Exact comparison diagnostics

The read-only Daybook/Sales comparison now names the fields that differ and shows both saved values: printed bill number/date, party, voucher type/family and cancelled/optional flags. Product differences retain original quantity/unit/amount/raw quantity/rate combinations and occurrence counts; equal totals cannot hide different repeated lines. Ledger differences show each original signed amount and occurrence count. The existing GUID pairing, equality rules and full-period counts remain unchanged; Master/Alter IDs are displayed as diagnostic metadata and do not create new financial mismatches.

Each side shows its original GUID, Master ID, Alter ID, party, signed party-ledger net where that exact party ledger exists, signed full product-line total, source capture time, and original Daybook narration/raw flag text/creating references where already saved. Missing amounts remain unavailable rather than zero; party-ledger sums are labelled separately from product totals. Original source products and ledgers remain accessible with count/truncation notices. Cancellation/edit timestamps are explicitly Not captured. Capture times and alteration IDs are never presented as cancellation/edit times, and saved flags are not asserted to be current live Tally status.

An additional disclosure searches both complete captures in the selected period for other GUIDs using either printed bill number, retaining each separate voucher’s own party, flags, amounts and identity. This can distinguish a cancelled record from an active branch voucher sharing a number without guessing which represents the current Tally bill. It is not an all-history/live existence search. Existing role/company/successful-job guards and the bounded comparison response remain in place. No connector or schema change is needed, and no financial/plan publication behavior changed.

Validation: product/comparison rendering and schema checks, TypeScript and full Next lint (existing unrelated warnings only) passed. The full isolated PostgreSQL Aging/Sales/Daybook suite passed with a fixture containing a cancelled/optional same-GUID record with changed printed numbers plus a separate uncancelled branch voucher sharing one number; exact fields, distinct GUIDs, party/product amounts, raw narration/flags and unchanged financial values are verified. The actual components were visually reviewed using synthetic data. No live office voucher/cancellation facts were inferred from these tests.


### 20 November: One user-approved ignored comparison case

At the user’s explicit request, the cancelled/optional July record at Master ID 65845 is excluded from the mismatch count only for its printed-number discrepancy. The predicate requires the exact company, full July period, GUID, Master/Alter IDs, voucher date/type/family, empty party, no product or ledger lines, both cancelled/optional flags, and differing numbers in the same CG/RB/26-27 series. Changing any of that other source data restores normal checking. Another record, a missing side, a different company/period and the active branch voucher remain fully checked. Identical records still count as matched normally.

The API reports matched_with_ignored when this is the only discrepancy, keeps the genuine matched count unchanged, and adds a separate ignoredBills count and ignoredCases evidence. The UI shows a collapsed Ignored cases section with the original values/identities/details. It does not claim every bill matches, remove source records, alter existing captures or change Sales/Territory/Recovery/Last Payment calculations. No connector/schema update or fresh capture is required.

Validation: scope/identity/status/party/product/ledger/series guard tests and ignored evidence rendering pass; TypeScript and full Next lint pass (prior unrelated warnings only). The complete isolated PostgreSQL suites pass, including the actual exception path, a separate active same-number bill whose quantity mismatch still gets flagged, status changes restoring normal checking, missing-side detection, preserved ignored evidence and all prior financial regressions.

### 20 November: All / Dealers only Daybook views

The dealer list now defaults to All and offers a Dealers only button with its own count. Dealers only uses the saved capture's confirmed website-dealer identity: matched and held dealer rows, identified sales/other-only dealer rows, and confirmed cancelled/optional-only parties. Unlinked Tally names, accounting ledgers and unidentified vouchers remain available under All. Filtering follows the existing grouping, so each included dealer retains all captured transaction groups, product details, bill references, amounts and search behavior.

This is a display filter only. No capture, matching, comparison, financial calculation or Territory Plan source changes. No connector update, migration or refresh is required. Dealer grouping/filter and actual component render checks pass, including sales-only/held/cancelled-only inclusion, unlinked/accounting exclusion, retained receipt references and All retaining unassigned evidence. TypeScript and Next lint pass (existing unrelated warnings only).

### 20 November: Product amounts before GST and bill tax breakdown

Dealer Sales and Returns & credit notes headers now sum the independent Daybook product amounts excluding invoice GST. Each bill header uses the same subtotal; receipts retain their full payment amounts. Sales no longer contribute to the display's Other total. Cancelled/optional vouchers remain accessible under Other but do not enter the active header sums. Original captured gross totals remain under Dealer & matching details and Voucher details. Missing product evidence shows a dash, never a GST-inclusive fallback or fabricated zero.

The authorized Daybook product lookup also returns a bill breakdown: product subtotal, nonzero named CGST/SGST/IGST/UTGST/Cess ledger amounts, other adjustments and bill total. The total is the negated net original party-ledger amount. Other adjustments are the exact residual after product subtotal and identified tax ledgers; unnamed/unrecognized differences are not labelled GST. Tax rates are never inferred from price differences. Original ledger names/amounts remain expandable. Returns retain their negative product/tax/total convention. Missing party ledgers or product lines remain explicitly unavailable. All display arithmetic uses integer paise.

The public status response derives a compact per-GUID subtotal/family/active index from the existing successful product capture. Full product/ledger comparison evidence stays out of polling; full bill details load on demand. Existing captures work immediately, without a connector update, migration or fresh Tally read. Sales capture/publication, comparison equality, Recovery, Last Payment, aging and Territory Plan figures remain unchanged.

Validation: source-tax/no-inferred-tax, signed-return, paise, missing/zero data, deduplication, separate sales/receipt/other display, cancelled exclusion, dealer/bill headers and breakdown rendering tests pass. TypeScript and Next lint pass (existing unrelated warnings only). Full isolated PostgreSQL Aging/Sales/Daybook tests pass, including compact status headers and tax/party totals through the authorized lookup, existing independent-source and financial-preservation checks.

### 22 November: Missing dealer Excel export

Missing Dealers and Products → Dealers now has an Export missing dealers button beside Refresh dealers from Tally. It downloads Tally-Missing-Dealers.xlsx from the same authorized scan summary shown in the table, including all unmatched rows, row numbers, original Tally dealer names and all group names. The Missing Dealers sheet has column widths and an Excel filter. A separate Scan Details sheet records the successful scan time in IST and checked/matched/unmatched counts. Names remain literal spreadsheet strings, including Unicode and formula-like names. Export is disabled while loading, without unmatched rows and during export; download failures allow retry.

The spreadsheet library loads on demand. No additional endpoint, permission, connector, matching, database or financial changes. Verification round-trips a real XLSX buffer containing 582 synthetic unmatched rows, checks the final off-screen row, multiple groups, exact names, literal text cells, filter range and scan metadata, and renders enabled/disabled button states. TypeScript and lint for changed files pass. No live dealer data used or changed during testing.

### 23 November: Explain net product sales and deductions

Audit of Territory Plan → dealer → Product wise confirms that the saved Sales publisher adds signed mapped product quantities/amounts from Sales and Credit Note vouchers, including returns and zero-quantity value credits. Cancelled/optional vouchers are skipped; credit notes without product lines are counted as unallocated and do not get distributed to products. Territory aggregation and its product/dealer summary preserve those signed totals. Positive product balances may already contain return/credit deductions, so summing only the negative product rows is not a gross-return audit.

The drawer now labels the existing figures Net Qty, Net Sales and Net Sales Total, highlights negative values and explains product-linked deductions, value-only credits, unallocated credit notes and excluded statuses. Available original Tally vouchers remain under Bill wise. No amounts, totals, financial logic, source, filters, API or connector behavior changed. TypeScript and changed-file lint pass. A one-off render check verifies positive/negative balances, a zero-quantity credit, hidden all-zero rows, original total and immutable source values. No live dealer data queried or changed.

### 23 November: Separate Sales / Returns / Credit notes in the product drawer

The user clarified that labels alone were insufficient: each product needs a real split while retaining the existing net. The dealer drawer now reads the existing authorized Sales-bill endpoint in both modes and shows Sales, Returns, Credit notes and Net sales columns, each with quantity and amount, plus separate monetary totals. The original product/dealer net values remain authoritative. Negative-only products and verified sale/full-return pairs with zero net remain visible. Amounts show two decimals to avoid rounding away differences in the breakdown. The drawer is wider, with horizontal scrolling on narrow screens, and displays the active included-plan and Unplanned selection.

The endpoint adds source product breakdowns from saved TallySalesVoucher/TallySalesItem records in the same existing ownership, period and plan-status scope. Sales-family lines go to Sales; Credit Note-family vouchers explicitly named Sales Return go to Returns; other Credit Note-family vouchers go to Credit notes. Original signed values and zero-quantity credits are retained. Cancelled/optional records remain excluded. Shared surviving-product resolution is unchanged. A split is displayed only when it reconciles to the authoritative product quantity/value at six/two decimals and the history is complete and not held. Unknown/manual/changed-match histories display unavailable split cells while preserving net values; no gross sales are inferred from a net balance. The group report adds only an internal history-completeness flag, set when selected uploaded actuals without bill evidence contribute; no aggregation arithmetic or filtering changes.

Credit notes without products are listed separately with their original signed party-ledger amount where captured, explicitly outside the product total and potentially including taxes. They are not distributed across products or deducted again. Category-filtered views cannot add source products outside the selected product scope. Current client values are checked against the fetched breakdown to avoid showing a stale source split after report changes.

The two user screenshots have different Unplanned selections (earlier checked, later unchecked). Existing filter defaults remain unchanged; enabling Unplanned again restores the same scope for comparison. No connector, schema, source collection, posted amount, Recovery or Last Payment changes.

Verification: dedicated source/render tests cover sales/returns/credits on one product, return-only and credit-only negatives, zero quantity and zero net, exact paise, cancelled/optional exclusion, missing/held/manual/mismatching evidence, immutable inputs, category bounds and original net preservation while loading. TypeScript and changed-file lint pass (prior warnings only). Full disposable PostgreSQL Aging/Sales/Daybook suites pass, including real endpoint split and unallocated amounts, unchanged actuals after reading, and negative-only activity with the existing Unplanned scope. Synthetic browser review confirms separate columns, signed quantities/amounts and totals; temporary viewport/server cleaned up. No live financial data used or changed.

### 24 November: Collapse the complete Daybook dealer list

The Dealers heading is now a native disclosure with an arrow that opens/closes the entire list. It starts collapsed. All / Dealers only controls and counts remain outside; search, explanatory details, individual dealer disclosures and unassigned vouchers remain inside. The existing per-dealer arrows are unchanged. No data, matching, filtering, totals, endpoint or connector changes. Existing Daybook table and bill-amount render checks, TypeScript and changed-file lint pass. Synthetic browser interaction verifies initial collapse, list expansion, independent dealer expansion and full-list collapse hiding the expanded dealer/search without losing the counts. No live data used; temporary server stopped.

### 24 November: Daybook month duration

Daybook sync now has From month and To month, inclusive, retaining a single-month view when both are equal. The initial range remains the current approved month. A range displays the latest successful capture for each selected month in one dealer-first list, keeping All / Dealers only, search, collapsed dealer list, individual bill/receipt sections and pre-GST values. Confirmed dealers combine by their saved dealer ID; unlinked names are not guessed into confirmed dealers. Each voucher retains its original month/job for product and referenced-bill lookups. Original monthly totals and matching evidence remain available in dealer details, and month status/comparison cards provide a View month shortcut.

Repeated voucher GUIDs across selected snapshots appear once using the latest published capture, including its exact source-bound header; there is no fallback to an older product header. The repeated-ID count is disclosed, and original months remain individually inspectable. Missing or legacy months are identified; incomplete dealer period totals show a dash while retained vouchers and original monthly evidence remain visible. This is a read-only presentation union, not a replacement financial snapshot.

The existing authenticated endpoint now also accepts an inclusive month range. Legacy single-month GET/POST remain supported. Range reads pin one enabled connection and return independently authorized monthly publications, keeping last successful data visible after failed refreshes. Refresh selected months queues ordinary independent month jobs under the existing connection lock and skips already queued/running months. Approved-preview, Super Admin, company, fiscal-year/current-month and product-source authorization boundaries remain unchanged. No connector/schema update, Sales source switch, Recovery/Last Payment/Aging calculation or financial write was added.

Validation: range calculation and actual component rendering cover exact signed totals, alias changes, source identity, duplicate/moved/unassigned vouchers, unavailable headers, missing/legacy captures, original evidence and collapsed display. Existing Daybook view/table/product/bill amount suites pass. TypeScript and scoped Next lint pass. Full isolated PostgreSQL Aging/Sales/Daybook suites pass, including latest-success selection, missing/company isolation, invalid ranges, role/preview guards, overlapping range/single refresh idempotence and unchanged financial data. Synthetic browser interaction verifies range controls, combined dealer/bill records, missing-month notice, refresh bounds and View month. No live financial data was used for these checks.

### 24 November: Credit Note and Sales Return filters

Daybook now adds Credit Note with qty, Sales Return W/O qty and Credit Note with product beside the existing All / Dealers only scopes, for both a single month and a month range. The user explicitly confirmed that Sales Returns must remain separate from the Credit Note filters. Credit Notes are identified by the saved Credit Note family excluding saved Sales Return type names; custom Credit Note types remain supported. With qty means any non-zero product line quantity, including original actual quantity on a zero-billed line. With product includes zero-quantity value adjustments. Sales Return W/O qty requires complete saved product evidence with no stock lines or only zero/blank quantities. Missing or unreadable evidence never becomes a guessed zero. Cancelled/optional vouchers are excluded from the new filters and retained in the original scopes.

The authenticated existing status projection derives only three compact Credit Note flags from validated saved Daybook product records, preserving the existing Sales header shape and stripping full product evidence as before. No per-voucher fetch, Sales collection fallback, new endpoint, connector update, schema or financial write is needed. Range union retains the latest voucher source and its matching flags. New scopes retain only matching vouchers under each dealer, so visible totals also cover only those vouchers. Original full-period matching/capture totals remain inspectable and are explicitly explained. Tab counts are dealers; matching unassigned vouchers remain separately identified. Search, All / Dealers only behavior, original source-bound bill detail requests and collapsible lists are preserved.

Validation: calculation/actual-component cases cover distinct Credit Note vs Sales Return types, custom Credit Note types, actual/billed non-zero quantities, zero/no product lines, unknown evidence, cancelled/optional records, exact signed filtered totals, immutable source, range duplicate/latest-source flags, unassigned handling and all five tabs. Existing Daybook table, view, range, pre-GST and product suites passed, plus TypeScript and changed-file Next lint. Full isolated PostgreSQL Aging/Sales/Daybook suite passed with compact flags exposed and full product evidence withheld. Synthetic browser interaction confirmed each new scope's voucher membership and totals and restoration of All. No live financial data was used.

### 24 November evening: Fresh test database endpoint

The user created `tally-test-fresh-20261124` from production's current data/schema in Sale Planning Module, retained the prior `tally-integration-test` branch, and confirmed the new pooled/direct/expected-host settings were saved for Preview on `codex/tally-billwise-test`. The approved endpoint digest now pins only the fresh branch's normalized hostname. Existing Preview/Git branch/host matching checks and additive schema preparation remain unchanged; production remains excluded. Matching synthetic pooled/direct URLs passed the actual guard; production, main and mismatched settings were rejected. Old branch Tally captures and registration are not automatically copied from that former test branch; connector availability and capture coverage must be checked on the fresh branch after deployment.
### 25 November: Bound the existing Sales actuals lookup

The supplied November Sales logs fail after `plan_lines_ready` with Prisma P2035: 32,770 bind values exceed the 32,767 limit. Publication reads every eligible plan line, including zero actuals, so selecting one calendar month can still exceed this limit. Connector retry messages mask this deterministic server error as temporary unavailability; successful Daybook/Aging publications do not establish Sales success.

The existing MonthlyEntry comparison now groups exact season-month IDs, deduplicates read IDs and reads at most 1,000 plan lines per query sequentially inside the original publication transaction. All rows still participate in the existing signed-decimal comparison and writes. A `previous_actuals_read` stage reports only the row count. No calculation, missing-ledger policy, financial source, transaction boundary, connector, schema or credential changes.

Verification: real disposable PostgreSQL publication with 110 additional dealers and 33,000 plan lines passes. Captured monthly SELECT parameter counts remain bounded; exact negative six-decimal quantity and paise, all 33,000 planning quantities/values, unchanged zeros and a stale actual cleared in the final batch, rate/NBV snapshots, another month's actuals and idempotent refresh are preserved. Full isolated Aging/Sales/Daybook suites, TypeScript and scoped Next lint pass (existing lint warnings). Tests use synthetic data only. Hosted November success must be confirmed by the next connector publication; no connector update or re-pairing is required.

### 25 November: Daybook Credit note without product filter

Added Credit note without product beside the existing Daybook scopes. It selects active Credit Note-family vouchers with explicitly saved hasProducts:false, excludes Sales Returns as previously requested, and retains custom Credit Note types. Missing/legacy product evidence does not become an empty product list; zero-quantity product lines remain with product. Existing dealer counts, search, collapse, unassigned records and single-month/range source handling apply. Product subtotals remain unavailable for vouchers without products; original voucher details remain accessible. No financial calculation, Territory/Product Plan, API, schema or connector changes.

Checks: actual filter/render tests cover empty/custom/cancelled/optional vouchers, nonempty zero-quantity lines, unknown evidence, unassigned records, latest range source, immutable totals and the new tab label. Existing Daybook table/view/range/bill-amount suites, TypeScript and scoped Next lint pass. No live data used or changed.

### 25 November: Dealer product drawer NBV Sales column

Added NBV Sales immediately after Returns in Users → state/group → Territory Plan → dealer → Product wise. Each row displays its existing product actualNbv and the footer displays the existing dealer actualNbv, with two decimal places and negative highlighting. This is the NBV of net product sales already used by the parent Territory Plan, not a fresh calculation from the currently displayed product percentage. Existing authoritative NBV remains available when the bill split is loading, held or unavailable. A nonzero NBV row remains visible even when its net quantity/amount are zero; verified fully offset bill-only rows without a report entry carry zero NBV. Six-column empty state and horizontal scrolling retained. No API, connector, financial formula, source, plan filter or non-product credit deduction changes.

Checks: real component rendering verifies header position, signed exact row values, authoritative footer, loading/held preservation, zero-net/nonzero-NBV visibility, empty state and immutable inputs; existing breakdown/category/status/reconciliation checks pass. TypeScript, scoped Next lint and diff checks pass. No live financial data used or changed.

### 26 November: Territory dealer net sales after financial credit notes

User authorized dealer-level Net Sales = existing product actuals (already including returns and product-linked credits) plus the remaining signed Credit Note-family vouchers without stock lines. Actual Sales, Actual NBV, achievement percentages, dealer totals and Territory Excel export now use the same adjusted dealer summary. Product Plan, product rows, original published financial data and other sync channels are unchanged. User explicitly chose to apply these credits only with All Categories selected; category views retain product figures and identify that scope.

The dealer Product wise drawer renames Net sales to Sales before other credits. Its Total row retains original product amount/NBV. Immediately below, a collapsed Credit Notes row shows the additional signed credit amount in the last column and its NBV adjustment under NBV Sales; expansion lists voucher number/date/type/amount. A final Net Sales row shows both adjusted totals. The NBV reduction uses the dealer's total NBV divided by product sales before these additional credits; e.g. 100/15 with a -10 credit becomes 90/13.50. Integer paise arithmetic applies the signed proportional adjustment with half-away-from-zero rounding. No additional credits preserves original full-precision actuals. Zero sales with nonzero credits produces a valid net sales amount but unavailable proportional NBV; negative nets are not clamped.

Read-only credit metadata comes from the same latest Sales captures, unique exact dealer-name attribution, current ownership and monthly approval/Unplanned/period scope as the report. Cancelled/optional vouchers and any voucher with stock lines are not additionally deducted. Repeated GUIDs in selected months use the latest capture, including suppressing an older credit if the latest copy is cancelled or has products. Recorded signed party-ledger voucher totals (including any recorded taxes) follow the existing displayed financial-note amounts; no tax rate is inferred. No Daybook source switch. Missing/invalid party amounts, held/uncaptured periods, orphaned current name attribution or publication changing during the read withhold affected net figures and achievements rather than substituting zero; product figures remain inspectable. Credits-only dealers remain visible even without product rows. No schema, connector or migration change.

Validation: npm run test:territory:credits covers the user's example, exact signed paise/rounding, negative/zero/unknown values, unchanged product inputs, category policy, dealer-only credits, achievement and real XLSX parity, and collapsed/expanded detail rendering. Existing product breakdown guards pass. Full disposable PostgreSQL Aging/Sales/Daybook suites pass, with real report tests for double-deduction prevention, proportional NBV, cancellation/optional/officer filters, Product Plan preservation, missing credit amounts, alias changes, duplicate range GUID/latest cancellation and single-month isolation. TypeScript and scoped lint pass (existing warnings only). Actual React component browser preview verifies column alignment, unchanged Total, -10/-1.50 credit row, 90/13.50 net row and expand/collapse. Temporary server stopped; no live financial data read or changed for testing.

### 26 November: Product Plan credit summary and dealer drilldown

User requested the same additional financial-credit effect in Product Plan, with original Total values collapsed behind a small arrow, a distinct financial Credit Notes row, and a visible Net Sales row. Added the footer without changing any individual product, quantity, plan or baseline figure. Credit Notes has a minus icon, semibold red text, subtle deduction background and separating border; Net Sales has a stronger final-total treatment. Only Act. Amt and Act. NBV carry values in these two rows, shown to paise. The fixed first-column backgrounds match those financial rows opaquely. The previous Total values remain available with the small toggle.

Credit Notes opens a right-side drawer of filtered dealer credit totals and NBV adjustments. Selecting a dealer shows its actual note number/date/type/signed amount; each voucher expands to original month/reference and recorded amount. Back returns to dealers; Close restores focus. The drawer displays selected period, season, team member, plan scopes and category. It uses already authorized report metadata, with no extra per-voucher requests or alternate source.

Product-mode report now emits the same scoped financial-note metadata and dealer/product actual bases used by Territory Plan. Product aggregates themselves are untouched. Following the user's total-level proportion clarification, the footer uses total original NBV divided by total original sales to adjust the combined credit amount. Individual dealer rows and drawer details still use each dealer's own NBV proportion. A reconciliation check against visible product actuals withholds a mismatched net. The existing All Categories rule is preserved; category selections keep product figures and label credits not applied. Missing/held/invalid credit evidence still withholds affected figures. A dealer with zero sales no longer makes a valid overall NBV total unavailable; zero overall sales with nonzero credits still has no calculable NBV proportion. Selected-month/latest-GUID policy, exact current name/owner/approval scopes and original voucher signs are reused. Product Excel export retains original Total and adds matching Credit Notes/Net Sales rows outside the product autofilter, with no fictitious quantities. No database financial write, schema, connector or source change.

Verification: npm run test:product:credits covers mixed dealer NBV rates (total 200/45 with credits -30 gives 170/38.25 and NBV adjustment -6.75), unchanged source products, category/mismatch/unknown/credit-only/zero handling, both amount-column modes, collapsed totals, rendered row positions/styling, dealer-specific note details and actual XLSX parity. Existing Territory credit/breakdown regressions pass. Full disposable PostgreSQL Aging/Sales/Daybook suites pass, with real Product Plan metadata/base/footer assertions and double-deduction protection. TypeScript and scoped lint pass (existing warnings only). The initial component browser preview checked original totals open/close, styled footer, drawer dealer → note → original details, Back/Close/focus restore, precise amounts and sticky first-column colours; rendered regression checks cover the updated total calculation. Temporary preview server stopped and tabs closed. No live financial data used for checks.

### 26 November: NBV totals after the total-level proportion clarification

Both Product Plan Net Sales NBV and Territory Plan Total Actual NBV use the original total NBV/sales proportion, applied once to all additional credits for the active selection. For total sales 100, total NBV 15 and credit -10, net sales is 90 and net NBV is 13.50. Territory Total NBV Achv % uses this adjusted total; both Excel exports match. Dealer rows keep their individual NBV proportions, so their adjusted NBVs can differ in sum from the total-level proportion. The page and credit drawer explain that distinction. Missing credit evidence remains unavailable, and no rate is invented when the overall sales base is zero. Tests cover these cases, exact signed rounding, credit-only dealers, unchanged category/product/dealer figures, rendered totals, and XLSX parity.

### 26 November: Show all column totals in Net Sales

At the user's request, Product Plan Net Sales now repeats the original totals for every other visible column: Season Qty, Planned (All Mo.), Remaining, Season Sales, Pending, Period Plan, Period Sold, Plan Amt and Plan NBV, plus optional amount columns when enabled. Only its Actual Amount and Actual NBV use the existing credit-adjusted figures. Credit Notes still has only financial deductions; the original Total remains collapsed by default. Existing quantity precision and negative comparison colours are preserved. Excel Net Sales carries the same full set of totals. Existing footer render and XLSX checks cover both Show Amounts modes and both original-total expansion states. No calculation, report-source, database or connector change.

### 26 November: Credit deductions excluding GST

Additional credit notes without products now deduct their signed original party total less the recorded CGST/SGST/IGST/UTGST/Cess entries. This updates the earlier gross-total credit policy. A shared exact-paise ledger reader supplies the planning credit metadata, dealer bill lookup and Daybook amount breakdown. For -60,600.00 total and two GST entries of -4,622.03, the credit excluding GST is -51,355.94. No tax rate is inferred. Non-tax charges or round-off remain in the amount after subtracting the recorded taxes. Existing product-linked credit/return amounts remain on their original item basis and are deducted once. Net Sales, NBV, achievements and Excel use the corrected credit amounts through the existing calculation paths; all category, scope, cancellation, duplicate GUID, missing evidence and zero-base rules remain.

Daybook compact credit rows and dealer credit summaries use the credit amount excluding GST even when there are no products. The actual product subtotal remains null; no product is invented. The expanded amount box labels it Credit amount (excl. GST), while displaying the original GST entries and Bill total separately. The Product Plan credit drawer likewise labels the deduction and retains original gross/tax details. Saved captures with complete ledger evidence work on refresh; older missing evidence remains unavailable. Recovery/payment amounts and original source records are unchanged. No connector, schema or migration change.

Verification covers the user's exact tax example, interstate/UTGST/cess, signs/paise, no guessed rate, malformed/missing evidence, immutability, Daybook header/dealer/details rendering, drawer gross/tax disclosure, and unchanged product source calculations. Disposable PostgreSQL Sales report/bill tests assert -14.16 gross with -2.16 GST deducts -12.00 once; Daybook lookup returns -51,355.94 with original -60,600.00 preserved. Full disposable Aging/Sales/Daybook suites, relevant Daybook and planning suites, TypeScript and scoped lint pass (existing warnings only). No live financial data was used for validation.

### 26 November: Dealer Product wise NBV Sales column last

Moved NBV Sales to the last column in Territory Plan dealer Product wise details. Order is Product, Sales, Returns, Credit notes, Sales before other credits, NBV Sales. Product values, Total, Credit Notes deductions and Net Sales all align to this order; existing signed amounts, GST exclusions and NBV calculations are unchanged. Existing rendered heading/footer regressions verify the new order, amounts and expand/collapse behavior. No report-source, export, schema or connector change.

### 26 November: Dealer footer matches Product Plan styling

Dealer Product wise original Total values now start collapsed behind the same small down-arrow toggle. Net Sales always shows the Sales, Returns and product Credit notes totals, followed by existing adjusted sales and NBV in the last two columns. Unavailable source splits retain dashes; original values remain available through the toggle. The additional Credit Notes row uses Product Plan's semibold red text, minus-circle icon, subtle red tint and separating border, with a chevron to expand the existing credit details. Net Sales uses the same bold highlighted final-row treatment. Existing rendered regressions cover collapsed/expanded originals, visible movement totals, credit disclosure, NBV-last alignment, exact amounts, styling and held/loading/empty/category states. Financial calculations, GST policy, sources and filters are unchanged.

### 26 November: Adjusted Sales heading and even dealer columns

User selected Adjusted Sales as the short label for Sales before other credits. Updated the dealer Product wise heading, accessible original-total label and breakdown explanation; a hover title explains sales after returns/product-linked credits and before additional credits. The table now uses fixed layout and six equal-width columns, with wrapping product names. Existing amounts, totals and credit calculations are unchanged. Territory credit/breakdown regressions, TypeScript and scoped lint passed. Actual component preview with synthetic large amounts, negative returns and a long product name confirmed six equal widths (about170.33px each at1024px), aligned footer and readable wrapping. Temporary tab closed and preview server stopped; no live data used.
