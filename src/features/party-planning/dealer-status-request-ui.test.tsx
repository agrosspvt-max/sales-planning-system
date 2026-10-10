/** Territory Mapping UI for Dealer Status Change Requests: the SO/RM Status cell (reason → confirmation → submit) and the Admin Request tab. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
const calls: { method: string; url: string; body?: unknown }[] = [];
let failNext: string | null = null;
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; "aria-label"?: string }[] = [];
let selects: { options: { value: string; label: string }[]; value: string; onChange: (e: { target: { value: string } }) => void }[] = [];
let textareas: { onChange: (e: { target: { value: string } }) => void }[] = [];
let dealerDialogs: { open: boolean; edit: { id: string } | null; onOpenChange: (o: boolean) => void }[] = [];
let listData: unknown[] = [];

const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@tanstack/react-query": {
    useQuery: () => ({ data: listData, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async (url: string, body: unknown) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } calls.push({ method: "POST", url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: (typeof buttons)[number]) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/badge": { Badge: ({ children }: { children?: React.ReactNode }) => <span data-badge>{children}</span> },
  "@/components/ui/label": { Label: ({ children }: { children?: React.ReactNode }) => <label>{children}</label> },
  "@/components/ui/skeleton": { Skeleton: () => null },
  "@/components/ui/textarea": { Textarea: (p: (typeof textareas)[number]) => { textareas.push(p); return <textarea data-other-description />; } },
  "@/components/ui/select": { NativeSelect: (p: (typeof selects)[number]) => { selects.push(p); return <select />; } },
  "@/components/ui/table": { Table: (p: { children?: React.ReactNode }) => <table>{p.children}</table>, TableBody: (p: { children?: React.ReactNode }) => <tbody>{p.children}</tbody>, TableCell: (p: { children?: React.ReactNode }) => <td>{p.children}</td>, TableHead: (p: { children?: React.ReactNode }) => <th>{p.children}</th>, TableHeader: (p: { children?: React.ReactNode }) => <thead>{p.children}</thead>, TableRow: (p: { children?: React.ReactNode }) => <tr>{p.children}</tr> },
  "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div data-dialog>{children}</div> : null), DialogContent: (p: { children?: React.ReactNode }) => <>{p.children}</>, DialogHeader: (p: { children?: React.ReactNode }) => <>{p.children}</>, DialogTitle: (p: { children?: React.ReactNode }) => <h2>{p.children}</h2>, DialogFooter: (p: { children?: React.ReactNode }) => <>{p.children}</> },
  "@/features/sales-upload/create-dealer-dialog": { DealerDialog: (p: (typeof dealerDialogs)[number]) => { dealerDialogs.push(p); return null; } },
};
const mod = testLoader(overrides)("src/features/party-planning/dealer-status-requests.tsx") as { StatusRequestCell: React.ComponentType<Record<string, unknown>>; StatusRequestsTab: React.ComponentType };

const base = { dealerId: "d1", partyName: "ABC Traders", status: "ACTIVE", pending: null, canRequest: true };
let Comp: React.ComponentType<Record<string, unknown>> | React.ComponentType = mod.StatusRequestCell;
let props: Record<string, unknown> = base;
const render = () => { cursor = 0; buttons = []; selects = []; textareas = []; dealerDialogs = []; const html = renderToStaticMarkup(React.createElement(Comp as React.ComponentType<Record<string, unknown>>, props)); hooks.length = cursor; return html; };
const btn = (label: string) => buttons.find((b) => String(b.children) === label);
const tick = () => new Promise((r) => setTimeout(r, 0));
const pick = (value: string) => selects[0]!.onChange({ target: { value } });

async function main() {
  /* ---- SO / RM: status cell ---- */
  let html = render();
  assert.ok(html.includes("<button") && html.includes("Active") && !html.includes("data-dialog"), "the status badge is interactive for SO/RM and the dialog starts closed");
  props = { ...base, canRequest: false }; html = render();
  assert.ok(!html.includes("<button") && html.includes("Active"), "Admin / read-only users get the plain badge");
  props = { ...base, pending: { reason: "PARTY_CLOSED" } }; html = render();
  assert.ok(!html.includes("<button") && html.includes("Change requested"), "a dealer with an open request shows that state and cannot be requested again");

  // Open → choose a reason → Continue → confirmation that says it is only a request → Submit.
  hooks.length = 0; props = base; render();
  // `open` is the cell's first useState, so seed it to render the dialog.
  cursor = 0; hooks[0] = true; hooks.length = 1; // open = true (first useState in the cell is `open`)
  html = render();
  assert.ok(html.includes("data-dialog"), "dialog opens");
  assert.equal(selects[0]!.options.map((o) => o.label).join("|"), "Does Not Exist|Party Closed|Other", "the three reasons");
  assert.equal(btn("Continue")!.disabled, true, "Continue needs a reason");
  pick("OTHER"); html = render();
  assert.ok(html.includes("data-other-description"), "Other asks for a description");
  btn("Continue")!.onClick!(); html = render();
  assert.ok(html.includes("Describe the reason when you choose Other."), "Other without a description is refused client-side");
  assert.equal(calls.length, 0, "nothing sent yet");
  textareas[0]!.onChange({ target: { value: "Merged with another party" } }); render();
  btn("Continue")!.onClick!(); html = render();
  assert.ok(html.includes("Send this request to Admin?") && html.includes("does not change the dealer&#x27;s status") && html.includes("Merged with another party"), "confirmation explains it is only a request");
  assert.equal(calls.length, 0, "still nothing sent before confirming");
  btn("Submit request")!.onClick!(); await tick(); html = render();
  assert.equal(JSON.stringify(calls), JSON.stringify([{ method: "POST", url: "/api/territory-mapping/status-requests", body: { dealerId: "d1", reason: "OTHER", description: "Merged with another party" } }]), "one POST to the request endpoint, never a dealer update");
  assert.ok(!calls.some((c) => c.url.includes("/api/dealers")), "SO/RM never call a dealer-edit endpoint");
  assert.ok(html.includes("Request sent to Admin. The dealer&#x27;s status has not changed.") && !html.includes("data-dialog"), "success feedback, dialog closed");

  // Server refusal (e.g. already pending) is shown and nothing claims success.
  hooks.length = 0; props = base; cursor = 0; hooks[0] = true; hooks.length = 1; render();
  pick("PARTY_CLOSED"); render(); btn("Continue")!.onClick!(); render();
  failNext = "A status change request for this dealer is already pending."; btn("Submit request")!.onClick!(); await tick(); html = render();
  assert.ok(html.includes("A status change request for this dealer is already pending.") && !html.includes("Request sent to Admin"), "error feedback");

  /* ---- Admin: Request tab ---- */
  Comp = mod.StatusRequestsTab; props = {}; hooks.length = 0; calls.length = 0;
  const dto = { id: "r1", dealerId: "d1", partyName: "ABC Traders", statusAtRequest: "ACTIVE", currentStatus: "ACTIVE", reason: "PARTY_CLOSED", description: null, requestedById: "so1", requestedByName: "Officer One", requestedByRole: "SALES_OFFICER", createdAt: "2026-10-10T09:00:00.000Z", status: "PENDING", resolvedByName: null, resolvedAt: null, resolutionNotes: null, editDealer: { id: "d1" } };
  listData = [dto];
  html = render();
  for (const h of ["Party Name", "Current Status", "Requested Reason", "Description", "Requested By", "Request Date", "Request Status", "Action"]) assert.ok(html.includes(`<th>${h}</th>`), `column ${h}`);
  assert.ok(html.includes("ABC Traders") && html.includes("Party Closed") && html.includes("Officer One") && html.includes("Pending"), "row content");
  assert.ok(btn("Edit") && btn("Resolve"), "Edit and Resolve per pending request");
  assert.equal(dealerDialogs[0]!.open, false, "the dealer dialog is closed until Edit is pressed");

  // Edit opens the reused dialog with that dealer, and resolves nothing.
  btn("Edit")!.onClick!(); html = render();
  assert.equal(dealerDialogs[0]!.open, true); assert.equal(dealerDialogs[0]!.edit!.id, "d1");
  assert.equal(calls.length, 0, "opening the edit dialog calls no endpoint");
  dealerDialogs[0]!.onOpenChange(false); render();
  assert.equal(calls.length, 0, "cancelling / closing the edit dialog does not resolve");
  assert.equal(dealerDialogs[0]!.open, false);

  // Resolve is a separate, confirmed action.
  btn("Resolve")!.onClick!(); html = render();
  assert.ok(html.includes("Mark this request resolved?") && html.includes("it does not change the dealer"), "confirmation first");
  assert.equal(calls.length, 0, "nothing sent before confirming");
  btn("Mark resolved")!.onClick!(); await tick(); html = render();
  assert.equal(JSON.stringify(calls), JSON.stringify([{ method: "POST", url: "/api/territory-mapping/status-requests/r1/resolve", body: { notes: undefined } }]));
  assert.ok(html.includes("Request marked resolved."));

  // Resolved history rows have no Edit / Resolve.
  listData = [{ ...dto, status: "RESOLVED", resolvedByName: "Admin", resolvedAt: "2026-10-11T09:00:00.000Z", resolutionNotes: "Closed in master" }];
  hooks.length = 0; html = render();
  assert.ok(html.includes("Resolved by Admin") && html.includes("Closed in master") && !btn("Edit") && !btn("Resolve"), "history is read-only and keeps who/when/notes");
  listData = []; hooks.length = 0; html = render();
  assert.ok(html.includes("No status change requests here."), "empty state");
  console.log("dealer-status-request-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
