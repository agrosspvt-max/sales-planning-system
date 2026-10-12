/** PageHeader: pinned (sticky glass) by default; `pinned={false}` lets a page scroll its header away. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";

const stub = () => null;
const { PageHeader } = testLoader({
  "next/navigation": { usePathname: () => "/planning/territory-mapping", useSearchParams: () => new URLSearchParams() },
  "./breadcrumbs": { Breadcrumbs: stub }, "./back-button": { BackButton: stub }, "./crumb-trail": { CrumbTrail: stub, buildProfileCrumbs: () => [] },
  "@/features/navigation/route-parents": { routeParent: () => null },
  "@/features/navigation/profile-context": { readProfileOrigin: () => null, profileKindLabel: () => "" },
})("src/components/layout/page-header.tsx") as { PageHeader: React.ComponentType<{ title: string; pinned?: boolean }> };

const render = (pinned?: boolean) => renderToStaticMarkup(<PageHeader title="Territory Mapping" pinned={pinned} />);
const classOf = (html: string) => /<div class="([^"]*)"/.exec(html)![1]!;
for (const html of [render(), render(true)]) {
  const c = classOf(html);
  assert.ok(c.includes("sticky") && c.includes("top-0") && c.includes("z-20") && c.includes("backdrop-blur"), "default: pinned exactly as before");
}
const c = classOf(render(false));
assert.ok(!/\b(sticky|top-0|z-20|backdrop-blur)\b/.test(c), "pinned={false}: not sticky, no glass blur");
assert.ok(c.includes("border-b") && c.includes("bg-muted/20") && c.includes("px-4"), "pinned={false}: same look, it just scrolls with the page");
console.log("page-header.test.tsx — all assertions passed");
