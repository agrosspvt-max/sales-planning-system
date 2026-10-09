/** The shared Create Dealer form: Dealer Alias behaviour is unchanged; Party Planning reuses it with a prefill and its own submit target. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";

const hooks: unknown[] = [];
let cursor = 0;
const posts: { url: string; body: unknown }[] = [];
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let inputs: { value?: string; placeholder?: string }[] = [];
let selects: { value?: string }[] = [];
let closed = 0, created = 0;
const overrides = {
  react: { ...React,
    useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; },
    useEffect: (fn: () => void) => { if (!(`e${cursor}` in hooks)) { (hooks as unknown as Record<string, boolean>)[`e${cursor}`] = true; fn(); } }, // run once, like mount
  },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === "groups" ? [{ id: "g1", name: "Group 1" }] : [{ id: "so1", name: "Officer One" }] }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => [], patch: async () => ({}), del: async () => ({}), post: async (url: string, body: unknown) => { posts.push({ url, body }); return { dealerId: "d1" }; } } },
  "@/features/dealers/dealer-name-ui": { DealerName: () => null },
  "@/features/dealers/dealer-table-ui": { DealerOrder: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: { value?: string; placeholder?: string }) => { inputs.push(p); return <input defaultValue={p.value} />; } },
  "@/components/ui/select": { NativeSelect: (p: { value?: string }) => { selects.push(p); return <select />; } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
};
const { DealerDialog } = testLoader(overrides)("src/features/sales-upload/create-dealer-dialog.tsx") as { DealerDialog: React.ComponentType<Record<string, unknown>> };
const tick = () => new Promise((r) => setTimeout(r, 0));
const render = (props: Record<string, unknown> = {}) => { cursor = 0; buttons = []; inputs = []; selects = []; const html = renderToStaticMarkup(<DealerDialog open onOpenChange={() => { closed += 1; }} {...props} />); hooks.length = Math.max(0, cursor); return html; };
const reset = () => { for (const k of Object.keys(hooks)) delete (hooks as unknown as Record<string, unknown>)[k]; hooks.length = 0; posts.length = 0; closed = 0; created = 0; };
const btn = (label: string) => buttons.filter((b) => String(b.children).includes(label)).at(-1)!;

async function main() {
  // 1) Dealer Alias (no new props): empty form, POST /api/dealers, "Assign this dealer" available.
  reset(); render(); let html = render();
  assert.ok(html.includes("Create Dealer") && html.includes("Dealer Alias (Tally Name) *") && html.includes("Territory") && html.includes("Automatically add this dealer to the officer&#x27;s Active Seasonal Plan"), "same fields as before");
  assert.deepEqual(inputs.map((i) => i.value), ["", "", ""], "nothing prefilled by default");
  hooks[0] = "ABC"; hooks[1] = "ABC TALLY"; hooks[2] = "g1"; hooks[3] = "so1"; render();
  btn("Continue").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/dealers", body: { name: "ABC", aliasName: "ABC TALLY", officerId: "so1", groupId: "g1", addToSeasonalPlan: true } }], "unchanged request to the Dealers API");
  assert.equal(closed, 1);
  // 2) Party Planning reuse: prefilled, custom submit target, hook after success, no "assign existing"
  reset();
  const calls: unknown[] = [];
  const props = { prefill: { name: "Party A", aliasName: "Party A", groupId: "g1", officerId: "so1" }, submitCreate: async (b: unknown) => { calls.push(b); return { dealerId: "dX" }; }, onCreated: () => { created += 1; }, allowAssignExisting: false, title: "Create Dealer — Appointed" };
  render(props); html = render(props);
  assert.ok(html.includes("Create Dealer — Appointed"));
  assert.deepEqual(inputs.map((i) => i.value), ["Party A", "Party A", ""], "name + alias prefilled from the row");
  assert.deepEqual(selects.map((x) => x.value), ["g1", "so1"], "group + officer prefilled");
  btn("Continue").onClick!(); await tick();
  assert.equal(posts.length, 0, "does not call /api/dealers itself"); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { name: "Party A", aliasName: "Party A", officerId: "so1", groupId: "g1", addToSeasonalPlan: true });
  assert.deepEqual([created, closed], [1, 1], "onCreated, then the dialog closes");
  // 3) duplicates → warning phase, "Assign this dealer" only when allowed
  for (const allow of [true, false]) {
    reset();
    const dup = { ...props, allowAssignExisting: allow, submitCreate: async () => ({ duplicates: [{ id: "x", name: "Old Co", reason: "Same name", score: 1 }] }) };
    render(dup); render(dup); btn("Continue").onClick!(); await tick();
    html = render(dup);
    assert.ok(html.includes("Possible Existing Dealer") && html.includes("Create anyway"));
    assert.equal(html.includes("Assign this dealer"), allow, `assign shortcut ${allow ? "shown (Dealer Alias)" : "hidden (Party Planning)"}`);
    assert.equal(created, 0, "a duplicate warning is not a success");
  }
  // 4) a failure keeps the dialog open
  reset(); const failing = { ...props, submitCreate: async () => { throw new Error("An alias already exists"); } };
  render(failing); render(failing); btn("Continue").onClick!(); await tick(); html = render(failing);
  assert.ok(html.includes("An alias already exists") && Number(closed) === 0 && Number(created) === 0, "errors are shown and nothing completes");
  console.log("create-dealer-dialog.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
