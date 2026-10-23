# CN expiry and manual grace

New Payment Pending CN Working Shared acceptances set one expiry date, valid through the end of that date in IST. No initial/automatic grace is configured. Under Process and direct ledger posting still have no expiry/grace inputs; reason Other retains its existing exemption.

Authorized CN handlers with the approval permission can select **Add Grace** in the row menu in CN Working Shared or CN Near Expire. The dialog defaults to 5 days and accepts 1–365 whole calendar days. It previews the effective new date. Each explicit grant adds to the current expiry, records cumulative grace for that cycle and an immutable timeline event with account, time, old/new dates and added days. Retry keys and a row lock prevent duplicate additions; stale date/cycle submissions are refused. Expired CNs must use the existing reopen action, with reason and authorizing person.

**CN Near Expire** replaces CN in Grace. It contains unposted CNs with expiry today through four days ahead (inclusive), plus all grace-granted CNs regardless of their extended date. The normal Working Shared tab excludes these rows. Verified Paid CNs remain only in Posted in Ledger. Old `cn-in-grace` API links are retained as aliases. Row expiry shows the effective date and `Grace +N` for cumulative granted days. Its searchable multiselect header filter offers Grace given / Without grace; exports use the same categories. No separate grace-end column is shown.

Payment follow-ups, Daily Work scheduling and expiry gates use the effective expiry, without adding the recorded grace days again. Outstanding CNs expire at midnight IST after that date; already-reported Paid awaiting verification keeps the existing behavior. Reopening or returning from the ledger starts a fresh cycle without automatic grace, preserving historical grants.

## Migration and activation

Deploy migration `20261028000000_cn_manual_grace` with this application version. It preserves existing allowed deadlines by folding already-configured grace into expiry, keeps already-expired CNs expired, and records a system conversion event without inventing an actor. Old history remains unchanged and identifies whether its expiry already includes grace. The existing expiry and Under Process migrations are prerequisites. This work does not run migrations on production, push or deploy the app.

## Validation

- Pure date/boundary, leap/month/year arithmetic and acceptance validation tests.
- UI interaction tests: no grace on acceptance/reopen; row-menu grant, preview, validation, scoped permissions, categorical filter and editable labels.
- Disposable local PostgreSQL: all migrations, legacy deadline conversion, exact tab boundaries, extension/retry/concurrency, permissions, stale submissions, cumulative grants, timeline, task windows, payment verification/posting, expiry/reopen.
- Existing CN Under Process integration and CN request/filter/export/timeline/account/label regressions.
- Typecheck, focused lint and production build in an isolated copy.
