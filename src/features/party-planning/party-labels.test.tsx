/** Party Planning static text is editable through the EXISTING Edit Labels system: every key is registered, defaults render, saved overrides apply, nothing is hard-coded. */
import assert from "node:assert/strict";
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LABELS, labelCatalog, resolveLabels, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

const dir = "src/features/party-planning";
const pages = ["party-planning-page", "seasonal-planning-page", "seasonal-plan-list-page", "monthly-planning-page", "monthly-plan-list-page", "plan-list-parts", "territory-mapping-page", "dealer-status-requests"];

// 1. Every label key referenced by a page exists in the registry (no raw-key fallbacks), and all are catalogued under Party Planning.
const referenced = new Set<string>();
for (const f of pages) for (const m of readFileSync(`${dir}/${f}.tsx`, "utf8").matchAll(/"(party_planning\.[a-z0-9_.]+)"/g)) referenced.add(m[1]!);
assert.ok(referenced.size > 250, `pages reference the label registry (${referenced.size} keys)`);
for (const k of referenced) assert.ok(k in DEFAULT_LABELS, `key registered: ${k}`);
const catalog = labelCatalog({});
for (const k of referenced) {
  const e = catalog.find((c) => c.key === k)!;
  assert.equal(e.module, "Party Planning", `${k} appears in Edit Labels under Party Planning`);
  assert.ok(e.default.trim().length > 0 && !e.customized && e.current === e.default, `${k} has a non-empty English default`);
}
// every Party Planning key is used by some page (no dead keys), and no key holds dynamic data
const all = Object.keys(DEFAULT_LABELS).filter((k) => k.startsWith("party_planning."));
const used = new Set([...referenced, "party_planning.title"]);
// legacy keys that the legacy pages build dynamically
for (const k of all) assert.ok(used.has(k) || /^party_planning\.(col|action|view|territory\.(tab|action|field|col|search|all_markets|unmapped|empty$)|seasonal\.(col|empty$)|monthly\.(col|search|empty$))/.test(k) || /^party_planning\.(nav|view)\./.test(k), `unused Party Planning key: ${k}`);

// 2. Saved overrides appear; blank / unknown overrides fall back to the default English text (never blank, never a raw key).
const ov = resolveLabels({ "party_planning.status.awaiting_rm": "Waiting for RM", "party_planning.common.open": "  ", "party_planning.nope": "x", "party_planning.stage.older": "Archive" });
assert.equal(ov["party_planning.status.awaiting_rm"], "Waiting for RM");
assert.equal(ov["party_planning.common.open"], "Open", "blank override → default");
assert.equal(ov["party_planning.stage.older"], "Archive");
assert.ok(!("party_planning.nope" in ov), "unknown keys are ignored");

// 3. The UI reads labels through useLabel: custom text replaces the default everywhere the key is used; the status colour still follows the stable status.
let custom: Record<string, string> = {};
const lookup = (k: LabelKey) => custom[k] ?? DEFAULT_LABELS[k];
const overrides = {
  "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{lookup(k)}</>, useLabel: lookup },
  "@tanstack/react-query": { useMutation: () => ({}), useQuery: () => ({}), useQueryClient: () => ({}) },
  "@/lib/api-client": { api: {} },
};
const load = testLoader(overrides);
const parts = load("src/features/party-planning/plan-list-parts.tsx") as { SheetStatusBadge: React.ComponentType<{ status: string }>; OpenButton: React.ComponentType<{ href: string }> };
const nav = load("src/features/party-planning/party-planning-page.tsx") as { PartyPlanModeLinks: React.ComponentType<{ mode: string; stage?: string }> };
const helpers = load("src/features/party-planning/party-labels.tsx") as { fill: (t: string, v: Record<string, unknown>) => string; fillNodes: (t: string, v: Record<string, React.ReactNode>) => React.ReactNode; useLabels: <T extends Record<string, string>>(m: T) => Record<keyof T, string> };

