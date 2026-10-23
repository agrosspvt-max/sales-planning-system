/** CN lifecycle timeline, detail API scope and accessible display. No application database. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { buildCnTimeline, cnTimelineDaysFromSubmission, orderCnTimelineEntries } from "@/lib/cn-timeline";
import * as cnRules from "@/lib/cn-request";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const createdAt = "2026-10-19T04:00:00Z", acceptedAt = "2026-10-20T05:00:00Z", postedAt = "2026-10-21T06:00:00Z";
const base = { status: "SUBMITTED", createdAt };
const kinds = (entries: ReturnType<typeof buildCnTimeline>) => Array.from(entries, (e) => e.kind);
assert.deepEqual(kinds(buildCnTimeline(base)), ["SUBMITTED"], "pending actions are never presented as completed");
const rejected = buildCnTimeline({ ...base, status: "REJECTED", rejectedAt: acceptedAt, rejectionReason: "OTHER", rejectionReasonDetails: "Invoice mismatch" });
assert.deepEqual(kinds(rejected), ["SUBMITTED", "REJECTED"]);
assert.equal(rejected[1]!.reasonDetails, "Invoice mismatch");
const shared = { ...base, status: "ACCEPTED_NOT_POSTED", acceptedAt, cnWorkingUploadedAt: acceptedAt, cnWorkingFileName: "Working.pdf" };
assert.deepEqual(kinds(buildCnTimeline(shared)), ["SUBMITTED", "WORKING_SHARED"]);
const payment = { id: "p1", source: "SO_UPDATE", requestKey: "report1", createdAt: "2026-10-20T09:00:00Z", actor: "Officer", status: "PARTIAL_PAID", amountPaid: 1000, outstandingAfter: 2000 };
const posted = buildCnTimeline({ ...shared, status: "POSTED_IN_LEDGER", postedAt, finalCnUploadedAt: postedAt, finalCnFileName: "Final.pdf", payments: [
  { ...payment, id: "auto", source: "ACCEPTANCE", createdAt: acceptedAt },
  { ...payment, id: "verify", source: "ADMIN_VERIFY", createdAt: postedAt, status: "PAID", actor: "Admin", amountPaid: null, outstandingAfter: 0 },
  payment,
] });
assert.deepEqual(kinds(posted), ["SUBMITTED", "WORKING_SHARED", "PAYMENT_REPORTED", "PAYMENT_VERIFIED", "FINAL_CN_SHARED", "POSTED_IN_LEDGER"]);
assert.equal(posted[2]!.actor, "Officer"); assert.equal(posted[2]!.amountPaid, 1000);
const direct = buildCnTimeline({ ...shared, status: "POSTED_IN_LEDGER", postedAt: acceptedAt, payments: [{ ...payment, source: "ADMIN_VERIFY", requestKey: "acceptance:cn1" }] });
assert.equal(direct.filter((e) => e.kind === "PAYMENT_VERIFIED").length, 0, "direct acceptance does not invent a separate payment verification action");
assert.deepEqual(kinds(direct), ["SUBMITTED", "POSTED_IN_LEDGER"], "direct posting has neither Accepted nor Working Shared");
assert.equal(direct[1]!.fileName, "Working.pdf", "the direct posting still shows its document");
assert.deepEqual(posted.map((event) => event.daysFromSubmission), [0, 1, 1, 2, 2, 2], "every milestone measures from submission Day 0");
assert.equal(cnTimelineDaysFromSubmission("2026-10-19T18:25:00Z", "2026-10-19T18:35:00Z"), 1, "ten minutes crossing IST midnight is the next calendar day");
assert.equal(cnTimelineDaysFromSubmission("2026-10-19T00:00:00Z", "2026-10-19T18:29:00Z"), 0, "same IST date stays Day 0");
assert.equal(cnTimelineDaysFromSubmission(createdAt, null), null);
assert.equal(cnTimelineDaysFromSubmission(createdAt, "invalid"), null);
assert.equal(cnTimelineDaysFromSubmission(createdAt, "2026-10-18T04:00:00Z"), null, "invalid backwards history never shows negative or invented days");
const legacy = buildCnTimeline({ ...base, status: "ACCEPTED", cnWorkingFileName: "Legacy.pdf" });
assert.equal(legacy.find((e) => e.kind === "POSTED_IN_LEDGER")!.occurredAt, null);
assert.ok(!legacy.some((e) => e.kind === "WORKING_SHARED"), "a legacy posting with only a file does not prove an intermediate Working Shared stage");
const returned = buildCnTimeline({ ...shared, status: "POSTED_IN_LEDGER", postedAt, payments: [{ ...payment, source: "ADMIN_VERIFY", createdAt: "2026-10-22T06:00:00Z", status: "NOT_PAID" }] });
assert.equal(returned.at(-1)!.paymentStatus, "NOT_PAID");
assert.equal(returned.filter((e) => e.kind === "POSTED_IN_LEDGER").length, 1, "later payment changes retain original ledger-posting history");

const label = (key: string) => (DEFAULT_LABELS as Record<string, string>)[key] ?? key;
const { CnTimeline } = testLoader({ "@/features/labels/label-ui": { useLabel: label, useLabelResolver: () => label } })<typeof import("./cn-timeline")>("src/features/cn-requests/cn-timeline.tsx");
let html = renderToStaticMarkup(<CnTimeline entries={posted} />);
assert.ok(html.includes("<ol") && html.includes('data-cn-event="POSTED_IN_LEDGER"') && html.includes("Final.pdf") && html.includes("Working.pdf"));
assert.ok(html.includes("Day 0 from submission") && html.includes("Day 2 from submission") && !html.includes('data-cn-event="ACCEPTED"'));
assert.ok(html.includes("All times in IST") && html.includes("19/10/2026, 9:30 am"), "timestamps use the app's Indian business time zone");
html = renderToStaticMarkup(<CnTimeline entries={rejected} />);
assert.ok(html.includes("Invoice mismatch") && html.includes("text-destructive"));
html = renderToStaticMarkup(<CnTimeline entries={legacy} />);
assert.ok(html.includes("Time not recorded") && !html.includes("Invalid Date"));

// Regression: the saved screenshot record has a 33ms app/database clock difference.
const skewed = buildCnTimeline({ ...shared, status: "POSTED_IN_LEDGER", postedAt: "2026-10-19T08:29:50.305Z", createdAt: "2026-10-19T08:25:25.983Z", acceptedAt: "2026-10-19T08:27:16.509Z", cnWorkingUploadedAt: "2026-10-19T08:27:16.509Z", finalCnUploadedAt: "2026-10-19T08:29:50.305Z", finalCnFileName: "Final.pdf", payments: [
  { ...payment, id: "report", createdAt: "2026-10-19T08:28:19.629Z", status: "PAID" },
  { ...payment, id: "posting-verify", source: "ADMIN_VERIFY", createdAt: "2026-10-19T08:29:50.338Z", status: "PAID" },
  { ...payment, id: "later-not-paid", source: "ADMIN_VERIFY", createdAt: "2026-10-21T10:59:52.828Z", status: "NOT_PAID" },
  { ...payment, id: "later-paid", source: "ADMIN_VERIFY", createdAt: "2026-10-22T10:00:00Z", status: "PAID" },
] });
assert.deepEqual(kinds(skewed), ["SUBMITTED", "WORKING_SHARED", "PAYMENT_REPORTED", "PAYMENT_VERIFIED", "FINAL_CN_SHARED", "POSTED_IN_LEDGER", "PAYMENT_VERIFIED", "PAYMENT_VERIFIED"], "the Paid decision precedes the Final CN and posting it triggered; later corrections remain after posting");
assert.equal(skewed[3]!.occurredAt, "2026-10-19T08:29:50.338Z", "historical recorded timestamps remain exact");
assert.equal(skewed[6]!.paymentStatus, "NOT_PAID");
assert.equal(skewed[7]!.paymentStatus, "PAID");
const oldPayload = skewed.map(({ daysFromSubmission: _days, ...entry }) => entry)
  .sort((a, b) => Date.parse(a.occurredAt!) - Date.parse(b.occurredAt!));
html = renderToStaticMarkup(<CnTimeline entries={oldPayload} />);
assert.ok(html.indexOf('data-cn-event="PAYMENT_VERIFIED"') < html.indexOf('data-cn-event="FINAL_CN_SHARED"'), "the UI also corrects chronological-only cached responses");
assert.equal((html.match(/Day 0 from submission/g) ?? []).length, 6, "Day 0 renders for every same-day step, even without server day metadata");
assert.ok(html.includes("Day 2 from submission") && html.includes("Day 3 from submission"));
assert.deepEqual(kinds(orderCnTimelineEntries(skewed)), kinds(skewed), "ordering is idempotent and does not mutate existing events");
const olderDays = buildCnTimeline({ status: "POSTED_IN_LEDGER", createdAt: "2026-10-05T05:20:00Z", acceptedAt: "2026-10-21T09:37:00Z", postedAt: "2026-10-21T09:37:00Z" }).map(({ daysFromSubmission: _days, ...entry }) => entry);
html = renderToStaticMarkup(<CnTimeline entries={olderDays} submittedAt="2026-10-05T05:20:00Z" />);
assert.ok(html.includes("Day 0 from submission") && html.includes("Day 16 from submission"), "the other screenshot's October 5 → October 21 interval displays 16 days");

async function main() {
  const raw = { id: "cn1", dealerId: "d1", officerId: "so1", cnType: "CD", status: "POSTED_IN_LEDGER", amount: 1000, postedAmount: 1000,
    dealer: { name: "Dealer" }, officer: { name: "Officer", territory: "North", group: { name: "State" } }, createdAt: new Date(createdAt), acceptedAt: new Date(acceptedAt), postedAt: new Date(postedAt), rejectedAt: null,
    actedByRmId: null, actedByAdminId: "accounts", cnWorkingUploadedById: "amit", finalCnUploadedById: "accounts", finalCnUploadedAt: new Date(postedAt), finalCnFileName: "Final.pdf",
    cnWorkingUploadedAt: new Date(acceptedAt), cnWorkingFileName: "Working.pdf", cnWorkingMimeType: "application/pdf", cnWorkingFileSize: 10,
    expiryEvents: [], paymentEvents: [{ ...payment, createdAt: new Date(payment.createdAt), recordedById: "so1", recordedBy: { name: "Officer", username: "so1" }, actorDesignation: null }],
  };
  const selects: object[] = [];
  const users = [{ id: "amit", name: "Amit", username: "amit" }, { id: "accounts", name: "Ishwar Singh", username: "accounts" }];
  let actorReads = 0;
  let audits = [
    { action: "CREATE", summary: "CN Request (CD) raised for a team member", userId: "rm1", actorDesignation: null, user: { name: "Regional Manager", username: "rm" } },
    { action: "UPDATE", summary: "CN Request accepted, not posted", userId: "amit", actorDesignation: "Accounts Officer", user: users[0]! },
    { action: "UPDATE", summary: "CN Request accepted, posted in ledger", userId: "accounts", actorDesignation: "Accounts Officer", user: users[1]! },
  ];
  let detailMode: "posted" | "direct" | "rejected" = "posted";
  const service = testLoader({
    "./cn-review.server": { cnProcessingEvents: async () => [] },
    "@/lib/prisma": { prisma: { cnRequest: { findUnique: async (q: { select: object }) => { selects.push(q.select);
        if (detailMode === "direct") return { ...raw, acceptedAt: raw.postedAt, cnWorkingUploadedAt: raw.postedAt, finalCnFileName: null, finalCnUploadedAt: null, paymentEvents: [] };
        if (detailMode === "rejected") return { ...raw, status: "REJECTED", acceptedAt: null, postedAt: null, rejectedAt: new Date(acceptedAt), cnWorkingUploadedAt: null, cnWorkingFileName: null, finalCnFileName: null, finalCnUploadedAt: null, paymentEvents: [], rejectionReason: "OTHER", rejectionReasonDetails: "Invoice mismatch" };
        return raw; } }, $queryRaw: async () => [{ id: "cn1", paymentVerified: true }],
      auditLog: { findMany: async (q: { where: { entityId: string } }) => { actorReads++; assert.equal(q.where.entityId, "cn1"); return audits; } },
      user: { findMany: async (q: { where: { id: { in: string[] } } }) => { actorReads++; return users.filter((user) => q.where.id.in.includes(user.id)); } },
    } },
    "@/lib/http": { ApiError: TestApiError }, "@/lib/scope": { getOfficerScope: async (ctx: AuthContext) => ({ all: ctx.role === Role.SUPER_ADMIN, ids: [ctx.userId] }) },
    "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    "@/lib/daily-work": {}, "@/lib/audit": {}, "@/features/notifications/task-alerts.server": {}, "@/features/tasks/task-history.server": {},
    "@/features/daily-work/day-lock.server": {}, "@/features/daily-work/auto-task-materialization.server": {}, "@/features/daily-work/task-rows.server": {},
    "@/lib/cn-request": cnRules,
  })<typeof import("./service.server")>("src/features/cn-requests/service.server.ts");
  const so = { userId: "so1", role: Role.SALES_OFFICER } as AuthContext;
  const detail = await service.getCnRequest(so, "cn1");
  assert.deepEqual(kinds(detail.timeline), ["SUBMITTED", "WORKING_SHARED", "PAYMENT_REPORTED", "FINAL_CN_SHARED", "POSTED_IN_LEDGER"]);
  assert.ok("paymentEvents" in selects[0]!, "history is fetched on the detail query");
  assert.ok(!("cnWorkingDocument" in selects[0]!), "attachment bytes are not fetched for the timeline");
  assert.equal(detail.timeline.find((e) => e.kind === "PAYMENT_REPORTED")!.actor, "Officer");
  assert.equal(detail.timeline[0]!.actor, "Regional Manager", "submitter is the RM who acted, not the owning SO");
  assert.equal(detail.timeline.find((e) => e.kind === "WORKING_SHARED")!.actor, "Amit");
  assert.equal(detail.timeline.find((e) => e.kind === "POSTED_IN_LEDGER")!.actor, "Ishwar Singh");
  assert.equal(detail.timeline.find((e) => e.kind === "FINAL_CN_SHARED")!.actor, "Ishwar Singh");
  const readsBeforeDenied = actorReads;
  await assert.rejects(() => service.getCnRequest({ ...so, userId: "other" }, "cn1"), (e: TestApiError) => e.status === 403, "out-of-scope viewers cannot retrieve the timeline");
  assert.equal(actorReads, readsBeforeDenied, "no account/audit lookups happen for an unauthorized viewer");
  const savedAudits = audits;
  audits = [];
  const legacyDetail = await service.getCnRequest(so, "cn1");
  assert.equal(legacyDetail.timeline[0]!.actor, undefined, "legacy submission does not invent the owning SO as the submitter");
  assert.equal(legacyDetail.timeline.find((e) => e.kind === "WORKING_SHARED")!.actor, "Amit", "persisted uploader ID identifies the account without inventing a past title");
  audits = savedAudits;
  detailMode = "direct";
  const directDetail = await service.getCnRequest(so, "cn1");
  assert.deepEqual(kinds(directDetail.timeline), ["SUBMITTED", "POSTED_IN_LEDGER"], "detail API retains the direct route");
  assert.equal(directDetail.timeline[1]!.actor, "Ishwar Singh");
  detailMode = "rejected";
  audits = [savedAudits[0]!, { action: "UPDATE", summary: "CN Request rejected by Accounts Officer", userId: "accounts", actorDesignation: "Accounts Officer", user: users[1]! }];
  const rejectedDetail = await service.getCnRequest(so, "cn1");
  assert.deepEqual(kinds(rejectedDetail.timeline), ["SUBMITTED", "REJECTED"]);
  assert.equal(rejectedDetail.timeline[1]!.actor, "Ishwar Singh");
  assert.equal(rejectedDetail.timeline[1]!.daysFromSubmission, 1);
  detailMode = "posted";
  audits = savedAudits;
  let detailData: object = detail;
  const wrap = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const dialog = testLoader({
    "./cn-review-ui": { CnReviewHistory: () => null },
    "@/lib/api-client": { api: { get: async () => detailData } },
    "@/features/labels/label-ui": { useLabel: label, useLabelResolver: () => label },
    "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <span>{name}</span> },
    "@tanstack/react-query": { useQuery: (options: { staleTime: number; initialDataUpdatedAt: number }) => {
      assert.equal(options.staleTime, 0); assert.equal(options.initialDataUpdatedAt, 0);
      return { data: detailData, isLoading: false, error: null };
    } },
    "@/components/ui/dialog": { Dialog: wrap, DialogContent: wrap, DialogHeader: wrap, DialogTitle: wrap, DialogFooter: wrap },
  })<typeof import("./cn-request-detail-dialog")>("src/features/cn-requests/cn-request-detail-dialog.tsx");
  for (const [status, timeline] of [["REJECTED", rejected], ["ACCEPTED_NOT_POSTED", buildCnTimeline(shared)], ["POSTED_IN_LEDGER", posted]] as const) {
    detailData = { ...detail, status, timeline };
    const content = renderToStaticMarkup(<dialog.CnRequestDetailDialog requestId="cn1" onClose={() => undefined} />);
    assert.ok(content.includes("CN Timeline") && content.includes("data-cn-event"), `${status}: View Details renders its timeline`);
    assert.ok(content.includes("/api/cn-requests/cn1/working?download=1"), "document actions stay available");
  }
  const accountsHtml = renderToStaticMarkup(<CnTimeline entries={detail.timeline} />);
  assert.ok(accountsHtml.includes("By: Amit") && accountsHtml.includes("By: Ishwar Singh") && !accountsHtml.includes("@") && !accountsHtml.includes("Accounts Officer"));
  assert.ok(accountsHtml.includes("By: Regional Manager"));
  assert.ok(renderToStaticMarkup(<CnTimeline entries={legacyDetail.timeline} />).includes("By: Account not recorded"));
  console.log("cn-timeline.test.tsx — lifecycle, legacy dates, payments, rendering and scoped detail passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
