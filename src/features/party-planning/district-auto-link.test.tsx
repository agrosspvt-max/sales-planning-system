import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";

let allowed = true;
let failed = false;
let linked = 2;
let requests = 0;
let refreshes = 0;
const started = { current: false };
let effect: (() => void) | null = null;
const load = testLoader({
  react: { ...React, useRef: () => started, useEffect: (fn: () => void) => { effect = fn; } },
  "@/features/accounts/permission-ui": { useAdminPermission: () => allowed },
  "@/features/labels/label-ui": { useLabel: () => "Refresh to retry automatic matching, or save manually." },
  "@/lib/api-client": { api: { post: async (url: string) => { assert.equal(url, "/api/territory-mapping/districts/auto-link"); requests++; return { linked }; } } },
  "@tanstack/react-query": {
    useQueryClient: () => ({ invalidateQueries: ({ queryKey }: { queryKey: string[] }) => { assert.equal(queryKey[0], "territory-dealers"); refreshes++; } }),
    useMutation: ({ mutationFn, onSuccess }: { mutationFn: () => Promise<{ linked: number }>; onSuccess: (r: { linked: number }) => void }) => ({ mutate: () => { void mutationFn().then(onSuccess); }, isError: failed }),
  },
});
const { AutoLinkDistricts } = load<typeof import("./district-auto-link")>("src/features/party-planning/district-auto-link.tsx");
let ready = false;
const draw = () => renderToStaticMarkup(<AutoLinkDistricts ready={ready} />);
async function main() {
  draw(); effect!(); assert.equal(requests, 0, "wait for the initial list so the refresh cannot race the first read");
  ready = true;
  assert.equal(draw(), ""); effect!(); await new Promise(r => setTimeout(r, 0));
  assert.equal(requests, 1); assert.equal(refreshes, 1, "successful links refresh displayed district choices");
  draw(); effect!(); assert.equal(requests, 1, "rerenders and repeated effects do not post again");
  started.current = false; allowed = false; draw(); effect!(); assert.equal(requests, 1, "read-only users never trigger writes");
  allowed = true; linked = 0; draw(); effect!(); await new Promise(r => setTimeout(r, 0)); assert.equal(refreshes, 1, "unchanged mappings don't trigger refresh loops");
  failed = true; assert(draw().includes("save manually"), "failed matching leaves manual correction available");
  console.log("district-auto-link.test.tsx — automatic request, refresh, duplicate suppression and permission/error behavior passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
