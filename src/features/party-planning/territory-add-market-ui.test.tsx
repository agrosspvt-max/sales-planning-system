/** Territory Mapping → Add Market: the request form lives in a modal opened by "+ Add Market" under the requests table. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
let invalidations = 0;
const posts: { url: string; body: unknown }[] = [];
let failNext: string | null = null;
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let inputs: { type?: string; value?: string; onChange?: (e: { target: { value: string } }) => void }[] = [];
let selects: { options: { value: string; label: string }[]; onChange?: (e: { target: { value: string } }) => void }[] = [];
let requests: unknown[] = [];

const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: string }) => <>{k}</>, useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: () => ({ data: requests, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async (url: string, body: unknown) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: (typeof inputs)[number]) => { inputs.push(p); return <input type={p.type} defaultValue={p.value} />; } },
  "@/components/ui/select": { NativeSelect: (p: (typeof selects)[number]) => { selects.push(p); return <select />; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { AddMarket } = testLoader(overrides)("src/features/party-planning/territory-mapping-page.tsx") as { AddMarket: React.ComponentType<{ role: Role }> };
const render = (role: Role = Role.SALES_OFFICER) => { cursor = 0; buttons = []; inputs = []; selects = []; const html = renderToStaticMarkup(<AddMarket role={role} />); hooks.length = cursor; return html; };
const btn = (label: string) => buttons.filter((b) => String(b.children).includes(label)).at(-1)!;
const count = (label: string) => buttons.filter((b) => String(b.children).includes(label)).length;
const tick = () => new Promise((r) => setTimeout(r, 0));
const REQ = (id: string) => ({ id, marketName: `Market ${id}`, potential: "A", numberOfParties: 3, status: "PENDING_RM", requesterName: "Officer One", createdAt: "2026-10-08T00:00:00.000Z", rmDecidedByName: null, rmDecidedAt: null, adminDecidedByName: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null });

async function main() {
  // zero requests: no always-visible form, the button sits directly under the (empty) table
  requests = [];
  let html = render();
  assert.ok(!html.includes("data-dialog") && !html.includes("Send Request") && !html.includes('type="number"'), "the request form is hidden until + Add Market is clicked");
  assert.ok(html.includes("No requests here.") && /<\/table><\/div><div class="border-t p-2"><button>\+ Add Market<\/button><\/div>/.test(html), "button directly below the empty table");
  // multiple requests: same position, below the rows
  requests = [REQ("1"), REQ("2"), REQ("3")]; html = render();
  assert.ok(/<\/table><\/div><div class="border-t p-2"><button>\+ Add Market<\/button><\/div>/.test(html) && html.lastIndexOf("Market 3") < html.lastIndexOf("+ Add Market"), "below the last row, so it moves down as the table grows");
  for (const col of ["Market Name", "Market Potential", "No. of Parties", "Requested by", "Date", "Status", "Decision"]) assert.ok(html.includes(`>${col}</th>`), `column ${col}`);
  assert.ok(html.includes("To review") === false && html.includes("My requests") && html.includes("History"), "SO: My requests + History tabs");
  // permissions unchanged: SO + RM can request; Admin cannot
  assert.equal(count("+ Add Market"), 1);
  render(Role.REGIONAL_MANAGER); assert.equal(count("+ Add Market"), 1); assert.ok(render(Role.REGIONAL_MANAGER).includes("To review"));
  render(Role.SUPER_ADMIN); assert.equal(count("+ Add Market"), 0, "Admin does not raise requests");
  // open the modal
  hooks.length = 0; render(); btn("+ Add Market").onClick!(); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("Market Name *") && html.includes("Market Potential *") && html.includes("No. of Parties *") && count("Send Request") === 1 && count("Cancel") === 1, "compact modal: the three fields, Send Request, Cancel");
  assert.equal(selects.at(-1)!.options.map((o) => o.value).join(","), "A,B,C");
  // validation keeps the modal open and sends nothing
  btn("Send Request").onClick!(); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("Market Name is required."), "existing validation message, modal stays open"); assert.equal(posts.length, 0);
  // Cancel creates nothing and clears state
  btn("Cancel").onClick!(); html = render();
  assert.ok(!html.includes("data-dialog") && posts.length === 0, "cancel: closed, no request");
  btn("+ Add Market").onClick!(); render();
  assert.ok(inputs.filter((i) => i.type !== "number")[0]!.value === "", "form state was cleared");
  // a backend failure keeps the modal open with the error
  const fill = () => { const text = inputs.filter((i) => i.type !== "number")[0]!; text.onChange!({ target: { value: "Pipariya" } }); render(); selects.at(-1)!.onChange!({ target: { value: "B" } }); render(); inputs.find((i) => i.type === "number")!.onChange!({ target: { value: "12" } }); render(); };
  fill(); failNext = "A Market with this name already exists"; btn("Send Request").onClick!(); await tick(); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("A Market with this name already exists"), "duplicate-market error shown inside the modal"); assert.equal(posts.length, 0);
  // success: POST the same request, close, clear, refresh
  btn("Send Request").onClick!(); await tick(); html = render();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/territory-mapping/market-requests", body: { marketName: "Pipariya", potential: "B", numberOfParties: "12" } }], "the existing request endpoint, unchanged payload");
  assert.ok(!html.includes("data-dialog") && html.includes("Request sent.") && invalidations >= 1, "closed, notice shown, lists refreshed");
  btn("+ Add Market").onClick!(); render(); assert.ok(inputs.filter((i) => i.type !== "number")[0]!.value === "", "reopening starts clean");
  console.log("territory-add-market-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
