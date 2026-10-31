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
