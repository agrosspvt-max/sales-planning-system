import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AuthUserCache } from "./auth-user-cache";

async function main() {
  // Independently evaluated route bundles share ONE process-level lookup.
  const global = {};
  const code = ts.transpileModule(readFileSync("src/lib/auth-user-cache.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const route = () => { const exports = {} as { sharedAuthUserCache: <T>() => AuthUserCache<T> }; runInNewContext(code, { exports, globalThis: global, Map, Promise, Date }); return exports; };
  const routes = Array.from({ length: 20 }, route);
  let reads = 0;
  const lookup = async () => { reads++; return { id: "one", active: true }; };
  await Promise.all(routes.map(r => r.sharedAuthUserCache<{ id: string; active: boolean }>().load("one", "one:jwt", 8000, lookup)));
  assert.equal(reads, 1, "20 route bundles issue one auth query, not 20 pool checkouts");
  routes[0]!.sharedAuthUserCache().invalidate("one");
  await routes[19]!.sharedAuthUserCache().load("one", "one:jwt", 8000, lookup);
  assert.equal(reads, 2, "invalidation in a user-management route reaches all API bundles");

  // A deactivation racing a lookup cannot re-cache or return the old row.
  const cache = new AuthUserCache<{ active: boolean }>();
  let finish!: (v: { active: boolean }) => void;
  let calls = 0;
  const racedLookup = () => ++calls === 1 ? new Promise<{ active: boolean }>(r => { finish = r; }) : Promise.resolve({ active: false });
  const pending = cache.load("u", "u:token", 8000, racedLookup);
  await Promise.resolve(); cache.invalidate("u"); finish({ active: true });
  assert.equal((await pending).active, false); assert.equal(calls, 2);
  assert.equal((await cache.load("u", "u:token", 8000, racedLookup)).active, false);

  const errors = new AuthUserCache<null>();
  await assert.rejects(errors.load("u", "u:token", 0, async () => { throw Error("offline"); }), /offline/);
  assert.equal(await errors.load("u", "u:token", 0, async () => null), null, "an error does not poison future lookups");
  let noCacheReads = 0;
  await errors.load("u", "u:token", 0, async () => { noCacheReads++; return null; });
  await errors.load("u", "u:token", 0, async () => { noCacheReads++; return null; });
  assert.equal(noCacheReads, 2, "zero TTL retains per-request revalidation");
  console.log("auth-user-cache.test.ts — all assertions passed");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