const badge = (s: string) => renderToStaticMarkup(<parts.SheetStatusBadge status={s} />);
assert.ok(badge("Awaiting RM review").includes(">Awaiting RM review<"), "default text when nothing is configured");
assert.ok(badge("Ready for new markets").includes("Ready for new markets") && badge("Needs changes").includes("Needs changes") && badge("Older plan").includes("Older plan"));
const variantBefore = badge("Awaiting RM review").replace(/>[^<]*</, "><");
custom = { "party_planning.status.awaiting_rm": "Waiting for RM", "party_planning.common.open": "View" };
assert.ok(badge("Awaiting RM review").includes(">Waiting for RM<"), "saved custom status text is shown");
assert.equal(badge("Awaiting RM review").replace(/>[^<]*</, "><"), variantBefore, "status styling unchanged by a custom label");
assert.ok(renderToStaticMarkup(<parts.OpenButton href="/x" />).includes(">View<"));
custom = {};
assert.ok(renderToStaticMarkup(<parts.OpenButton href="/x" />).includes(">Open<"));

const navHtml = (stage = "create") => renderToStaticMarkup(<nav.PartyPlanModeLinks mode="seasonal" stage={stage} />);
let html = navHtml();
for (const t of ["Plan Type", "Create", "Submitted", "Approved", "Older Plans", "Seasonal", "Monthly", "Planning", "View"]) assert.ok(html.includes(`>${t}<`), `default nav text: ${t}`);
assert.ok(html.includes('aria-label="Plan lifecycle"'));
custom = { "party_planning.nav.plan_type": "Plan Kind", "party_planning.stage.older": "Archive", "party_planning.nav.plan_lifecycle_aria": "Lifecycle", "party_planning.nav.seasonal_tab": "Season Wise" };
html = navHtml();
assert.ok(html.includes(">Plan Kind<") && html.includes(">Archive<") && html.includes('aria-label="Lifecycle"') && html.includes(">Season Wise<") && !html.includes(">Older Plans<"), "custom navigation labels (incl. aria) replace the defaults");
assert.ok(html.includes("?stage=older"), "routes are unchanged by labels");
custom = {};

// 4. Interpolation: placeholders are filled with runtime values; an edited label that drops one still works; unknown placeholders are left as typed.
assert.equal(helpers.fill(DEFAULT_LABELS["party_planning.common.rejected_by"], { stage: "Admin", reason: "No docs" }), "Rejected by Admin: No docs");
assert.equal(helpers.fill("Turned down — {reason}", { stage: "Admin", reason: "No docs" }), "Turned down — No docs");
assert.equal(helpers.fill("{a} and {b}", { a: 1 }), "1 and {b}");
assert.equal(helpers.fill(DEFAULT_LABELS["party_planning.territory.msg.mapped_counts"], { mapped: 3, unmapped: 0 }), "3 mapped · 0 unmapped", "zero counts are kept");
assert.equal(renderToStaticMarkup(<>{helpers.fillNodes(DEFAULT_LABELS["party_planning.monthly.msg.confirm_change"], { market: <b>Pune</b>, from: <b>Approved</b>, to: <b>Doc Send By SO</b> })}</>),
  "Change the status of <b>Pune</b> from <b>Approved</b> to <b>Doc Send By SO</b>?");
assert.equal(helpers.fill(DEFAULT_LABELS["party_planning.monthly.aria.date_changes"], { count: 2 }), "Changed 2 time(s) by the Sales Officer — view history");

// 5. Audit: no hard-coded user-facing JSX text, placeholder, title or aria-label is left in the Party Planning pages (technical Excel column names are the one exception).
for (const f of pages) {
  const lines = readFileSync(`${dir}/${f}.tsx`, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/api\.|queryKey|queryFn|fillNodes\(T\.fileLabel/.test(l));
  for (const l of lines) {
    assert.ok(!/(?<![=-])>\s*[A-Za-z][A-Za-z0-9 ,.'’\/\-—:·&?!…*]*<\//.test(l), `${f}: hard-coded text → ${l.trim().slice(0, 100)}`);
    assert.ok(!/(placeholder|title|aria-label|emptyText|subtitle)="[A-Za-z]/.test(l), `${f}: hard-coded attribute → ${l.trim().slice(0, 100)}`);
  }
}
assert.ok(readdirSync(dir).includes("party-labels.tsx"));
console.log("party-labels.test.tsx — all assertions passed");
