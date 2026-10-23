-- Read-only audit on 23 Oct 2026 confirmed that Suresh's 22 Oct submitted plan
-- alone lacks its post-rollout policy. Other SO plans have their policy records.
-- Restore only this verified missing record. Do not change an existing policy,
-- a pre-rollout plan, an RM's deadline, or any plan/report answers or status.
-- Match the original submission timestamp so a different/recreated plan is untouched.
WITH verified_plan AS (
  SELECT e."officerId", e."workDate"
  FROM "DailyWorkEntry" e
  JOIN "User" u ON u."id" = e."officerId"
  CROSS JOIN "DailyReportRollout" r
  WHERE u."username" = 'so_suresh' AND u."name" = 'Suresh Verma'
    AND u."role" = 'SALES_OFFICER'
    AND e."workDate" = DATE '2026-10-22'
    AND r."id" = 'SO_MIDNIGHT'
  GROUP BY e."officerId", e."workDate", r."effectiveAt"
  HAVING MIN(e."planSubmittedAt") = TIMESTAMP '2026-10-22 05:08:26.380'
    AND MIN(e."planSubmittedAt") AT TIME ZONE 'UTC' >= r."effectiveAt"
)
INSERT INTO "DailyReportPolicy" ("id", "officerId", "workDate", "version", "deadline")
SELECT 'repair-so-midnight-2026-10-22-' || p."officerId", p."officerId", p."workDate",
       'SO_MIDNIGHT', (p."workDate" + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
FROM verified_plan p
ON CONFLICT ("officerId", "workDate") DO NOTHING;
