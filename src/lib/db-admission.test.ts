import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseAdmission, admitPrismaClient, databaseRuntimeOptions } from "./db-admission";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  const options = databaseRuntimeOptions("postgresql://user:password@localhost/db?sslmode=require&pool_timeout=10");
  assert.equal(options.poolSize, 8); assert.equal(options.limit, 6);
  assert.equal(new URL(options.url).searchParams.get("pool_timeout"), "10", "pool timeout is NOT increased");
  assert.equal(new URL(options.url).searchParams.get("sslmode"), "require");
  assert.equal(databaseRuntimeOptions("postgresql://localhost/db?connection_limit=3").limit, 1);
  assert.equal(databaseRuntimeOptions("postgresql://localhost/db?connection_limit=1").limit, 1);
  assert.throws(() => databaseRuntimeOptions("postgresql://localhost/db?connection_limit=3", "4"));

  // Fifty callers contend for a pool of two: bounded work, no lost work and FIFO service.
  const admission = new DatabaseAdmission(2);
  const gates = Array.from({ length: 50 }, deferred);
  const started: number[] = [];
  const tasks = gates.map((g, i) => admission.run(async () => { started.push(i); await g.promise; return i; }));
  await turn(); assert.deepEqual(started, [0, 1]); assert.equal(admission.stats.queued, 48);
  for (let i = 0; i < gates.length; i++) { gates[i]!.resolve(); await turn(); assert.ok(admission.stats.active <= 2); }
  assert.deepEqual(await Promise.all(tasks), gates.map((_, i) => i));
  assert.deepEqual(started, gates.map((_, i) => i));
  assert.equal(admission.stats.active, 0);

  // Queue failures never launch expired work, or release a still-running operation's slot.
  const bounded = new DatabaseAdmission(1, 1, 15), gate = deferred();
  const running = bounded.run(() => gate.promise);
  let executed = false;
  const expired = bounded.run(async () => { executed = true; });
  const expiry = assert.rejects(expired, (e: unknown) => (e as { status: number }).status === 503);
  await assert.rejects(bounded.run(async () => {}), (e: unknown) => (e as { status: number }).status === 503);
  await expiry; assert.equal(executed, false); assert.equal(bounded.stats.active, 1);
  gate.resolve(); await running;
  await assert.rejects(bounded.run(async () => { throw Error("failed operation"); }), /failed operation/);
  assert.equal(await bounded.run(async () => 42), 42);

  // With a limit of ONE, statements inside a transaction must not wait for a second slot.
  const runtime = { admission: new DatabaseAdmission(1), transaction: new AsyncLocalStorage<boolean>() };
  const seenOptions: unknown[] = [];
  let hook!: (input: { args: unknown; query: (args: unknown) => Promise<unknown> }) => Promise<unknown>;
  const query = () => hook({ args: {}, query: async () => 1 });
  const fake = { $extends(extension: { query: { $allOperations: typeof hook } }) {
    hook = extension.query.$allOperations;
    return { query, $transaction: async (input: ((tx: { query: typeof query }) => Promise<unknown>) | unknown[], options?: unknown) => {
      seenOptions.push(options);
      assert.equal(runtime.admission.stats.active, 1);
      assert.equal(runtime.transaction.getStore(), true);
      return typeof input === "function" ? input({ query }) : Promise.all(input);
    } };
  } };
  const client = admitPrismaClient(fake, runtime) as unknown as { query: typeof query; $transaction: (fn: (tx: { query: typeof query }) => Promise<unknown>) => Promise<unknown> };
  assert.equal(await client.$transaction(async (tx) => { await tx.query(); return tx.query(); }), 1);
  await assert.rejects(client.$transaction(async tx => { await tx.query(); throw Error("rollback"); }), /rollback/);
  assert.equal(await client.query(), 1); assert.equal(runtime.admission.stats.active, 0);
  // Explicit transaction limits (timeout / maxWait) pass through the admission wrapper to Prisma unchanged; the wrapper holds ONE slot for the whole transaction.
  const limits = { timeout: 15_000, maxWait: 10_000 };
  await (client as unknown as { $transaction: (fn: (tx: { query: typeof query }) => Promise<unknown>, o: unknown) => Promise<unknown> }).$transaction(async (tx) => tx.query(), limits);
  assert.equal(seenOptions.at(-1), limits, "transaction options reach Prisma");
  console.log("db-admission.test.ts — all assertions passed");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
