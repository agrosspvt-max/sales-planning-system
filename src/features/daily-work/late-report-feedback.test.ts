/** Deadline feedback and cross-session approval refresh; no application database. */
import assert from "node:assert/strict";
import { Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import type { AuthContext } from "@/lib/http";
import * as dates from "@/lib/daily-work";
import type { OutstandingReportView } from "./late-report";

async function main() {
  let deadline: Date | null = dates.soMidnightDeadline("2026-10-19");
  let reads = 0;
  const policy = testLoader({
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/daily-work": { ...dates, dailyWorkClock: { now: () => new Date("2026-10-22T05:00:00Z") } },
    "@/lib/prisma": { prisma: { $queryRaw: async (query: Prisma.Sql) => {
      reads++;
      if (query.sql.includes('SELECT "id", "status"')) return query.values[0] === "so1" ? [{ id: "r1", status: "APPROVED" }] : [];
      return [{ deadline, approved: false }];
    } } },
  })<typeof import("./report-policy.server")>("src/features/daily-work/report-policy.server.ts");
  const windowDb = { $queryRaw: async () => [{ deadline, approved: false }] } as never;
  const errorFor = async () => {
    try { await policy.assertReportWritable(windowDb, "so1", "2026-10-19", DEFAULT_LABELS); assert.fail("must be locked"); }
    catch (e) { assert.equal((e as TestApiError).status, 422); return (e as Error).message; }
  };
  assert.match(await errorFor(), /20\/10\/2026, 12:00 am IST/, "the SO error shows its stored midnight deadline");
  deadline = null;
  assert.match(await errorFor(), /20\/10\/2026, 12:00 pm IST/, "RM / pre-rollout error retains the noon deadline");
  const so = { userId: "so1", role: Role.SALES_OFFICER } as AuthContext;
  assert.deepEqual(JSON.parse(JSON.stringify(await policy.ownLateReportRequestStatus(so, "2026-10-19"))), { id: "r1", status: "APPROVED" });
  assert.equal(reads, 1, "approval polling makes one small database read");
  assert.equal(await policy.ownLateReportRequestStatus({ ...so, userId: "other" }, "2026-10-19"), null, "another caller cannot read this SO's request");
  for (const role of [Role.REGIONAL_MANAGER, Role.CUSTOM_ADMIN, Role.SUPER_ADMIN])
    await assert.rejects(policy.ownLateReportRequestStatus({ ...so, role }, "2026-10-19"), (e: unknown) => (e as TestApiError).status === 403);
  for (const date of [null, "bad-date", "2026-02-31"])
    await assert.rejects(policy.ownLateReportRequestStatus(so, date), (e: unknown) => (e as TestApiError).status === 422);

  type Result = { id: string; status: string } | null;
  let result: Result = null;
  let options: { enabled: boolean; refetchIntervalInBackground: boolean; refetchOnWindowFocus: string; refetchInterval: (query: { state: { data: Result } }) => number | false };
  const invalidations: unknown[] = [];
  const sync = testLoader({
    react: { useEffect: (effect: () => void) => effect() },
    "@/lib/api-client": { api: { get: async () => result } },
    "@tanstack/react-query": {
      useQuery: (value: typeof options) => { options = value; return { data: result }; },
      useQueryClient: () => ({ invalidateQueries: (value: unknown) => { invalidations.push(value); return Promise.resolve(); } }),
    },
  })<typeof import("./use-late-approval-sync")>("src/features/daily-work/use-late-approval-sync.ts").useLateApprovalSync;
  const outstanding = { date: "2026-10-19", requests: [{ id: "r1", status: "PENDING" }] } as OutstandingReportView;
  sync(null);
  assert.equal(options!.enabled, false, "normal Daily Work does not poll approvals");
  sync(outstanding);
  assert.equal(options!.enabled, true);
  assert.equal(options!.refetchInterval({ state: { data: null } }), 15_000);
  assert.equal(options!.refetchIntervalInBackground, false, "hidden browser tabs do not poll");
  assert.equal(options!.refetchOnWindowFocus, "always", "returning to the app checks promptly");
  for (const status of ["APPROVED", "REJECTED"]) {
    result = { id: "r1", status };
    invalidations.length = 0;
    sync(outstanding);
    assert.deepEqual(JSON.parse(JSON.stringify(invalidations)), [{ queryKey: ["daily-work-status"] }], "a decision refreshes today's plan gate and the older report lock, without reloading form answers");
    assert.equal(options!.refetchInterval({ state: { data: result } }), false, "polling stops on a decision");
  }
  result = { id: "older-request", status: "REJECTED" };
  invalidations.length = 0;
  sync(outstanding);
  assert.equal(invalidations.length, 0, "a cached decision for an earlier request cannot change the new request's screen");
  assert.equal(options!.refetchInterval({ state: { data: result } }), 15_000);
  sync({ ...outstanding, requests: [{ ...outstanding.requests[0]!, status: "APPROVED" }] });
  assert.equal(options!.enabled, false, "no polling while filling the reopened report");
  console.log("late-report-feedback.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
