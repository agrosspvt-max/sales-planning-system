/** Territory Mapping → Existing Markets → Market popup: compact cell, one popup (edit → confirm → history), stale-value guard, in-popup failures, no request on dismiss. */
import assert from "node:assert/strict";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
const posts: { url: string; body: unknown }[] = [];
const invalidated: string[] = [];
let failNext: string | null = null;
let pending = false;
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let input: { value?: string; onChange?: (e: { target: { value: string } }) => void; onKeyDown?: (e: { key: string; preventDefault: () => void }) => void } = {};
let dialogs: { onOpenChange: (o: boolean) => void }[] = [];
const pageErrors: (string | null)[] = [];
// Capture the click handlers of the cell's raw <button> triggers (the name and the Edited tag) so they can be clicked like a user would.
const triggers: Record<string, () => void> = {};
const tapJsx = (fn: typeof jsxRuntime.jsx) => ((type: unknown, props: Record<string, unknown>, key?: string) => { if (type === "button" && typeof props.onClick === "function") { if (props["aria-label"]) triggers.name = props.onClick as () => void; else if (props.children === "Edited") triggers.edited = props.onClick as () => void; } return fn(type as never, props as never, key); }) as typeof jsxRuntime.jsx;

const overrides = {
  "react/jsx-runtime": { ...jsxRuntime, jsx: tapJsx(jsxRuntime.jsx), jsxs: tapJsx(jsxRuntime.jsxs as typeof jsxRuntime.jsx) },
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: string }) => <>{k}</>, useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/layout/page-header": { PageHeader: () => null },
  "./dealer-status-requests": { StatusRequestCell: () => null, StatusRequestsTab: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: () => ({ data: { dealerName: "ABC Traders", edits: [{ id: "e1", previousMarket: null, newMarket: "Old", editedByName: "Officer One", editedAt: "2026-10-08T10:00:00.000Z" }] }, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: (o: { queryKey: unknown[] }) => { invalidated.push(JSON.stringify(o.queryKey)); } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: pending, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => ({}), post: async (url: string, body: unknown) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: (typeof buttons)[number]) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: typeof input) => { input = p; return <input defaultValue={p.value} />; } },
  "@/components/ui/label": { Label: ({ children }: { children?: React.ReactNode }) => <label>{children}</label> },
  "@/components/ui/skeleton": { Skeleton: () => null },
  "@/components/ui/dialog": {
    Dialog: (p: { onOpenChange: (o: boolean) => void; children: React.ReactNode }) => { dialogs.push(p); return <div data-dialog>{p.children}</div>; },
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { MarketCell } = testLoader(overrides)("src/features/party-planning/territory-mapping-page.tsx") as { MarketCell: React.ComponentType<{ row: Record<string, unknown>; label: string; onError: (m: string | null) => void }> };
const row = (o: Record<string, unknown> = {}) => ({ dealerId: "d1", partyName: "ABC Traders", status: "ACTIVE", marketId: null, marketName: "Old", marketEdited: false, potential: null, ...o });
let props = row();
const render = () => { cursor = 0; buttons = []; dialogs = []; const html = renderToStaticMarkup(<MarketCell row={props} label="Market" onError={(m) => pageErrors.push(m)} />); hooks.length = cursor; return html; };
const btn = (label: string) => buttons.filter((b) => String(b.children) === label).at(-1)!;
const tick = () => new Promise((r) => setTimeout(r, 0));
// MarketCell's state order: open, step, draft, expected, error
const seed = (s: { open?: boolean; step?: string; draft?: string; expected?: string | null; error?: string | null }) => { hooks.length = 0; hooks[0] = s.open ?? true; hooks[1] = s.step ?? "edit"; hooks[2] = s.draft ?? "Old"; hooks[3] = s.expected === undefined ? "Old" : s.expected; hooks[4] = s.error ?? null; };

async function main() {
  // 1. The cell: the saved name (or a dash) plus the compact Edited tag once an edit is on record — and no input or edit controls.
  hooks.length = 0; hooks[0] = false; props = row({ marketEdited: false }); let html = render();
  assert.equal(html.replace(/<[^>]+>/g, ""), "Old", "never edited: just the Market name, no tag");
  props = row({ marketEdited: true }); hooks.length = 0; hooks[0] = false; html = render();
  assert.equal(html.replace(/<[^>]+>/g, ""), "OldEdited", "edited: name + Edited tag");
  assert.ok(html.includes("flex-wrap"), "the tag sits beside the name and wraps on small screens");
  assert.ok(!html.includes("<input") && !html.includes("Save") && !html.includes("Cancel") && !html.includes("data-dialog"), "no input, Save or Cancel in the row");
  assert.ok(html.includes('aria-label="Edit Market"'), "keyboard-accessible name button");
  props = row({ marketName: null }); hooks.length = 0; hooks[0] = false; html = render();
  assert.ok(html.includes("<button") && html.replace(/<[^>]+>/g, "") === "—", "an empty Market is a clickable dash");
  // The tag opens the history; the name opens the editing popup; neither saves anything. Both capture the Market the user saw.
  props = row({ marketEdited: true }); hooks.length = 0; hooks[0] = false; render();
  triggers.edited!(); html = render();
  assert.deepEqual([hooks[0], hooks[1], hooks[3]], [true, "history", "Old"], "Edited tag → popup on the history step (expected Market captured)");
  assert.ok(html.includes("Market Edit History") && html.includes("Officer One") && dialogs.length === 1, "that party's history is shown");
  assert.equal(posts.length, 0, "opening the history saves nothing");
  hooks[0] = false; hooks[1] = "edit"; render(); triggers.name!(); html = render();
  assert.deepEqual([hooks[0], hooks[1], hooks[2]], [true, "edit", "Old"], "clicking the name still opens the compact editing popup, prefilled");
  assert.equal(posts.length, 0);
  // An unedited record never gets a tag from opening, typing or cancelling (the tag comes only from persisted history, i.e. the server's marketEdited).
  props = row({ marketEdited: false }); hooks.length = 0; hooks[0] = false; render(); triggers.name!(); render(); input.onChange!({ target: { value: "Typed but never saved" } }); render();
  btn("Cancel").onClick!(); html = render();
  assert.ok(!html.includes("Edited") && posts.length === 0, "open + type + cancel: no tag, no request");

  // 2. Popup, edit step: title, party, prefilled input, Save/Cancel; Save needs a real change.
  props = row(); seed({}); html = render();
  assert.ok(html.includes("<h2>Edit Market</h2>") && html.includes("ABC Traders") && input.value === "Old", "title, party name for context, input prefilled with the current Market");
  assert.equal(btn("Save").disabled, true, "unchanged → Save disabled");
  for (const draft of ["", "   ", "  old  ", "OLD"]) { seed({ draft }); render(); assert.equal(btn("Save").disabled, true, `"${draft}" is not a change`); }
  seed({ draft: "New" }); render(); assert.equal(btn("Save").disabled, false, "a different value enables Save");
  assert.ok(!html.includes("View edit history"), "no history link when the Market was never edited");

  // 3. Save → confirmation step in the SAME popup; nothing sent yet.
  seed({ draft: "  New   Name " }); render(); btn("Save").onClick!(); html = render();
  assert.equal(hooks[1], "confirm"); assert.equal(dialogs.length, 1, "one dialog only");
  assert.ok(html.includes("Change Market for this dealer?") && html.includes("ABC Traders") && html.includes("Old") && html.includes("New Name"), "party, previous and (normalised) new Market");
  assert.equal(posts.length, 0, "no request before Confirm");

  // 4. Confirm → one POST with the Market captured at open; success closes and refreshes.
  props = row({ marketName: "Changed In Background" }); // a refresh changed the row while the popup was open
  render(); // the popup re-renders with the refreshed row
  btn("Confirm Change").onClick!(); await tick(); render();
  assert.equal(JSON.stringify(posts), JSON.stringify([{ url: "/api/territory-mapping/dealers/d1/market", body: { expectedMarket: "Old", market: "  New   Name " } }]), "expectedMarket is the value captured when the popup opened");
  assert.equal(hooks[0], false, "closed on success");
  assert.ok(invalidated.includes('["territory-dealers"]') && invalidated.includes('["territory-market-history","d1"]'), "table and history refreshed");
  assert.equal(pageErrors.at(-1), null);

  // 5. A failure (e.g. stale-value conflict) stays INSIDE the popup; the draft is kept; the table refreshes.
  posts.length = 0; invalidated.length = 0; props = row(); seed({ draft: "Mine", step: "confirm" }); render();
  failNext = "This dealer's Market was changed by someone else. Reload and try again."; btn("Confirm Change").onClick!(); await tick(); html = render();
  assert.deepEqual([hooks[0], hooks[1], hooks[2]], [true, "edit", "Mine"], "still open, back on the edit step, draft kept");
  assert.ok(html.includes("changed by someone else") && html.includes('role="alert"'), "message shown in the popup");
  assert.equal(posts.length, 0, "nothing was saved"); assert.ok(invalidated.includes('["territory-dealers"]'), "the table refreshes in the background");
  assert.ok(!pageErrors.some((m) => m && m.includes("someone else")), "not shown as a page-level error");
  props = row({ marketEdited: false }); html = render(); hooks[0] = false; html = render();
  assert.ok(!html.includes("Edited"), "a failed save does not create a tag");
  input.onChange!({ target: { value: "Mine 2" } }); render(); assert.equal(hooks[4], null, "typing clears the message");

  // 6. Cancel, Escape / overlay / ✕ discard without a request.
  seed({ draft: "Something" }); render(); btn("Cancel").onClick!(); render();
  assert.deepEqual([hooks[0], posts.length], [false, 0], "Cancel closes, no request");
  seed({ draft: "Something" }); render(); dialogs[0]!.onOpenChange(false); render();
  assert.deepEqual([hooks[0], posts.length], [false, 0], "Escape / dismiss closes, no request");
  seed({ draft: "Something", step: "confirm" }); render(); dialogs[0]!.onOpenChange(false); render();
  assert.deepEqual([hooks[0], posts.length], [false, 0], "dismissing from the confirmation discards too");

  // 7. Enter in the input behaves like Save; an unchanged value does not advance.
  seed({ draft: "Old" }); render(); input.onKeyDown!({ key: "Enter", preventDefault: () => undefined }); render(); assert.equal(hooks[1], "edit", "unchanged + Enter: stays");
  seed({ draft: "Different" }); render(); input.onKeyDown!({ key: "Enter", preventDefault: () => undefined }); render(); assert.equal(hooks[1], "confirm", "changed + Enter: confirmation");

  // 8. While a save is pending: no dismissal, no second save.
  pending = true; seed({ draft: "Different", step: "confirm" }); html = render();
  assert.equal(btn("Back").disabled, true); assert.ok(html.includes("Saving…"));
  assert.equal(btn("Saving…").disabled, true, "Confirm is disabled while saving");
  dialogs[0]!.onOpenChange(false); render(); assert.equal(hooks[0], true, "cannot be dismissed while saving");
  seed({ draft: "Different" }); render(); assert.equal(btn("Cancel").disabled, true); assert.equal(btn("Save").disabled, true); pending = false;

  // 9. History: a step of the same popup, only for edited Markets; Back returns to editing.
  props = row({ marketEdited: true }); seed({}); html = render(); assert.ok(html.includes("View edit history"), "history link inside the popup");
  seed({ step: "history" }); html = render();
  assert.ok(html.includes("Market Edit History") && html.includes("Officer One") && dialogs.length === 1, "history shown in the same popup");
  btn("Back").onClick!(); render(); assert.equal(hooks[1], "edit");
  console.log("market-edit-popup-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
