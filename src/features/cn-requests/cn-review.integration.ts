/** Run only against an explicitly supplied disposable local database. Never loads the application's database URL. */
import assert from "node:assert/strict";
import { PrismaClient, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import type { AuthContext } from "@/lib/http";
import { cnRequestBusinessDateKey } from "@/lib/cn-request";
import { addCnDays } from "@/lib/cn-expiry";

const url = process.env.CN_REVIEW_TEST_URL;
if (
  !url ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
  new URL(url).pathname !== "/cn_processing_test"
)
  throw new Error("Set CN_REVIEW_TEST_URL to a disposable LOCAL cn_processing_test database.");
const db = new PrismaClient({ datasources: { db: { url } } });
const load = testLoader({
  "@/lib/prisma": { prisma: db },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/features/notifications/task-alerts.server": { notifyAutoTaskCreated: async () => undefined },
  "@/features/tasks/task-history.server": { recordTaskReschedule: async () => true },
  "@/features/daily-work/day-lock.server": { lockDailyWorkDay: async () => undefined },
  "@/features/daily-work/auto-task-materialization.server": {
    reverseMaterializedDailyWorkContribution: async () => undefined,
  },
  "@/features/daily-work/task-rows.server": { dropEmptyTaskRow: async () => undefined },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
});
const review = load<typeof import("./cn-review.server")>(
  "src/features/cn-requests/cn-review.server.ts",
);
const cn = load<typeof import("./service.server")>("src/features/cn-requests/service.server.ts");
const ctx = (id: string, role: Role, permissions?: AuthContext["permissions"]): AuthContext => ({
  userId: id,
  username: id,
  role,
  groupId: null,
  permissions,
});
const admin = ctx("admin", Role.SUPER_ADMIN),
  so = ctx("so", Role.SALES_OFFICER),
  other = ctx("other", Role.SALES_OFFICER),
  acc = ctx("acc", Role.CUSTOM_ADMIN);
const delegated = ctx("handler", Role.CUSTOM_ADMIN, {
  cnRequests: ["read", "approve", "reject", "post"],
});
const upload = {
  name: "working.pdf",
  type: "application/pdf",
  buffer: Buffer.from("%PDF-1.7\nReview test"),
};
const expiry = addCnDays(cnRequestBusinessDateKey(new Date())!, 10);
const reject = async (p: Promise<unknown>, status: number) =>
  assert.equal(
    await p.then(
      () => 0,
      (e) => e.status,
    ),
    status,
  );
const key = () => randomUUID();
async function seed(id: string) {
  await db.cnRequest.create({
    data: {
      id,
      officerId: "so",
      dealerId: "dealer",
      cnType: "CD",
      details: "Check the rate",
      status: "SUBMITTED",
    },
  });
}
const send = (id: string, assignedToId = "other", expectedReviewId?: string) =>
  review.sendCnReview(admin, id, {
    kind: "RATE_CONFIRMATION",
    productIds: ["p1", "p2"],
    assignedToId,
    expectedReviewId,
    requestKey: key(),
  });
const decide = (
  id: string,
  action: "approve" | "reject",
  who = other,
  note = "",
  prices = [
    { id: "p1", price: 123.45 },
    { id: "p2", price: 0 },
  ],
) => review.respondCnReview(who, id, { action, note, prices });
async function main() {
  for (const [id, role] of [
    ["admin", Role.SUPER_ADMIN],
    ["so", Role.SALES_OFFICER],
    ["other", Role.SALES_OFFICER],
    ["acc", Role.CUSTOM_ADMIN],
    ["handler", Role.CUSTOM_ADMIN],
  ] as const)
    await db.user.create({
      data: {
        id,
        name: id,
        username: id,
        role,
        passwordHash: "test-only",
        ...(id === "handler"
          ? { adminPermissions: { cnRequests: ["read", "approve", "reject", "post"] } }
          : {}),
      },
    });
  await db.dealer.create({ data: { id: "dealer", name: "Dealer" } });
  for (const id of ["p1", "p2"])
    await db.product.create({ data: { id, name: id, rate: 1, nbvPercent: 0 } });
  await seed("rates");
  await reject(review.cnReviewChoices(so), 403);
  const choices = await review.cnReviewChoices(admin);
  assert(!choices.people.some((p) => p.id === "admin"));
  assert(choices.people.some((p) => p.id === "acc" && p.administrative));
  await reject(send("rates", "admin"), 422);
  const startKey = key();
  const start = {
    kind: "RATE_CONFIRMATION",
    productIds: ["p1", "p2"],
    assignedToId: "other",
    requestKey: startKey,
  };
  const first = await review.sendCnReview(admin, "rates", start);
  assert.equal((await review.sendCnReview(admin, "rates", start)).id, first.id);
  assert.equal(await db.cnReviewAttempt.count({ where: { cnRequestId: "rates" } }), 1);
  const initial = await db.cnRequest.findUniqueOrThrow({ where: { id: "rates" } });
  assert.equal(initial.status, "UNDER_PROCESS");
  assert.equal(initial.acceptedAt, null);
  assert.equal(initial.cnExpiryDate, null);
  assert.equal(initial.cnGraceDays, null);
  assert.equal((await review.cnReviewInbox(other)).length, 1);
  assert.equal((await review.cnReviewInbox(so)).length, 0);
  // Being assigned an out-of-scope review does not grant full CN details/history.
  await reject(cn.getCnRequest(other, "rates"), 403);
  await reject(review.cnReviewHistory(other, "rates"), 403);
  await reject(decide(first.id, "approve", so), 403);
  await reject(
    review.respondCnReview(other, first.id, {
      action: "approve",
      prices: [{ id: "p1", price: 1 }],
    }),
    422,
  );
  await reject(
    review.respondCnReview(other, first.id, {
      action: "approve",
      prices: [
        { id: "p1", price: 1.001 },
        { id: "p2", price: 1 },
      ],
    }),
    422,
  );
  await reject(decide(first.id, "reject"), 422);
  const second = await send("rates", "acc", first.id);
  assert.equal((await review.cnReviewInbox(other)).length, 0);
  assert.equal((await review.cnReviewInbox(acc)).length, 1);
  await reject(decide(first.id, "approve"), 409);
  await decide(second.id, "reject", acc, "Needs supporting rates");
  assert.equal(
    (await db.cnRequest.findUniqueOrThrow({ where: { id: "rates" } })).status,
    "UNDER_PROCESS",
  );
  // Either branch may be used on the next attempt, and SOs cannot be CN approvers.
  await reject(
    review.sendCnReview(
      admin,
      "rates",
      { kind: "CN_APPROVAL", assignedToId: "so", expectedReviewId: second.id, requestKey: key() },
      upload,
    ),
    422,
  );
  const third = await review.sendCnReview(
    delegated,
    "rates",
    { kind: "CN_APPROVAL", assignedToId: "admin", expectedReviewId: second.id, requestKey: key() },
    upload,
  );
  const doc = await review.cnReviewDocument(admin, third.id);
  assert.equal(doc.buffer.toString(), upload.buffer.toString());
  await reject(review.cnReviewDocument(other, third.id), 403);
  await review.respondCnReview(admin, third.id, {
    action: "approve",
    note: "Approved for processing",
  });
  // Confirmed CN approval can proceed through the existing direct posting flow without expiry/grace.
  await cn.acceptCnRequest(
    delegated,
    "rates",
    { status: "POSTED_IN_LEDGER", postedAmount: 1000, expectedReviewId: third.id },
    upload,
  );
  const posted = await db.cnRequest.findUniqueOrThrow({ where: { id: "rates" } });
  assert.equal(posted.status, "POSTED_IN_LEDGER");
  assert.equal(posted.paymentVerified, true);
  assert.equal(posted.cnExpiryDate, null);
  const detail = await cn.getCnRequest(admin, "rates");
  assert.equal(detail.timeline.filter((e) => e.kind === "REVIEW_SENT").length, 3);
  assert(detail.timeline.some((e) => e.kind === "REVIEW_FINALIZED"));
  assert(detail.timeline.every((e) => e.daysFromSubmission != null));
  assert.equal((await review.cnReviewHistory(so, "rates")).length, 3);
  await seed("bypass");
  const pending = await send("bypass");
  await reject(
    cn.acceptCnRequest(
      admin,
      "bypass",
      {
        status: "ACCEPTED_NOT_POSTED",
        reason: "PAYMENT_PENDING",
        outstandingAmount: 100,
        cnExpiryDate: expiry,
        graceDays: 5,
        expectedReviewId: pending.id,
      },
      upload,
    ),
    422,
  );
  assert.equal(
    (await db.cnRequest.findUniqueOrThrow({ where: { id: "bypass" } })).status,
    "UNDER_PROCESS",
  );
  assert.equal(await db.cnPaymentEvent.count({ where: { cnRequestId: "bypass" } }), 0);
  await cn.acceptCnRequest(
    admin,
    "bypass",
    {
      status: "ACCEPTED_NOT_POSTED",
      reason: "PAYMENT_PENDING",
      outstandingAmount: 100,
      cnExpiryDate: expiry,
      graceDays: 5,
      expectedReviewId: pending.id,
      bypassReason: "Urgent exception authorized",
    },
    upload,
  );
  const shared = await db.cnRequest.findUniqueOrThrow({ where: { id: "bypass" } });
  assert.equal(shared.cnExpiryDate?.toISOString().slice(0, 10), expiry);
  assert.equal(shared.cnGraceDays, 0);
  assert.equal(
    (await db.cnReviewAttempt.findUniqueOrThrow({ where: { id: pending.id } })).status,
    "CLOSED",
  );
  await reject(decide(pending.id, "approve"), 409);
  assert.equal(await db.cnPaymentEvent.count({ where: { cnRequestId: "bypass" } }), 1);
  await seed("prices");
  const priceReview = await send("prices");
  const races = await Promise.allSettled([
    decide(priceReview.id, "approve"),
    decide(priceReview.id, "approve"),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  const rates = await review.cnReviewHistory(admin, "prices");
  assert.equal(rates[0].products.find((p) => p.id === "p1")?.price, 123.45);
  assert.equal(rates[0].products.find((p) => p.id === "p2")?.price, 0);
  assert.equal(
    await db.cnProcessingEvent.count({
      where: { cnRequestId: "prices", kind: "REVIEW_RESPONDED" },
    }),
    1,
  );
  await seed("reject-cn");
  const rejection = await send("reject-cn");
  await reject(
    cn.actOnCnRequest(admin, "reject-cn", {
      action: "reject",
      reason: "OTHER",
      rejectionReasonDetails: "CN invalid",
      expectedReviewId: rejection.id,
    }),
    422,
  );
  await cn.actOnCnRequest(admin, "reject-cn", {
    action: "reject",
    reason: "OTHER",
    rejectionReasonDetails: "CN invalid",
    expectedReviewId: rejection.id,
    bypassReason: "No longer need confirmation",
  });
  assert.equal(
    (await db.cnRequest.findUniqueOrThrow({ where: { id: "reject-cn" } })).status,
    "REJECTED",
  );
  assert.equal((await review.cnReviewInbox(other)).length, 0);
  // Stale review identifiers cannot authorize a final decision after reassignment.
  await seed("stale");
  const a = await send("stale");
  const b = await send("stale", "acc", a.id);
  await reject(
    cn.acceptCnRequest(
      admin,
      "stale",
      {
        status: "POSTED_IN_LEDGER",
        postedAmount: 1,
        expectedReviewId: a.id,
        bypassReason: "Reason",
      },
      upload,
    ),
    409,
  );
  assert.equal(
    (await db.cnReviewAttempt.findUniqueOrThrow({ where: { id: b.id } })).status,
    "PENDING",
  );
  const list = await cn.listCnRequests(admin, "under-process");
  assert(list.some((r) => r.id === "stale" && r.processingReview?.status === "PENDING"));
  assert(!list.some((r) => r.id === "rates" || r.id === "bypass" || r.id === "reject-cn"));
  console.log(
    "CN processing integration passed: both branches, reassignment, scoped access, stale/concurrent responses, bypass rollback, prices, existing final flows, expiry timing and durable timeline.",
  );
}
main()
  .finally(() => db.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
