/** Synthetic database only. Never accepts an application/Neon URL. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import * as db from "@prisma/client";
import { z } from "zod";
import * as billwise from "./billwise";
import * as changes from "./changes";
import * as sales from "./sales";
const url = process.env.TALLY_DISPOSABLE_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/tally-test-pg.")
)
  throw Error("Disposable synthetic DB required");
process.env.DATABASE_URL = url;
process.env.TALLY_SYNC_ENABLED = "true";
process.env.TALLY_SALES_SYNC_ENABLED = "true";
process.env.TALLY_EXPECTED_DB_HOST = "localhost";
const prisma = new db.PrismaClient({ datasources: { db: { url } } });
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const require = createRequire(import.meta.url),
  modules: Record<string, unknown> = {
    "server-only": {},
    "./sales-rollout": { salesSyncEnabled: () => process.env.TALLY_SALES_SYNC_ENABLED === "true" },
    "@prisma/client": db,
    zod: { z },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "./billwise": billwise,
    "./changes": changes,
    "./sales": sales,
    "@/lib/audit": { writeAudit: async () => {} },
  };
function load<T>(file: string): T {
  const code = ts.transpileModule(readFileSync(resolve(file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    mod = { exports: {} };
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    require: (name: string) => modules[name] ?? require(name),
    process,
    console,
    Date,
    Math,
    Set,
    Map,
    Buffer,
    JSON,
    URL,
  });
  return mod.exports as T;
}
modules["@/lib/import/workbook"] = {};
modules["@/lib/match-key"] = load("src/lib/match-key.ts");
modules["@/lib/product-merge"] = load("src/lib/product-merge.ts");
modules["@/features/sales-upload/parser"] = load("src/features/sales-upload/parser.ts");
modules["./service.server"] = load("src/features/tally/service.server.ts");
const svc = load<typeof import("./sales.server")>("src/features/tally/sales.server.ts");
const today = billwise.indiaDay(),
  month = today.slice(0, 7),
  prefix = "cb293b57-f31b-464e-b2e1-42d4edb59b7d",
  anchor = prefix + "-00002385";
const actor = {
  userId: "sales-admin",
  username: "sales-admin",
  role: db.Role.SUPER_ADMIN,
  groupId: null,
};
let connectionId = "",
  credential = "";
async function call(body: unknown, otherCredential = credential) {
  return svc.salesAgent(
    new Request("https://test.example/api/tally/sales-agent", {
      method: "POST",
      headers: { "x-agent-id": connectionId, authorization: "Bearer " + otherCredential },
    }),
    body,
  ) as Promise<any>;
}
async function claim() {
  return (await call({ action: "claim", requestId: randomUUID() })).job;
}
function result(
  job: any,
  items: any[] = [
    {
      lineNo: 0,
      stockItemName: "Product 10X1L",
      quantity: "14.400000",
      amount: "1040.00",
      unit: "L",
      actualQty: "14.4 L",
      billedQty: "14.4 L",
      rate: "",
    },
  ],
) {
  return {
    version: "sales.sync.v1",
    companyName: job.companyName,
    monthKey: job.monthKey,
    fromDate: job.fromDate,
    throughDate: job.throughDate,
    observedAt: new Date().toISOString(),
    sourceHash: "a".repeat(64),
    controlMarkerCount: 0,
    anchorGuid: anchor,
    ledgers: [
      { name: "Dealer A", guid: prefix + "-00000002" },
      { name: "Dealer B", guid: prefix + "-00000003" },
    ],
    vouchers: [
      {
        guid: prefix + "-00000001",
        masterId: "1",
        alterId: "1",
        billDate: job.fromDate,
        billNumber: "S1",
        typeName: "CASH SALE-CG",
        family: "Sales",
        partyName: "Dealer A",
        cancelled: false,
        optional: false,
        ledgerEntries: [],
        items,
      },
    ],
  };
}
async function stage(job: any, data: any) {
  const payload = JSON.stringify(data),
    ids = { jobId: job.id, leaseToken: job.leaseToken },
    chunks = Array.from({ length: Math.ceil(payload.length / 32768) }, (_, i) =>
      payload.slice(i * 32768, (i + 1) * 32768),
    );
  await call({
    action: "begin",
    ...ids,
    manifest: { chunks: chunks.length, bytes: payload.length, sha256: sales.hashSales(payload) },
  });
  for (let i = 0; i < chunks.length; i++)
    await call({
      action: "chunk",
      ...ids,
      sequence: i,
      hash: sales.hashSales(chunks[i]),
      data: chunks[i],
    });
  return ids;
}
async function refresh(data: (job: any) => any, monthKey = month) {
  await svc.requestSalesRefresh(actor, monthKey);
  const job = await claim();
  assert.ok(job);
  const ids = await stage(job, data(job));
  await call({ action: "complete", ...ids });
  return { job, ids };
}
async function actual(id = "line-a", m = "sales-month") {
  return prisma.monthlyEntry.findUniqueOrThrow({
    where: { planLineId_seasonMonthId: { planLineId: id, seasonMonthId: m } },
  });
}
async function roundtrip() {
  const directory = mkdtempSync(join(tmpdir(), "sales-https-test-"));
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem");
  assert.equal(
    spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    ).status,
    0,
  );
  let exports = 0;
  const envelope = (body: string) =>
    `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`;
  const http = httpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const xml = Buffer.concat(parts).toString();
    assert.ok(xml.includes("<TALLYREQUEST>Export</TALLYREQUEST>"));
    exports++;
    let reply = "";
    if (xml.includes('<ID TYPE="Name">'))
      reply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><LEDGER NAME="NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP"><GUID>${anchor}</GUID><PARENT>Test</PARENT><CLOSINGBALANCE>-10.00</CLOSINGBALANCE></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    else if (xml.includes("<TYPE>VoucherType</TYPE>"))
      reply = envelope(
        `<VOUCHERTYPE NAME="Sales MP" RESERVEDNAME="Sales"><GUID>${prefix}-00000038</GUID><PARENT>Sales MP</PARENT></VOUCHERTYPE><VOUCHERTYPE NAME="Credit Note" RESERVEDNAME="Credit Note"><GUID>${prefix}-00000036</GUID><PARENT>Credit Note</PARENT></VOUCHERTYPE>`,
      );
    else if (xml.includes("<TYPE>Ledger</TYPE>"))
      reply = envelope(
        `<LEDGER NAME="Dealer A"><GUID>${prefix}-00000002</GUID></LEDGER><LEDGER NAME="Dealer B"><GUID>${prefix}-00000003</GUID></LEDGER>`,
      );
    else {
      const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ],
        first = `1-${monthNames[+month.slice(5) - 1]}-${month.slice(0, 4)}`;
      const match =
        xml.includes("<CHILDOF>Sales MP</CHILDOF>") && xml.includes('$$Date:"' + first + '"');
      reply = envelope(
        match
          ? `<VOUCHER><GUID>${prefix}-00000001</GUID><MASTERID>1</MASTERID><ALTERID>3</ALTERID><DATE>${month.replace("-", "")}01</DATE><VOUCHERNUMBER>End-to-end bill</VOUCHERNUMBER><VOUCHERTYPENAME>Sales MP</VOUCHERTYPENAME><PARTYLEDGERNAME>Dealer A</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Product 10X1L</STOCKITEMNAME><BILLEDQTY>37.304 Kg = 2.5 case</BILLEDQTY><ACTUALQTY>37.304 Kg</ACTUALQTY><AMOUNT>123.45</AMOUNT><BATCHNAME>&#4; Not Applicable</BATCHNAME></ALLINVENTORYENTRIES.LIST></VOUCHER>`
          : "",
      );
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(reply);
  });
  const https = httpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      try {
        assert.equal(req.url, "/api/tally/sales-agent");
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const request = new Request("https://localhost/api/tally/sales-agent", {
          method: "POST",
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(parts),
        });
        const reply = await svc.salesAgent(
          request,
          await (modules["./service.server"] as typeof import("./service.server")).readBody(
            request,
          ),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      } catch (e) {
        res.writeHead((e as ApiError).status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test request rejected" }));
      }
    },
  );
  try {
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    await svc.requestSalesRefresh(actor, month);
    const python = `import os,sys,ssl
sys.path.insert(0,os.environ['CONNECTOR_ROOT'])
import connector as c
from sales_worker import SalesWorker,SalesCloud
config=c.load_config(os.path.join(os.environ['CONNECTOR_ROOT'],'config.example.json'))
config.update(tallyUrl=os.environ['MOCK_TALLY'],cloudUrl=os.environ['MOCK_CLOUD'],agentId=os.environ['AGENT'],stateDir=os.environ['STATE'])
context=ssl.create_default_context(cafile=os.environ['CA'])
cloud=SalesCloud(config,token_reader=lambda:os.environ['TOKEN'],tls_context=context,bypass_reader=lambda:None)
worker=SalesWorker(config,cloud=cloud,protect=lambda x:b'TEST'+x,unprotect=lambda x:x[4:],recover_claim=True)
assert worker.tick()
print('Sales: native curl XML -> Python collector -> verified HTTPS -> PostgreSQL passed')
`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python3", ["-B", "-c", python], {
        env: {
          ...process.env,
          CONNECTOR_ROOT: resolvePath("../tally-connector-v1.3/Tally-Office-Connector"),
          MOCK_TALLY: `http://127.0.0.1:${(http.address() as { port: number }).port}/`,
          MOCK_CLOUD: `https://127.0.0.1:${(https.address() as { port: number }).port}`,
          AGENT: connectionId,
          TOKEN: credential,
          STATE: directory,
          CA: cert,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (b) => (text += b));
      child.stderr.on("data", (b) => (text += b));
      child.on("close", (code) =>
        code === 0 ? (console.log(text.trim()), resolve()) : reject(new Error(text)),
      );
    });
    assert.equal((await actual()).saleQty.toString(), "37.304");
    assert.equal((await actual()).saleValue?.toString(), "123.45");
    assert.ok(exports >= 6);
    assert.equal(await prisma.tallySalesChunk.count(), 0);
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
    await new Promise<void>((r) => https.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
}
const resolvePath = resolve;
async function main() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "TallyConnection", "User", "Dealer", "Season", "Product" CASCADE',
  );
  await prisma.user.createMany({
    data: [
      {
        id: actor.userId,
        username: actor.username,
        name: "Admin",
        passwordHash: "disabled",
        role: db.Role.SUPER_ADMIN,
      },
      {
        id: "sales-officer",
        username: "sales-officer",
        name: "Officer",
        passwordHash: "disabled",
        role: db.Role.SALES_OFFICER,
      },
    ],
  });
  await prisma.season.create({
    data: { id: "sales-season", name: "Synthetic", year: +today.slice(0, 4) },
  });
  const oldKey = month === "2026-04" ? "2026-04" : "2026-04";
  await prisma.seasonMonth.createMany({
    data: [
      {
        id: "sales-month",
        seasonId: "sales-season",
        name: "Current",
        order: 1,
        calendarYear: +today.slice(0, 4),
        calendarMonth: +today.slice(5, 7),
      },
      {
        id: "sales-old",
        seasonId: "sales-season",
        name: "Historical",
        order: 2,
        calendarYear: 2026,
        calendarMonth: 4,
      },
    ],
  });
  await prisma.seasonPlan.create({
    data: {
      id: "sales-plan",
      seasonId: "sales-season",
      officerId: "sales-officer",
      status: "APPROVED",
      isActiveVersion: true,
    },
  });
  await prisma.product.create({
    data: { id: "sales-product", name: "Product", rate: 100, nbvPercent: "0.5" },
  });
  for (const id of ["a", "b", "held"]) {
    await prisma.dealer.create({
      data: { id, name: "Dealer " + id.toUpperCase(), isActive: true, status: "ACTIVE" },
    });
    await prisma.dealerAlias.create({
      data: {
        tallyName: "Dealer " + id.toUpperCase(),
        tallyKey: "dealer" + id,
        systemDealerId: id,
      },
    });
    await prisma.planDealer.create({
      data: { id: "pd-" + id, dealerId: id, seasonPlanId: "sales-plan" },
    });
    await prisma.planLine.create({
      data: { id: "line-" + id, planDealerId: "pd-" + id, productId: "sales-product" },
    });
    await prisma.monthlyEntry.create({
      data: {
        planLineId: "line-" + id,
        seasonMonthId: "sales-month",
        planQty: 77,
        planValue: 999,
        saleQty: 20,
        saleValue: 2000,
      },
    });
  }
  await prisma.monthlyEntry.create({
    data: {
      planLineId: "line-a",
      seasonMonthId: "sales-old",
      planQty: 55,
      saleQty: 999,
      saleValue: 8888,
    },
  });
  const access = await (modules["./service.server"] as typeof import("./service.server")).setup(
    actor,
  );
  connectionId = access.agentId;
  credential = access.token;
  await assert.rejects(
    () => call({ action: "claim", requestId: randomUUID() }, "x".repeat(43)),
    (e: any) => e.status === 401,
  );
  await assert.rejects(
    () => svc.requestSalesRefresh({ ...actor, role: db.Role.SALES_OFFICER }, month),
    (e: any) => e.status === 403,
  );
  const requestId = randomUUID(),
    first = (await call({ action: "claim", requestId })).job,
    resumed = (await call({ action: "claim", requestId })).job;
  assert.equal(first.id, resumed.id);
  assert.notEqual(first.leaseToken, resumed.leaseToken);
  assert.equal(await claim(), null);
  const ids = await stage(resumed, result(resumed));
  await assert.rejects(
    () => call({ action: "complete", jobId: first.id, leaseToken: first.leaseToken }),
    (e: any) => e.status === 409,
  );
  await call({ action: "complete", ...ids });
  assert.equal((await actual()).saleQty.toString(), "14.4");
  assert.equal((await actual()).saleValue?.toString(), "1040");
  assert.equal((await actual()).planQty, 77);
  assert.equal((await actual()).planValue?.toString(), "999");
  assert.equal(
    (await actual("line-b")).saleQty.toString(),
    "0",
    "verified dealer without bills clears previous actuals",
  );
  assert.equal(
    (await actual("line-held")).saleQty.toString(),
    "20",
    "unverified ledger preserves old actuals",
  );
  assert.equal(
    (await actual("line-a", "sales-old")).saleQty.toString(),
    "999",
    "automatic refresh preserves older month",
  );
  assert.equal(await prisma.tallySalesVoucher.count(), 1);
  assert.equal(await prisma.tallySalesItem.count(), 1);
  assert.equal((await call({ action: "complete", ...ids })).duplicate, true);
  assert.equal(await prisma.tallySalesVoucher.count(), 1);
  await roundtrip();
  assert.equal(await claim(), null, "automatic refresh not due before 15 minutes");
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].family = "Credit Note";
    r.vouchers[0].items[0].quantity = "-9.750000";
    r.vouchers[0].items[0].amount = "-120.00";
    return r;
  });
  assert.equal((await actual()).saleQty.toString(), "-9.75");
  assert.equal((await actual()).saleValue?.toString(), "-120");
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].items[0].quantity = "0.000000";
    r.vouchers[0].items[0].amount = "1040.00";
    return r;
  });
  assert.equal(
    (await actual()).saleValue?.toString(),
    "1040",
    "zero qty retains value-only adjustments",
  );
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].items[0].stockItemName = "Unknown Product";
    return r;
  });
  assert.equal(
    (await actual()).saleValue?.toString(),
    "1040",
    "unknown product holds whole dealer",
  );
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].cancelled = true;
    return r;
  });
  assert.equal((await actual()).saleValue?.toString(), "0", "cancelled bill excluded");
  await refresh((j) => {
    const r = result(j);
    r.vouchers = [];
    return r;
  });
  assert.equal((await actual()).saleQty.toString(), "0", "deleted bills replaced, not accumulated");
  await refresh((j) => result(j), oldKey);
  assert.equal(
    (await actual("line-a", "sales-old")).saleQty.toString(),
    "14.4",
    "historical manual refresh",
  );
  assert.equal(
    (await actual()).saleQty.toString(),
    "0",
    "historical refresh cannot overwrite current month",
  );
  await svc.requestSalesRefresh(actor, month);
  const changed = await claim();
  const staged = await stage(changed, result(changed));
  await prisma.dealerAlias.updateMany({
    where: { systemDealerId: "a" },
    data: { tallyName: "New Dealer Name" },
  });
  await assert.rejects(
    () => call({ action: "complete", ...staged }),
    (e: any) => e.status === 409,
  );
  assert.equal((await actual()).saleValue?.toString(), "0", "scope changes reject atomically");
  assert.equal(
    (await prisma.tallySalesJob.findUniqueOrThrow({ where: { id: changed.id } })).error,
    "SCOPE_CHANGED",
    "scope changes end the job immediately instead of leaving a stuck read",
  );
  await svc.requestSalesRefresh(actor, month);
  const revokeJob = await claim();
  await (modules["./service.server"] as typeof import("./service.server")).disable(actor);
  await assert.rejects(
    () => call({ action: "heartbeat" }),
    (e: any) => e.status === 401,
  );
  assert.equal(
    (await prisma.tallySalesJob.findUniqueOrThrow({ where: { id: revokeJob.id } })).error,
    "CONNECTION_DISABLED",
  );
  assert.deepEqual(sales.salesPeriod("2026-09", "2026-10-31"), {
    monthKey: "2026-09",
    fromDate: "2026-09-01",
    throughDate: "2026-09-30",
  });
  assert.throws(() => sales.salesPeriod("2026-11", "2026-10-31"));
  console.log(
    "Sales integration: credential/role boundaries, claim recovery, decimals, returns, zero-qty value, verified zero, holds, replacement, replay, 15-minute interval, historical manual refresh, scope-change rollback, revoke: PASS",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
