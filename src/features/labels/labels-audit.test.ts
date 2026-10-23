/**
 * Labels integration audit. Static coverage (registry ↔ consumers), placeholder handling, preservation of administrator customizations, and the guarantee that
 * a label only changes wording. No database.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LABELS, labelCatalog, labelMeta, resolveLabels, type LabelKey } from "./labels";
import { fillLabel } from "@/lib/label-fill";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";

const { labeledError } = testLoader({ "@/lib/api-error": { ApiError: TestApiError } })<typeof import("./labeled-error")>("src/features/labels/labeled-error.ts");
const D = DEFAULT_LABELS as Record<string, string>;
const files: string[] = [];
(function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f) && !/\.(test|integration)\./.test(f) && !p.endsWith("labels/labels.ts")) files.push(p);
  }
})("src");
const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
const keys = Object.keys(D);

// ---- 1. every key is findable in the Labels screen under an understandable module (nothing falls into the catch-all)
assert.deepEqual(keys.filter((k) => labelMeta(k as LabelKey).module === "Other"), [], "every registered label belongs to a named module");
const catalog = labelCatalog({});
assert.equal(catalog.length, keys.length);
assert.ok(catalog.every((e) => e.default === D[e.key] && e.current === e.default && !e.customized), "an uncustomized label shows its default wording");
assert.ok(keys.every((k) => typeof D[k] === "string" && D[k]!.trim() !== "" && D[k] !== "undefined" && D[k] !== k), "no default is blank, 'undefined' or the raw key");

// ---- 2. a UI/server lookup for an unregistered key is incomplete: every literal key used in source is registered
const prefixes = new Set(keys.map((k) => k.split(".")[0]));
const used = new Set<string>();
for (const m of source.matchAll(/["'`]([a-z][a-z_]*(?:\.[A-Za-z0-9_+\-]+)+)["'`]/g)) if (prefixes.has(m[1]!.split(".")[0]!)) used.add(m[1]!);
// (identifiers that merely share a label prefix: system-setting keys and a data field, not label lookups)
const NOT_LABELS = new Set(["summary.planningRows", "recovery.dueValidation", "calendar.enabled", "recovery.autoTasksEnabled"]);
const unregistered = [...used].filter((k) => !(k in D) && !NOT_LABELS.has(k) && !/\.(tsx?|json|css|js)$/.test(k) && !/^(date|col|summary)\.[a-z]+$/.test(k));
assert.deepEqual(unregistered, [], "every label key referenced by the application is registered (and so editable)");

// ---- 3. a registered key the UI never reads is incomplete: the keys added by this audit and the CN / Retailer / Performance work are all consumed
const dynamicPrefixes = [/^cn_requests\.detail\.timeline\.[A-Z_]+$/, /^party_planning\.retailer\.error\.(name|firm|phone|dealers)_/, /^accounts\.permission\./, /^daily_work\.outcome\.error\./, /^last_payment\.bucket\./];
const mustBeRead = keys.filter((k) => /^(accounts\.|notifications\.ui\.|dealer_tags\.master\.|last_payment\.(page|tab|col|aria|empty|search|action|msg|summary|ranking|bucket|aging)|billing_exception\.(info|error)\.|party_planning\.(retailer|territory\.error|unavailable)|daily_work\.error\.|cn_requests\.(reopen|view\.(cn_in_grace|expired)|acceptance\.(grace|expiry)|detail\.timeline|error\.cn_expired|error\.reopen|validation\.(reopen|grace|expiry|return)))/.test(k) || /^calendar\.(subtitle|view_group|more)/.test(k));
const unread = mustBeRead.filter((k) => !source.includes(`"${k}"`) && !dynamicPrefixes.some((re) => re.test(k)));
assert.deepEqual(unread, [], "every label added for the audited areas is read by a screen");

// ---- 4. server-side messages: no hardcoded ApiError text is left in the audited modules; they all go through labeledError
for (const f of ["src/features/party-planning/territory.server.ts", "src/features/party-planning/retailer.server.ts", "src/features/cn-requests/cn-expiry.server.ts", "src/features/cn-requests/service.server.ts"]) {
  const text = readFileSync(f, "utf8");
  const hardcoded = [...text.matchAll(/new ApiError\(\d+, (["`])/g)];
  assert.equal(hardcoded.length, f.endsWith("service.server.ts") ? 0 : 0, `${f}: no hardcoded user-facing ApiError text`);
}

// ---- 5. placeholders: every {name} in a default is supplied by each labeledError call that uses it, and survives editing
for (const f of files.filter((p) => p.endsWith(".server.ts"))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/labeledError\(\d+, "([^"]+)"(?:, \{([^}]*)\})?\)/g)) {
    const key = m[1]!;
    assert.ok(key in D, `${f}: ${key} is registered`);
    const wanted = [...D[key]!.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
    const given = [...(m[2] ?? "").matchAll(/(\w+):/g)].map((x) => x[1]!);
    for (const name of wanted) assert.ok(given.includes(name), `${f}: ${key} needs {${name}}`);
  }
}
assert.equal(fillLabel("Hello {name}, {n} left, {missing}", { name: "A", n: 3 }), "Hello A, 3 left, {missing}", "unknown placeholders are left as typed");
assert.equal(fillLabel("{a}{a}", { a: "x" }), "xx");
const err = labeledError(409, "party_planning.territory.error.market_exists", { market: "Indore" });
assert.deepEqual([err.status, err.message], [409, 'The Market "Indore" already exists.'], "default wording is filled with the runtime value; the status is independent of the wording");
assert.equal((err as { labelKey: string }).labelKey, "party_planning.territory.error.market_exists");

// ---- 6. customizations survive: new keys never reset what an administrator already changed
const customized = { "cn_requests.view.expired": "Lapsed CN", "party_planning.retailer.title": "Retailers", "tasks.title": "Task Board", "unknown.removed.key": "x", "cn_requests.view.cn_in_grace": "   " };
const resolved = resolveLabels(customized);
assert.equal(resolved["cn_requests.view.expired"], "Lapsed CN");
assert.equal(resolved["party_planning.retailer.title"], "Retailers");
assert.equal(resolved["cn_requests.view.cn_in_grace"], D["cn_requests.view.cn_in_grace"], "a blank override falls back to the default wording");
assert.ok(!("unknown.removed.key" in resolved), "unknown keys are ignored");
assert.equal(resolved["cn_requests.reopen.action"], D["cn_requests.reopen.action"], "a key nobody customized shows its default");
assert.ok(Object.values(resolved).every((v) => v && v !== "undefined"));
const cat = labelCatalog(customized);
assert.equal(cat.find((e) => e.key === "cn_requests.view.expired")?.customized, true);
assert.equal(cat.find((e) => e.key === "cn_requests.view.expired")?.default, "Expired CN", "the default stays visible next to the customization");
// the registration/seed path never writes: DEFAULT_LABELS is a code constant, overrides live in their own settings row (read-only here)
const service = readFileSync("src/features/labels/service.server.ts", "utf8");
assert.ok(!/DEFAULT_LABELS\s*\[[^\]]+\]\s*=/.test(service) && service.includes("overrides[key]") && service.includes("delete overrides[key]"), "only the single edited key is changed");

// ---- 7. wording never drives behaviour: the identifiers behind the audited screens are fixed values, not label text
const cn = readFileSync("src/features/cn-requests/cn-requests-page.tsx", "utf8");
assert.ok(/value: "cn-near-expire", label: labels\.inGrace/.test(cn) && /value: "expired-cn", label: labels\.expiredCn/.test(cn), "tab identifiers are fixed; only the label is editable");
assert.ok(!/view=\$\{[^}]*labels\./.test(cn) && !/queryKey: \[[^\]]*labels\./.test(cn), "query strings and cache keys never contain label text");
const retailerUi = readFileSync("src/features/party-planning/retailer-mapping.tsx", "utf8");
assert.ok(!/(status|view|kind)\s*===\s*(L|labels|T)\./.test(retailerUi), "retailer status/view logic compares identifiers, never label text");
const territory = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
assert.ok(/key: "retailer", label: tabRetailer/.test(territory), "Retailer Mapping tab: fixed key, editable label");

// ---- 8. API handler: an edited label reaches the user, status unchanged; labels unavailable → default wording, never a blank
async function respond(overrides: Record<string, string> | "fail") {
  const load = testLoader({
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/auth": { auth: async () => null }, "@/lib/prisma": { prisma: {} }, "@/lib/db-retry": { withDbRetry: async (f: () => unknown) => f() }, "@/lib/auth-user-cache": { sharedAuthUserCache: () => ({ get: async () => null, set: () => undefined }) },
    "@/lib/db-admission": { DATABASE_BUSY_MESSAGE: "busy" }, "@/lib/rbac": { can: () => true }, "@/lib/api-error": { ApiError: TestApiError },
    "@/features/labels/service.server": { getResolvedLabels: async () => { if (overrides === "fail") throw new Error("down"); return resolveLabels(overrides); } },
  });
  const http = load<{ handle: (fn: () => Promise<unknown>) => Promise<{ body: { error: string }; status: number }> }>("src/lib/http.ts");
  return http.handle(async () => { throw Object.assign(new TestApiError(409, "Default text"), { labelKey: "party_planning.territory.error.market_exists", labelVars: { market: "Indore" } }); });
}
(async () => {
const edited = await respond({ "party_planning.territory.error.market_exists": 'Market "{market}" is already on file.' });
assert.deepEqual([edited.status, edited.body.error], [409, 'Market "Indore" is already on file.'], "edited wording is shown with the runtime value filled in; the status is untouched");
const plain = await respond({});
assert.deepEqual([plain.status, plain.body.error], [409, 'The Market "Indore" already exists.']);
const down = await respond("fail");
assert.deepEqual([down.status, down.body.error], [409, "Default text"], "if labels cannot be read, the default wording is used");

console.log("labels-audit.test.ts — all assertions passed");
})().catch((error) => { console.error(error); process.exit(1); });
