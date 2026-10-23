# Missing late-report request on 23 October 2026

An enforced read-only production audit found Suresh Verma (`so_suresh`)'s
22 October plan submitted at `2026-10-22T05:08:26.380Z`, after the stored rollout
cutoff of `2026-10-19T10:49:19.771Z`. Its report remained OPEN, but its
`DailyReportPolicy` row was missing. Other post-rollout SO plans checked had
their policy rows. The audit does not establish what originally removed or
prevented this one record.

Without a policy row, the application deliberately uses the legacy next-day-noon
deadline and excludes the day from the late-report workflow. That explains the
blocked plan and missing request option. The empty Sales report is separate:
the submitted 22 October plan contains Recovery and Summary entries, not Sales.

Migration `20261029000000_repair_suresh_report_policy` restores only the verified
22 October policy, guarded by username, name, role, work date, exact first
submission timestamp and rollout cutoff. It preserves existing policies and
all plan/report content. His pre-rollout 19 October plan retains its old rules.
It does not create or approve a late-report request: Suresh must request it, an
authorized reviewer must approve it, and he must submit the report before the
next plan is unlocked.

The outstanding-report panel now appears in both Daily Plan and Daily Report.
The Report tab shows the same request action, decision and history as Plan,
without an unnecessary link back to the report already open. Its date, saved
answers and server-side locks are unchanged. All wording uses existing Labels.

After the user reported the unchanged localhost screen, the guarded SQL
correction was applied directly to the shared database on 23 October 2026.
Exactly one missing policy was inserted. A before snapshot was saved under
`/private/tmp/suresh-report-before-repair-1792736422530.json`; report entries,
day status and late-report requests were compared before and after and were
unchanged. No pending migrations were deployed as part of that correction.
The migration remains idempotent and will preserve this repaired row when
subsequently deployed. The UI change is local; no application deployment was
performed.
