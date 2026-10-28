/** Runs only against a new /tmp/tally-test-pg.* Unix-socket database. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as db from "@prisma/client";
import { z } from "zod";
import * as pure from "./billwise";
const url = process.env.TALLY_DISPOSABLE_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/tally-test-pg.")
)
  throw new Error("Disposable local test database required; application databases forbidden");
process.env.DATABASE_URL = url;
process.env.TALLY_SYNC_ENABLED = "true";
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
const require = createRequire(import.meta.url);
function load<T>(file: string): T {
  const source = readFileSync(resolve(file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const aliases: Record<string, unknown> = {
    "server-only": {},
    "@prisma/client": db,
    zod: { z },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "./billwise": pure,
    "@/lib/audit": {
      writeAudit: async (data: unknown, tx: db.Prisma.TransactionClient) =>
        tx.auditLog.create({ data: data as db.Prisma.AuditLogCreateInput }),
    },
  };
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    require: (name: string) => aliases[name] ?? require(name),
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
const svc = load<typeof import("./service.server")>("src/features/tally/service.server.ts");
const day = pure.indiaDay(),
  [year, month] = day.split("-").map(Number),
  anchor = "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00002385";
const previousMonth = month === 1 ? 12 : month - 1,
  previousYear = month === 1 ? year - 1 : year;
const actor = { userId: "admin", username: "admin", role: db.Role.SUPER_ADMIN, groupId: null };
async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE "TallyConnection", "User", "Dealer", "Season" CASCADE');
  await prisma.user.createMany({
    data: [
      {
        id: "admin",
        name: "Synthetic Admin",
        username: "tally-test-admin",
        passwordHash: "disabled",
        role: db.Role.SUPER_ADMIN,
      },
      {
        id: "officer",
        name: "Synthetic Officer",
        username: "tally-test-officer",
        passwordHash: "disabled",
        role: db.Role.SALES_OFFICER,
      },
    ],
  });
  await prisma.season.create({ data: { id: "season", name: "Synthetic Tally Test", year } });
  await prisma.seasonMonth.createMany({
    data: [
      {
        id: "month",
        seasonId: "season",
        name: "Current",
        order: 1,
        calendarMonth: month,
        calendarYear: year,
      },
      {
        id: "oldmonth",
        seasonId: "season",
        name: "Historical",
        order: 2,
        calendarMonth: previousMonth,
        calendarYear: previousYear,
      },
    ],
  });
  for (const id of ["a", "b", "c", "d", "outside", "inactive"])
    await prisma.dealer.create({
      data: { id, name: "Synthetic " + id, isActive: id !== "inactive" },
    });
  await prisma.recoveryPlan.createMany({
    data: [
      {
        id: "current",
        seasonId: "season",
        seasonMonthId: "month",
        officerId: "officer",
        cutoffDate: new Date(day + "T12:00Z"),
        status: db.PlanStatus.APPROVED,
      },
      {
        id: "historical",
        seasonId: "season",
        seasonMonthId: "oldmonth",
        officerId: "officer",
        cutoffDate: new Date(`${previousYear}-${String(previousMonth).padStart(2, "0")}-01T12:00Z`),
        status: db.PlanStatus.APPROVED,
      },
    ],
  });
  for (const dealerId of ["a", "b", "c", "d", "inactive"])
    await prisma.recoveryPlanDealer.create({
      data: {
        recoveryPlanId: "current",
        dealerId,
        outstanding: "100.00",
        overdue: "100.00",
        monthRecoveryPlan: "333.00",
        monthRunningRecovery: "44.00",
        outstandingTillDate: "555.00",
        runningTillDate: "777.00",
        srCr: "12.00",
        liveRecovery: "13.00",
        noPlan: true,
        noPlanReason: "test",
      },
    });
  await prisma.recoveryPlanDealer.create({
    data: { recoveryPlanId: "historical", dealerId: "a", outstanding: "999.00" },
  });
  const rd = await prisma.recoveryPlanDealer.findFirstOrThrow({
    where: { recoveryPlanId: "current", dealerId: "a" },
  });
  await prisma.recoveryWeekPlan.create({
    data: { recoveryPlanDealerId: rd.id, weekNo: 1, weekRecoveryPlan: "101.00" },
  });
  await prisma.recoveryWeekLock.create({
    data: { recoveryPlanId: "current", weekNo: 1, locked: true },
  });
  for (const [dealerId, tallyName] of [
    ["a", "Dealer A"],
    ["b", "Dealer B"],
    ["c", "Dealer C"],
    ["outside", "Outside"],
    ["inactive", "Inactive"],
  ])
    await prisma.dealerAlias.create({
      data: { systemDealerId: dealerId, tallyName, tallyKey: pure.tight(tallyName) },
    });
  const before = await prisma.recoveryPlanDealer.findMany({ orderBy: { dealerId: "asc" } });
  const beforePlan = await prisma.recoveryPlan.findMany({ orderBy: { id: "asc" } }),
    beforeWeeks = await prisma.recoveryWeekPlan.findMany(),
    beforeLocks = await prisma.recoveryWeekLock.findMany();
  const access = await svc.setup(actor);
  assert.notEqual(
    (await prisma.tallyConnection.findUniqueOrThrow({ where: { id: access.agentId } }))
      .credentialHash,
    access.token,
  );
  const req = (token = access.token) =>
    new Request("https://example.test/api/tally/agent", {
      headers: { authorization: "Bearer " + token, "x-agent-id": access.agentId },
    });
  await assert.rejects(
    () => svc.agent(req("x".repeat(43)), { action: "claim" }),
    (e) => (e as ApiError).status === 401,
  );
  const claimed = (await svc.agent(req(), { action: "claim" })) as {
    job: { id: string; leaseToken: string; aliases: { name: string }[] };
  };
  const job = claimed.job;
  assert.ok(job);
  assert.deepEqual(
    job.aliases.map((x) => x.name),
    ["Dealer A", "Dealer B", "Dealer C"],
  );
  assert.equal(
    JSON.stringify(await svc.agent(req(), { action: "claim" })),
    JSON.stringify({ job: null }),
  );
  const body = JSON.stringify({
    version: "billwise.sync.v1",
    companyName: "Agromaxx Industry (2026-27)",
    asOf: day,
    observedAt: new Date().toISOString(),
    sourceSha256: "a".repeat(64),
    anchor: {
      name: "NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP",
      guid: anchor,
      closingBalance: "-100.00",
    },
    ledgers: [
      { name: "Dealer A", guid: anchor.slice(0, 36) + "-00000001", closingBalance: "-50.00" },
      { name: "Dealer B", guid: anchor.slice(0, 36) + "-00000002", closingBalance: "0.00" },
    ],
    unavailableNames: ["Dealer C"],
    bills: [
      {
        partyName: "Dealer A",
        billDate: "2019-06-19",
        reference: "Old unpaid",
        pendingAmount: "50.00",
        dueDate: day,
      },
    ],
  });
  const chunks = body.match(/.{1,200}/g)!;
  const ids = { jobId: job.id, leaseToken: job.leaseToken };
  const manifest = {
    chunks: chunks.length,
    bytes: Buffer.byteLength(body),
    sha256: pure.digest(body),
  };
  await svc.agent(req(), { action: "begin", ...ids, manifest });
  await svc.agent(req(), { action: "begin", ...ids, manifest });
  await svc.agent(req(), {
    action: "chunk",
    ...ids,
    sequence: 0,
    hash: pure.digest(chunks[0]),
    data: chunks[0],
  });
  await assert.rejects(
    () => svc.agent(req(), { action: "complete", ...ids }),
    (e) => (e as ApiError).status === 422,
  );
  assert.deepEqual(
    await prisma.recoveryPlanDealer.findMany({ orderBy: { dealerId: "asc" } }),
    before,
    "partial upload changed a balance",
  );
  for (let sequence = 0; sequence < chunks.length; sequence++)
    await svc.agent(req(), {
      action: "chunk",
      ...ids,
      sequence,
      hash: pure.digest(chunks[sequence]),
      data: chunks[sequence],
    });
  await svc.agent(req(), { action: "complete", ...ids });
  const after = await prisma.recoveryPlanDealer.findMany({ orderBy: { dealerId: "asc" } });
  for (const old of before) {
    const v = after.find((x) => x.id === old.id)!;
    const changed = old.recoveryPlanId === "current" && ["a", "b"].includes(old.dealerId);
    if (changed) {
      assert.equal(v.outstanding.toFixed(2), old.dealerId === "a" ? "50.00" : "0.00");
      for (const k of ["outstanding", "overdue", "due", "running"] as const) {
        v[k] = old[k];
      }
    }
    assert.deepEqual(v, old, "non-aging field or unrelated row changed");
  }
  assert.deepEqual(
    await prisma.recoveryPlan.findMany({ orderBy: { id: "asc" } }),
    beforePlan,
    "plan cutoff/status/approvals changed",
  );
  assert.deepEqual(await prisma.recoveryWeekPlan.findMany(), beforeWeeks);
  assert.deepEqual(await prisma.recoveryWeekLock.findMany(), beforeLocks);
  assert.equal(await prisma.agingSnapshot.count(), 1);
  assert.equal(await prisma.agingSnapshotBill.count(), 1);
  assert.equal(await prisma.tallyLedgerBinding.count(), 2);
  await svc.agent(req(), { action: "begin", ...ids, manifest });
  await svc.agent(req(), {
    action: "chunk",
    ...ids,
    sequence: 0,
    hash: pure.digest(chunks[0]),
    data: chunks[0],
  });
  const replay = await svc.agent(req(), { action: "complete", ...ids });
  assert.equal(JSON.stringify(replay), JSON.stringify({ ok: true, duplicate: true }));
  assert.equal(await prisma.agingSnapshot.count(), 1);
  assert.equal(await prisma.tallySyncChunk.count(), 0, "committed staging data not removed");
  // Exercise the actual Python cloud transport against HTTPS + this database service.
  const certdir = mkdtempSync(join(tmpdir(), "tally-http-test-"));
  const openssl = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certdir, "key.pem"),
      "-out",
      join(certdir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  assert.equal(openssl.status, 0);
  const http = httpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const xml = Buffer.concat(parts).toString();
    let response = "";
    if (xml.includes("Bills Receivable"))
      response = `<ENVELOPE><BILLFIXED><BILLDATE>19-Jun-19</BILLDATE><BILLREF>Old unpaid</BILLREF><MAINBILLBROKERNAME>TEST</MAINBILLBROKERNAME><BILLPARTY>Dealer A</BILLPARTY></BILLFIXED><BILLCL>-50.00</BILLCL><BILLDUE>${day}</BILLDUE><BILLOVERDUE>0</BILLOVERDUE><BILLVCHDATE>19-Jun-19</BILLVCHDATE><BILLVCHTYPE>Opening Balance</BILLVCHTYPE><BILLVCHNUMBER></BILLVCHNUMBER><BILLVCHAMOUNT>-50.00</BILLVCHAMOUNT></ENVELOPE>`;
    else {
      const name = xml.match(/<ID TYPE="Name">(.*?)<\/ID>/)?.[1];
      const id =
        name === "Dealer A"
          ? anchor.slice(0, 36) + "-00000001"
          : name === "Dealer B"
            ? anchor.slice(0, 36) + "-00000002"
            : anchor;
      const amount = name === "Dealer A" ? "-50.00" : name === "Dealer B" ? "0.00" : "-100.00";
      response =
        name === "Dealer C"
          ? "<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>"
          : `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><LEDGER NAME="${name}"><GUID>${id}</GUID><PARENT>TEST</PARENT><CLOSINGBALANCE>${amount}</CLOSINGBALANCE></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    }
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(response);
  });
  const https = httpsServer(
    { key: readFileSync(join(certdir, "key.pem")), cert: readFileSync(join(certdir, "cert.pem")) },
    async (req, res) => {
      try {
        assert.equal(req.url, "/api/tally/agent");
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const request = new Request("https://localhost/api/tally/agent", {
          method: "POST",
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(parts),
        });
        const out = await svc.agent(request, await svc.readBody(request));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead((e as ApiError).status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test request rejected" }));
      }
    },
  );
  try {
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    await prisma.tallyConnection.update({
      where: { id: access.agentId },
      data: { lastAttemptAt: new Date(0) },
    });
    const python = `import os,sys,json,ssl
sys.path.insert(0,os.environ['TALLY_CONNECTOR_TEST_ROOT'])
import connector as c
from billwise_worker import BillWorker
config=c.load_config(os.path.join(os.environ['TALLY_CONNECTOR_TEST_ROOT'],'config.example.json'))
config.update(tallyUrl=os.environ['TALLY_MOCK_ORIGIN'],cloudUrl=os.environ['TALLY_MOCK_CLOUD'],agentId=os.environ['TALLY_TEST_AGENT'],stateDir=os.environ['TALLY_TEST_STATE'])
context=ssl.create_default_context(cafile=os.environ['TALLY_TEST_CA'])
cloud=c.Cloud(config,token_reader=lambda:os.environ['TALLY_TEST_TOKEN'],tls_context=context)
worker=BillWorker(config,cloud=cloud,protect=lambda x:b'TEST'+x,unprotect=lambda x:x[4:])
assert worker.tick()
print('Python -> verified HTTPS -> atomic PostgreSQL publication passed')
`;
    const env = {
      ...process.env,
      TALLY_CONNECTOR_TEST_ROOT: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
      TALLY_MOCK_ORIGIN: `http://127.0.0.1:${(http.address() as { port: number }).port}/`,
      TALLY_MOCK_CLOUD: `https://127.0.0.1:${(https.address() as { port: number }).port}`,
      TALLY_TEST_AGENT: access.agentId,
      TALLY_TEST_TOKEN: access.token,
      TALLY_TEST_STATE: certdir,
      TALLY_TEST_CA: join(certdir, "cert.pem"),
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python3", ["-B", "-c", python], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (b) => (text += b));
      child.stderr.on("data", (b) => (text += b));
      child.on("close", (code) =>
        code === 0 ? (console.log(text.trim()), resolve()) : reject(new Error(text)),
      );
    });
    assert.equal(await prisma.agingSnapshot.count(), 2);
    assert.equal(await prisma.tallySyncChunk.count(), 0);
  } finally {
    await Promise.all([
      new Promise<void>((r) => http.close(() => r())),
      new Promise<void>((r) => https.close(() => r())),
    ]);
    rmSync(certdir, { recursive: true, force: true });
  }
  await prisma.tallyConnection.update({
    where: { id: access.agentId },
    data: { requestWindowAt: new Date(), requestCount: 300 },
  });
  await assert.rejects(
    () => svc.agent(req(), { action: "claim" }),
    (e) => (e as ApiError).status === 429,
  );
  assert.equal(
    (await prisma.tallyConnection.findUniqueOrThrow({ where: { id: access.agentId } }))
      .requestCount,
    301,
    "rejected calls must consume durable rate budget",
  );
  await prisma.tallyConnection.update({
    where: { id: access.agentId },
    data: { requestWindowAt: new Date(), requestCount: 0 },
  });
  await prisma.user.update({ where: { id: "admin" }, data: { isActive: false } });
  await assert.rejects(
    () => svc.agent(req(), { action: "claim" }),
    (e) => (e as ApiError).status === 403,
  );
  await prisma.user.update({ where: { id: "admin" }, data: { isActive: true } });
  // A mapping changed after claim invalidates an otherwise complete staged report.
  await prisma.tallyConnection.update({
    where: { id: access.agentId },
    data: { lastAttemptAt: new Date(0) },
  });
  const second = (
    (await svc.agent(req(), { action: "claim" })) as { job: { id: string; leaseToken: string } }
  ).job;
  const secondIds = { jobId: second.id, leaseToken: second.leaseToken };
  await svc.agent(req(), { action: "begin", ...secondIds, manifest });
  for (let sequence = 0; sequence < chunks.length; sequence++)
    await svc.agent(req(), {
      action: "chunk",
      ...secondIds,
      sequence,
      hash: pure.digest(chunks[sequence]),
      data: chunks[sequence],
    });
  await prisma.dealerAlias.update({
    where: { tallyKey: pure.tight("Dealer A") },
    data: { systemDealerId: "outside" },
  });
  await assert.rejects(
    () => svc.agent(req(), { action: "complete", ...secondIds }),
    (e) => (e as ApiError).status === 409,
  );
  assert.equal(await prisma.agingSnapshot.count(), 2, "changed mapping must prevent publication");
  await svc.disable(actor);
  await assert.rejects(
    () => svc.agent(req(), { action: "complete", ...ids }),
    (e) => (e as ApiError).status === 401,
  );
  console.log(
    "PASS real PostgreSQL: credentials, current-plan scope, explicit-zero validation, held dealers, partial uploads, atomic publish, history/manual-input/lock preservation, GUID binding, lost-ack replay and revocation",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
