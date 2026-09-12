/** Run only against a disposable local cluster. No application DATABASE_URL is ever used.
 * Apply all existing migrations except scheme_part_bills first; this test applies that migration over history.
 * SCHEME_BILL_TEST_URL must use a /private/tmp/scheme-bill-db-* Unix socket (see safety guard below). */
/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma service loading for an isolated integration test */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

const url = process.env.SCHEME_BILL_TEST_URL;
if (!url || !new URL(url).searchParams.get("host")?.startsWith("/private/tmp/scheme-bill-db-")) throw new Error("Set SCHEME_BILL_TEST_URL to a disposable /private/tmp/scheme-bill-db-* Unix socket database");
const db = new PrismaClient({ datasourceUrl: url });
const localRequire = createRequire(import.meta.url);
const cache: Record<string, any> = {};
function load(name: string): any {
  if (cache[name]) return cache[name];
  const filename = resolve("src/features/schemes", name + ".ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {}; cache[name] = exports;
  const mocks: Record<string, any> = {
    "server-only": {}, "@/lib/prisma": { prisma: db },
    "@/lib/http": { ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), assertOfficerInScope: async () => {} },
    "@/lib/audit": { writeAudit: async (data: any, tx = db) => tx.auditLog.create({ data }) },
    "./scheme-master.server": { refreshSchemeStatuses: async () => {} },
    "@/features/products/merge.server": {}, "@/features/recovery/service.server": { BUSINESS_WEEK_COUNT: 4 },
  };
  runInNewContext(code, { exports, Date, console, require: (id: string) => id in mocks ? mocks[id] : id.startsWith("./") && id.endsWith(".server") ? load(id.slice(2)) : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports;
}
async function main() {
  const suffix = randomUUID(); const user = `admin-${suffix}`, dealer = `dealer-${suffix}`, scheme = `scheme-${suffix}`, legacy = `legacy-${suffix}`, legacyInst = `legacy-inst-${suffix}`, legacyRow = `legacy-row-${suffix}`, legacyPay = `legacy-pay-${suffix}`;
  // Raw INSERTs intentionally use only pre-feature columns, before the part-bill migration exists.
  await db.$executeRaw`INSERT INTO "User" (id,name,username,"passwordHash",role,"updatedAt") VALUES (${user},'Bill test',${user},'unused','SUPER_ADMIN',now())`;
  await db.$executeRaw`INSERT INTO "Dealer" (id,name,"updatedAt") VALUES (${dealer},'Historical dealer',now())`;
  await db.$executeRaw`INSERT INTO "Scheme" (id,"schemeName","schemeValueWithoutGST","schemeValueWithGST","bookingAmount","schemeBenefit","createdById","updatedAt") VALUES (${scheme},'Bill test',100000,118000,10000,'CREDIT_NOTE',${user},now())`;
  await db.$executeRaw`INSERT INTO "DealerSchemePlan" (id,"schemeId","dealerId","salesOfficerId","planStatus","schemeStatus","enrollmentStatus","updatedAt") VALUES (${legacy},${scheme},${dealer},${user},'APPROVED','CONVERTED','ENROLLED',now())`;
  await db.$executeRaw`INSERT INTO "DealerSchemeInstance" (id,"dealerSchemePlanId","instanceNumber","adminBillingDate","updatedAt") VALUES (${legacyInst},${legacy},1,'2026-08-01',now())`;
  await db.$executeRaw`INSERT INTO "DealerSchemeInstallment" (id,"instanceId","installmentNumber","plannedAmount","receivedAmount",status,"updatedAt") VALUES (${legacyRow},${legacyInst},1,50000,12345.67,'PARTIAL',now())`;
  await db.$executeRaw`INSERT INTO "SchemePayment" (id,"planId",amount,"receivedDate","createdById","updatedAt") VALUES (${legacyPay},${legacy},12345.67,'2026-08-10',${user},now())`;
  await db.$executeRaw`INSERT INTO "SchemePaymentAllocation" (id,"paymentId","installmentId",amount) VALUES (${`alloc-${suffix}`},${legacyPay},${legacyRow},12345.67)`;
  const history = async () => ({
    installment: await db.$queryRaw`SELECT to_jsonb(i) - 'billId' AS row FROM "DealerSchemeInstallment" i WHERE id=${legacyRow}`,
    payment: await db.$queryRaw`SELECT to_jsonb(p) AS row FROM "SchemePayment" p WHERE id=${legacyPay}`,
    allocations: await db.$queryRaw`SELECT to_jsonb(a) AS row FROM "SchemePaymentAllocation" a WHERE "paymentId"=${legacyPay}`,
    plan: await db.$queryRaw`SELECT to_jsonb(p) - ARRAY['billMode','soBillCount','adminBillCount','soAmountWithoutGST','soAmountWithGST','adminAmountWithoutGST','adminAmountWithGST','bookingAmount','bookingBillNumber','billsLockedAt'] AS row FROM "DealerSchemePlan" p WHERE id=${legacy}`,
  });
  const before = await history();
  const migrated = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='DealerSchemeInstallment' AND column_name='billId') AS exists`;
  if (!migrated[0].exists) {
    const sql = readFileSync(resolve("prisma/migrations/20260912020000_scheme_part_bills/migration.sql"), "utf8");
    await db.$transaction(async tx => { for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement); });
  }
  const oldBill = `old-bill-${suffix}`;
  await db.$executeRaw`INSERT INTO "DealerSchemeBill" (id,"instanceId","partNumber","adminBillDate","amountWithoutGST","amountWithGST","verifiedAt","updatedAt") VALUES (${oldBill},${legacyInst},1,'2026-08-01',100000,118000,now(),now())`;
  await db.$executeRaw`INSERT INTO "DealerSchemeInstallment" (id,"instanceId","billId","installmentNumber","plannedAmount","updatedAt") VALUES (${`old-bill-installment-${suffix}`},${legacyInst},${oldBill},1,108000,now())`;
  const oldBillBefore = await db.$queryRaw`SELECT to_jsonb(b) - ARRAY['planId','soAmountWithoutGST','soAmountWithGST'] AS row FROM "DealerSchemeBill" b WHERE id=${oldBill}`;
  const oldInstances = await db.$queryRaw`SELECT to_jsonb(i) AS row FROM "DealerSchemeInstance" i WHERE id=${legacyInst}`;
  const corrected = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='DealerSchemeBill' AND column_name='planId') AS exists`;
  if (!corrected[0].exists) {
    const sql = readFileSync(resolve("prisma/migrations/20260914010000_scheme_combined_plan_bills/migration.sql"), "utf8");
    await db.$transaction(async tx => { for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement); });
  }
  assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(b) - ARRAY['planId','soAmountWithoutGST','soAmountWithGST'] AS row FROM "DealerSchemeBill" b WHERE id=${oldBill}`, oldBillBefore);
  assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(i) AS row FROM "DealerSchemeInstance" i WHERE id=${legacyInst}`,oldInstances);
  assert.deepEqual(await history(), before);
  assert.equal((await db.dealerSchemeInstallment.findUniqueOrThrow({ where: { id: legacyRow } })).billId, null);
  console.log("PASS real migration preserves historical installment, payment, allocations and plan byte-for-byte");
  await assert.rejects(db.dealerSchemeInstallment.create({ data: { instanceId: legacyInst, installmentNumber: 1, plannedAmount: 1 } }));
  console.log("PASS legacy partial unique index remains enforced");
  await db.schemeInstallmentRule.createMany({ data: [30,70].map((value,i) => ({ schemeId: scheme, installmentNumber:i+1, calculationType:"PERCENTAGE", value, daysAfterBillingDate:i*30 })) });
  const ctx = { userId: user, role: "SUPER_ADMIN", groupId: null } as AuthContext;
  const planning: typeof import("@/features/schemes/scheme-planning.server") = load("scheme-planning.server");
  const pay: typeof import("@/features/schemes/scheme-payments.server") = load("scheme-payments.server");
  const enrolled: typeof import("@/features/schemes/scheme-enrolled.server") = load("scheme-enrolled.server");
  const { splitBillAmount } = await import("@/lib/scheme-bills");
  const soInput = (count: number, withGST="100000", without="80000") => ({ schemeStatus:"CONVERTED",conversionDate:"2026-09-12",soBookingStatus:"RECEIVED",soDocumentStatus:"SIGNED_AND_SENT",billing:{billCount:count,amountWithoutGST:without,amountWithGST:withGST,bills:splitBillAmount(withGST,count).map((value,i)=>({partNumber:i+1,soBillDate:"2026-09-15",amountWithGST:value,amountWithoutGST:splitBillAmount(without,count)[i]}))} });
  const adminInput = (count:number, verified:number[]=Array.from({length:count},(_,i)=>i+1), withGST="100000", without="80000") => ({adminConversionDate:"2026-09-13",adminBookingStatus:"RECEIVED",adminBookingAmount:10000,adminDocumentStatus:"RECEIVED_SOFT",billing:{billCount:count,amountWithGST:withGST,amountWithoutGST:without,bills:splitBillAmount(withGST,count).map((value,i)=>({partNumber:i+1,adminBillDate:verified.includes(i+1)?`2026-09-${20-i}`:null,amountWithGST:value,amountWithoutGST:splitBillAmount(without,count)[i]}))}});
  const create = async (instances:number, schemeId=scheme) => {const d=await db.dealer.create({data:{name:"Combined bill dealer"}});return db.dealerSchemePlan.create({data:{schemeId,dealerId:d.id,salesOfficerId:user,planStatus:"APPROVED",numberOfSchemes:instances,totalSchemeAmount:100000,instances:{create:Array.from({length:instances},(_,i)=>({instanceNumber:i+1}))}}});};
  const get = (id:string) => db.dealerSchemePlan.findUniqueOrThrow({where:{id},include:{bills:{include:{installments:true},orderBy:{partNumber:"asc"}},instances:{orderBy:{instanceNumber:"asc"}}}});
  for(const [instances,count] of [[1,1],[4,1],[4,2],[4,5]]) {
    const p=await create(instances); const originalInstances=(await get(p.id)).instances;
    await planning.saveConversion(ctx,p.id,soInput(count)); assert.equal(await db.dealerSchemeBill.count({where:{planId:p.id}}),count);assert.equal(await db.dealerSchemeInstallment.count({where:{bill:{planId:p.id}}}),0);
    await planning.verifyScheme(ctx,p.id,adminInput(count));const final=await get(p.id);
    assert.equal(final.enrollmentStatus,"ENROLLED");assert.equal(final.bills.length,count);assert.equal(final.bookingBillNumber,count);assert.equal(Number(final.adminAmountWithGST),100000);
    assert.equal(final.bills.flatMap(b=>b.installments).reduce((sum,i)=>sum+Number(i.plannedAmount),0),90000);
    assert(final.bills.every(b=>b.instanceId===null&&b.installments.every(i=>i.instanceId===null)));
    assert.deepEqual(final.instances,originalInstances);
    console.log(`PASS real ${instances} instances + ${count} combined bills: no instance writes or amount multiplication; one booking deduction`);
  }
  const p=await create(4);
  await planning.saveConversion(ctx,p.id,soInput(2));
  const pending=adminInput(2,[1],"118000","100000");
  await Promise.all([planning.verifyScheme(ctx,p.id,pending),planning.verifyScheme(ctx,p.id,pending)]);
  const partial=await get(p.id);assert.equal(partial.enrollmentStatus,"PENDING_DOCUMENT");assert.equal(partial.bills[0].installments.length,2);assert.equal(partial.bills[1].installments.length,0);assert.equal(partial.bookingBillNumber,2);assert.equal(Number(partial.bills[0].installments.find(i=>i.installmentNumber===2)!.plannedAmount),41300);
  const first=partial.bills[0]; const options=await Promise.allSettled([pay.addSchemePayment(ctx,p.id,{amount:20000,receivedDate:"2026-09-25"}),pay.addSchemePayment(ctx,p.id,{amount:20000,receivedDate:"2026-09-25"})]);
  assert.equal(options.filter(o=>o.status==="fulfilled").length,1);assert.equal(await db.schemePayment.count({where:{planId:p.id}}),1);
  const timeline=await pay.dealerPaymentTimeline(ctx,p.id,{});assert.equal(timeline.payments[0].allocations[0].billPartNumber,1);assert.equal(timeline.payments[0].allocations[0].instanceNumber,null);assert.equal(timeline.totals.received,20000);
  const tracker=(await enrolled.enrolledSchemeDetail(ctx,scheme)).dealers.find(d=>d.planId===p.id)!;assert.equal(tracker.schemeValueWithGST,118000);assert.equal(tracker.status,"Partial Verification");assert.equal(tracker.bills.length,2);assert.equal(tracker.bills[1].installments.length,0);assert(tracker.instances.every(i=>!i.installments.length));
  const paymentHistory=await db.schemePaymentAllocation.findMany({where:{payment:{planId:p.id}}});
  const beforeLocked=await get(p.id);
  await assert.rejects(planning.verifyScheme(ctx,p.id,adminInput(3)),/locked/);
  await assert.rejects(planning.verifyScheme(ctx,p.id,adminInput(2,[1],"120000","100000")),/locked/);
  await assert.rejects(planning.verifyScheme(ctx,p.id,{...pending,adminBookingAmount:20000}),/locked/);
  await assert.rejects(planning.saveConversion(ctx,p.id,soInput(1)),/locked/);
  const changedDate=adminInput(2,[1],"118000","100000");changedDate.billing.bills[0].adminBillDate="2026-10-01";await assert.rejects(planning.verifyScheme(ctx,p.id,changedDate),/locked/);
  assert.deepEqual(await get(p.id),beforeLocked);
  await planning.verifyScheme(ctx,p.id,adminInput(2,[1,2],"118000","100000"));const complete=await get(p.id);
  assert.equal(complete.enrollmentStatus,"ENROLLED");assert.equal(Number(complete.bills[1].installments.find(i=>i.installmentNumber===2)!.plannedAmount),31300);
  assert.equal(complete.bills[0].id,first.id);assert.equal(complete.bills[0].installments[0].plannedAmount.toString(),first.installments[0].plannedAmount.toString());assert.deepEqual(await db.schemePaymentAllocation.findMany({where:{payment:{planId:p.id}}}),paymentHistory);
  await assert.rejects(enrolled.updateInstallment(ctx,complete.bills[0].installments[0].id,{plannedAmount:1}),/locked/);
  await assert.rejects(enrolled.updateInstanceBillingDate(ctx,complete.instances[0].id,{billingDate:"2026-10-01"}),/Part-bill/);
  await assert.rejects(db.dealerSchemeBill.delete({where:{id:complete.bills[0].id}}));
  await assert.rejects(db.dealerSchemeInstallment.create({data:{instanceId:complete.instances[0].id,billId:complete.bills[0].id,installmentNumber:8,plannedAmount:1}}));
  await assert.rejects(db.dealerSchemeInstallment.create({data:{billId:complete.bills[0].id,installmentNumber:1,plannedAmount:1}}));
  console.log("PASS concurrent partial verification/payment, count/total/booking/date locks, later final bill, foreign keys and unchanged allocations");
  const draft=await create(4);await planning.saveConversion(ctx,draft.id,soInput(2));await planning.verifyScheme(ctx,draft.id,adminInput(3,[]));await planning.saveConversion(ctx,draft.id,soInput(1));await planning.verifyScheme(ctx,draft.id,adminInput(1));assert.equal((await get(draft.id)).bookingBillNumber,1);assert.equal(await db.dealerSchemeInstallment.count({where:{bill:{planId:draft.id}}}),2);
  console.log("PASS bill count can change/rebalance before first schedule; SO references remain distinct");
  const bad=await create(4);await planning.saveConversion(ctx,bad.id,soInput(2));const snapshot=await get(bad.id);await assert.rejects(planning.verifyScheme(ctx,bad.id,adminInput(2, [1,2],"10000","8000")),/cannot absorb/);assert.deepEqual(await get(bad.id),snapshot);
  const noDoc=await create(4);await planning.saveConversion(ctx,noDoc.id,soInput(1));await planning.verifyScheme(ctx,noDoc.id,{...adminInput(1),adminDocumentStatus:"NOT_RECEIVED"});assert.equal((await get(noDoc.id)).enrollmentStatus,"PENDING_DOCUMENT");
  await assert.rejects(planning.saveConversion(ctx,legacy,soInput(2)),/Existing instance-linked/);
  assert.deepEqual(await history(),before);
  console.log("PASS rollback, enrollment prerequisites and historical migration safety");
  const optScheme=await db.scheme.create({data:{schemeName:"Options test",structure:"MULTIPLE_OPTIONS",optionAchievementType:"VALUE_BASED",schemeBenefit:"CREDIT_NOTE",bookingAmount:999,createdById:user,installmentRules:{create:[30,70].map((value,i)=>({installmentNumber:i+1,calculationType:"PERCENTAGE",value,daysAfterBillingDate:i*30}))},options:{create:{valueWithoutGST:80000,valueWithGST:100000,targetValue:100000,bookingAmount:7000,label:"Frozen option"}}},include:{options:true}});
  const optPlan=await create(4,optScheme.id);await db.dealerSchemePlan.update({where:{id:optPlan.id},data:{selectedOptionId:optScheme.options[0].id,optionBookingAmount:7000,optionValueWithoutGST:80000,optionValueWithGST:100000,optionLabel:"Frozen option",optionTargetValue:100000}});
  await planning.saveConversion(ctx,optPlan.id,soInput(2));await planning.verifyScheme(ctx,optPlan.id,{...adminInput(2),adminBookingAmount:undefined});const opt=await get(optPlan.id);assert.equal(Number(opt.bookingAmount),7000);assert.equal(opt.bills.flatMap(b=>b.installments).reduce((sum,i)=>sum+Number(i.plannedAmount),0),93000);assert.equal(Number(opt.optionValueWithGST),100000);assert.equal(opt.optionLabel,"Frozen option");assert.deepEqual(await db.schemeOption.findMany({where:{schemeId:optScheme.id}}),optScheme.options);
  assert((await db.auditLog.count({where:{entityId:p.id}}))>=3);
  const view=await planning.getSchemePlan(ctx,p.id);assert.equal(view.totalSchemeAmount,118000);assert.equal(view.billing.amountWithGST,"118000");assert.equal(view.billing.bills.length,2);
  const follow=await load("scheme-follow-up.server").dealerFollowUpDetail(ctx,p.dealerId,{month:"all",week:"all"});assert.equal(follow.schemes[0].schemeAmount,118000);assert.equal(follow.schemes[0].installments.length,4);assert.equal(follow.schemes[0].installments[0].instanceNumber,null);
  const progress=await load("scheme-achievement.server").computeInstallmentProgress(ctx,{dealerId:p.dealerId});assert.equal(progress[0].total,4);
  console.log("PASS Options snapshot booking once, Fixed behavior, combined View/Follow-up amounts, installment counts and audits");
  console.log("Isolated PostgreSQL combined-plan bill integration checks passed (default transaction timeout)");
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.$disconnect());
