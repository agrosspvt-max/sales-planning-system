/** Daily Work Review dialog: Rescheduled tag + count circle + dates on the relevant task (no standalone Rescheduling Activity section). Static render, no database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const edited: Record<string, string> = {};
const L = DEFAULT_LABELS as Record<string, string>;
const m = testLoader({
  "@/features/labels/label-ui": { useLabel: (k: string) => edited[k] ?? L[k] ?? k },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</> },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody> },
  "@tanstack/react-query": { useQuery: () => ({ data: undefined, isLoading: false }), useQueryClient: () => ({}), useMutation: () => ({ isPending: false, mutate: () => undefined }) },
  "@/lib/api-client": { api: {} },
})("src/features/daily-work/team-performance-page.tsx") as Record<string, React.ComponentType<Record<string, unknown>>>;
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const move = (o: Record<string, unknown> = {}) => ({ key: "CALENDAR_ENTRY:t1", sourceType: "CALENDAR_ENTRY", from: null, to: null, count: 1, recordedOnly: false, dealerName: "Alpha", marketName: null, description: "Collect", section: "RECOVERY", ...o });
const rows = [{ entryId: "e1", dealerId: "d1", dealerName: "Alpha", todaysPlan: 1000, todaysActual: 0 }, { entryId: "e2", dealerId: "d2", dealerName: "Beta", todaysPlan: 500, todaysActual: 500 }];
const section = (moves: Record<string, unknown[]>) => renderToStaticMarkup(<m.DealerSection title="Recovery" rows={rows} recovery calendarEntryIds={["e1"]} moves={moves} />);

// Incoming, outgoing, and both; the task-type label stays; a never-moved row has no tag; totals columns are untouched.
let html = section({ e1: [move({ from: "2026-10-22", to: "2026-10-24", count: 2 })] });
assert.ok(html.includes("Rescheduled from 22/10/2026") && html.includes("Rescheduled to 24/10/2026"), "both facts are shown when it arrived and moved on");
assert.ok(/data-testid="review-reschedule-count"[^>]*>2</.test(html) && html.includes('aria-label="Rescheduled 2 times.'), "compact circular count with an accessible label");
assert.ok(html.includes(">Calendar<") || html.includes(L["daily_work.task_type.calendar"]!), "the Calendar task-type label is retained");
assert.equal((html.match(/review-rescheduled-tag/g) ?? []).length, 1, "only the moved task is tagged");
assert.ok(html.includes("1,000") || html.includes("1000"), "planned amounts are rendered as before");
html = section({ e1: [move({ to: "2026-10-24" })] });
assert.ok(html.includes("Rescheduled to 24/10/2026") && !html.includes("Rescheduled from"), "outgoing only");
html = section({ e1: [move({ from: "2026-10-23" })] });
assert.ok(html.includes("Rescheduled from 23/10/2026") && !html.includes("Rescheduled to"), "incoming only");
html = section({ e1: [move({ count: 1, recordedOnly: true })] });
assert.ok(html.includes(L["daily_work.review.resched.recorded_only"]!) && html.includes('aria-label="Rescheduled 1 time.'), "incomplete history is labelled and singular wording is used");
assert.ok(!section({}).includes("review-move"), "no moves → no tag");

// The standalone Rescheduling Activity section is gone from the whole dialog, while the per-task tag, count, dates and clickable timeline remain.
{
  const reviewData = {
    officerId: "so1", officerName: "Asha", officerRole: "SALES_OFFICER", workDate: "2026-10-23",
    sales: { dealers: [], autoTaskEntryIds: [], calendarEntryIds: [] }, recovery: { dealers: rows, autoTaskEntryIds: [], calendarEntryIds: ["e1"] },
    appointment: { rows: [] }, conversion: { rows: [] }, summary: { batches: [], dealerVisits: 0, newPartyVisits: 0, others: "", visitsEntered: false }, selfRating: 7, review: null, reportSubmitted: true,
    rescheduling: {
      rows: { e1: [move({ from: "2026-10-22", to: "2026-10-24", count: 2 })] }, tasks: [move({ key: "CALENDAR_ENTRY:t9", from: "2026-10-22" })],
      actions: [{ id: "a1", key: "CALENDAR_ENTRY:t1", sourceType: "CALENDAR_ENTRY", section: "RECOVERY", dealerName: "Alpha", marketName: null, description: "Collect", previousDate: "2026-10-22", newDate: "2026-10-23", createdAt: "2026-10-22T04:30:00.000Z", actorName: "Asha Rao", reason: "Dealer travelling", count: 2, recordedOnly: false }],
    },
  };
  const dialog = (data: unknown) => {
    const d = testLoader({
      "@/features/labels/label-ui": { useLabel: (k: string) => L[k] ?? k },
      "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</> },
      "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody> },
      "@tanstack/react-query": { useQuery: () => ({ data, isLoading: false, error: null }), useQueryClient: () => ({}), useMutation: () => ({ isPending: false, mutate: () => undefined }) },
      "@/lib/api-client": { api: {} },
      "@/components/ui/dialog": { Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
      "./review-task-history": { ReviewTaskHistoryDrawer: () => <aside data-testid="history-drawer" /> },
    })("src/features/daily-work/team-performance-page.tsx") as Record<string, React.ComponentType<Record<string, unknown>>>;
    return renderToStaticMarkup(<d.DailyWorkReviewDialog officerId="so1" workDate="2026-10-23" onClose={() => undefined} />);
  };
  html = dialog(reviewData);
  const t = text(html);
  assert.ok(!html.includes("rescheduling-activity") && !html.includes("rescheduled-history-tasks") && !html.includes("data-reschedule-action") && !html.includes("data-history-task"), "no activity section, history-only block or action rows");
  for (const key of ["title", "activity_hint", "activity_empty", "tasks_title", "tasks_hint"]) assert.ok(!t.includes(L[`daily_work.review.resched.${key}`]!), `no leftover text: ${key}`);
  assert.ok(!t.includes("Dealer travelling") && !t.includes("Asha Rao"), "the action list's people and reasons are not shown");
  assert.ok(html.includes("review-rescheduled-tag") && html.includes("Rescheduled from 22/10/2026") && html.includes("Rescheduled to 24/10/2026") && /data-testid="review-reschedule-count"[^>]*>2</.test(html), "the task's tag, count and dates remain");
  assert.ok(/<button[^>]*aria-haspopup="dialog"/.test(html), "the Rescheduled tag still opens the task timeline");
  assert.equal((html.match(/data-dealer-id=/g) ?? []).length, 2, "no task rows were added to compensate");
  assert.ok(t.includes("Self Rating") || t.includes(L["daily_work.review.self_rating"]!), "the rest of the review is intact");
  // Closing the timeline sidebar only clears the selection; it never calls the dialog's own onClose.
  const src = readFileSync("src/features/daily-work/team-performance-page.tsx", "utf8");
  assert.ok(src.includes("<ReviewTaskHistoryDrawer selection={history} onClose={() => setHistory(null)} />"), "the sidebar closes by clearing its own selection only");
  assert.ok(!src.includes("ReschedulingSection"), "the removed component is not left behind");
}

// Wording is editable and the stored source codes are not.
edited["daily_work.review.resched.to"] = "Moved on to {date}";
assert.ok(section({ e1: [move({ to: "2026-10-24" })] }).includes("Moved on to 24/10/2026"));
console.log("review-rescheduling-ui.test.tsx — all assertions passed");
