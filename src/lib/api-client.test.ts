import assert from "node:assert/strict";
import { api, ApiNetworkError, ApiRequestError } from "./api-client";

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(() => api.post("/save", { amount: 1 }), (e: unknown) => e instanceof ApiNetworkError && e.code === "API_NETWORK_ERROR");
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    globalThis.fetch = async () => { throw abort; };
    await assert.rejects(() => api.get("/save"), (e) => e === abort, "cancellation is preserved, not retried as a transport failure");
    for (const status of [422, 503]) {
      globalThis.fetch = async () => new Response("<html>proxy error</html>", { status });
      await assert.rejects(() => api.get("/save"), (e: unknown) => e instanceof ApiRequestError && e.status === status, "non-JSON error responses retain their HTTP status");
    }
    globalThis.fetch = async () => new Response("bad JSON", { status: 200 });
    await assert.rejects(() => api.get("/save"), SyntaxError, "bad success payload is not called a network failure");
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Missing value", issues: { amount: ["Required"] } }), { status: 422 });
    await assert.rejects(() => api.post("/save", {}), (e: unknown) => e instanceof ApiRequestError && e.status === 422 && e.issues?.amount?.[0] === "Required", "existing validation details survive");
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
    assert.deepEqual(await api.get("/save"), { ok: true });
    const circular: { self?: unknown } = {}; circular.self = circular;
    assert.throws(() => api.post("/save", circular), TypeError, "payload coding errors remain local errors");
  } finally { globalThis.fetch = originalFetch; }
  console.log("api-client.test.ts — all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
