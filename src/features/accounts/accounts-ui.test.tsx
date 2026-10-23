/** Account Management may create and edit accounts without a designation. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
const accounts = [{ id: "acc", name: "Pooja", username: "pooja", designation: "Accounts Officer", isActive: true, permissions: { cnRequests: ["read"] } }];
let buttons: Array<{ children?: React.ReactNode; type?: string; disabled?: boolean; onClick?: () => void }> = [];
let inputs: Record<string, { value: string; required?: boolean; onChange: (e: { target: { value: string } }) => void }> = {};
let form: { onSubmit: (e: { preventDefault: () => void }) => void };
const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
const wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (value: unknown) => { hooks[i] = typeof value === "function" ? (value as (p: unknown) => unknown)(hooks[i]) : value; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/lib/api-client": { api: {
    get: async () => accounts,
    post: async (url: string, body: Record<string, unknown>) => { writes.push({ method: "POST", url, body }); },
    patch: async (url: string, body: Record<string, unknown>) => { writes.push({ method: "PATCH", url, body }); },
  } },
  "@tanstack/react-query": {
    useQuery: () => ({ data: accounts, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries() {} }),
    useMutation: (o: { mutationFn: () => unknown }) => ({ mutate: () => { void o.mutationFn(); }, isPending: false }),
  },
  "@/components/layout/page-header": { PageHeader: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> },
  "@/components/ui/dialog": { Dialog: wrap, DialogHeader: wrap, DialogTitle: wrap, DialogFooter: wrap, DialogContent: ({ children }: { children: React.ReactNode }) => {
    const node = React.Children.toArray(children).find(child => React.isValidElement(child) && child.type === "form") as React.ReactElement<typeof form>;
    if (node) form = node.props;
    return <div>{children}</div>;
  } },
  "@/components/ui/button": { Button: (p: (typeof buttons)[number]) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: { id: string; value: string; required?: boolean; onChange: (e: { target: { value: string } }) => void }) => { inputs[p.id] = p; return <input id={p.id} value={p.value} required={p.required} readOnly />; } },
});
const { AccountsPage } = load<typeof import("./accounts-page")>("src/features/accounts/accounts-page.tsx");
const render = () => { cursor = 0; buttons = []; inputs = {}; return renderToStaticMarkup(<AccountsPage />); };
const click = (text: string) => buttons.find(b => renderToStaticMarkup(<>{b.children}</>).includes(text))!.onClick!();
const fill = (id: string, value: string) => { inputs[id]!.onChange({ target: { value } }); render(); };
render(); click("Create Account"); const html = render();
assert.ok(html.includes("Designation (optional)"));
assert.equal(inputs["admin-designation"]!.required, undefined);
fill("admin-name", "Amit"); fill("admin-login", "amit"); fill("admin-password", "local-test-password");
assert.equal(buttons.find(b => b.type === "submit")!.disabled, false, "blank designation does not disable Save");
form!.onSubmit({ preventDefault() {} });
assert.equal(writes[0]!.method, "POST");
assert.equal(writes[0]!.body.designation, "");
assert.equal(JSON.stringify(writes[0]!.body.permissions), "{}");
// Clearing an existing designation does not alter permissions or request a password reset.
hooks.length = 0; render(); click("View / Edit"); render();
fill("admin-designation", "");
assert.equal(buttons.find(b => b.type === "submit")!.disabled, false);
form!.onSubmit({ preventDefault() {} });
assert.equal(writes[1]!.method, "PATCH");
assert.equal(writes[1]!.body.designation, "");
assert.equal(JSON.stringify(writes[1]!.body.permissions), JSON.stringify(accounts[0]!.permissions));
assert.equal("password" in writes[1]!.body, false);
console.log("Account Management optional designation create/edit UI passed");
