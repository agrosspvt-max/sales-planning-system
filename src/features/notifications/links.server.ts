import "server-only";
import { prisma } from "@/lib/prisma";

/** Server-resolved links for the feed, decided from the entity the alert points to (so a rescheduled task's link follows its current date). */
export async function resolveNotificationLinks(items: { id: string; relatedEntityType: string | null; relatedEntityId: string | null }[]): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const ids = (type: string) => [...new Set(items.filter((i) => i.relatedEntityType === type && i.relatedEntityId).map((i) => i.relatedEntityId!))];
  const day = (d: Date | null | undefined) => (d ? `/planning/calendar?date=${d.toISOString().slice(0, 10)}` : null);
  const byEntity = new Map<string, string>();
  const [tasks, events, entries] = await Promise.all([
    ids("BillingExceptionTask").length ? prisma.billingExceptionTask.findMany({ where: { id: { in: ids("BillingExceptionTask") } }, select: { id: true, taskDate: true } }) : [],
    ids("CnPaymentEvent").length ? prisma.cnPaymentEvent.findMany({ where: { id: { in: ids("CnPaymentEvent") } }, select: { id: true, taskDate: true } }) : [],
    ids("CalendarEntry").length ? prisma.calendarEntry.findMany({ where: { id: { in: ids("CalendarEntry") } }, select: { id: true, date: true } }) : [],
  ]);
  for (const t of tasks) { const h = day(t.taskDate); if (h) byEntity.set(`BillingExceptionTask:${t.id}`, h); }
  for (const t of events) { const h = day(t.taskDate); if (h) byEntity.set(`CnPaymentEvent:${t.id}`, h); }
  for (const t of entries) { const h = day(t.date); if (h) byEntity.set(`CalendarEntry:${t.id}`, h); }
  for (const i of items) {
    if (!i.relatedEntityType || !i.relatedEntityId) continue;
    if (i.relatedEntityType === "BillingException") links.set(i.id, `/reports/last-payment?exception=${encodeURIComponent(i.relatedEntityId)}`);
    else { const h = byEntity.get(`${i.relatedEntityType}:${i.relatedEntityId}`); if (h) links.set(i.id, h); }
  }
  return links;
}
