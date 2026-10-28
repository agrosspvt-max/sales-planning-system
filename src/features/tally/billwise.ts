import { createHash } from "node:crypto";
import { z } from "zod";

const day = z
  .string()
  .regex(/^20\d\d-\d\d-\d\d$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
  });
const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,11})\.\d{2}$/);
const name = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\x00-\x1f]/.test(v));
const guid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{8}$/i);
export const scopeAliasSchema = z
  .object({ name, dealerId: z.string().min(1).max(100), expectedGuid: guid.nullable() })
  .strict();
export type ScopeAlias = z.infer<typeof scopeAliasSchema>;
export const ledgerSchema = z.object({ name, guid, closingBalance: amount }).strict();
export const billSchema = z
  .object({ partyName: name, billDate: day, reference: name, pendingAmount: amount, dueDate: day })
  .strict();
export const resultSchema = z
  .object({
    version: z.literal("billwise.sync.v1"),
    companyName: name,
    asOf: day,
    observedAt: z.string().datetime({ offset: true }),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    anchor: ledgerSchema,
    ledgers: z.array(ledgerSchema).max(1000),
    unavailableNames: z.array(name).max(1000),
    bills: z.array(billSchema).max(30000),
  })
  .strict();
export type BillResult = z.infer<typeof resultSchema>;
export const tight = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export const cents = (s: string) => {
  if (!amount.safeParse(s).success) throw new Error("INVALID_AMOUNT");
  return BigInt(s.replace(".", ""));
};
export function decimal(n: bigint) {
  const v = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${v / 100n}.${String(v % 100n).padStart(2, "0")}`;
}
export function indiaDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function bucket(due: string, asOf: string): "OVERDUE" | "DUE" | "RUNNING" {
  if (due < asOf) return "OVERDUE";
  return due.slice(0, 7) === asOf.slice(0, 7) ? "DUE" : "RUNNING";
}
export function scopeHash(aliases: ScopeAlias[], planIds: string[]) {
  return digest(
    JSON.stringify({
      aliases: [...aliases].sort((a, b) => a.name.localeCompare(b.name)),
      planIds: [...planIds].sort(),
    }),
  );
}
export function resolveAliases(
  rows: { tallyName: string; systemDealerId: string }[],
  dealerIds: Set<string>,
  bindings: Map<string, string>,
) {
  const by = new Map<string, { name: string; dealerId: string; expectedGuid: string | null }>();
  const blocked = new Set<string>();
  for (const r of rows) {
    const k = tight(r.tallyName);
    if (!k) continue;
    const prev = by.get(k);
    if (prev && prev.dealerId !== r.systemDealerId) blocked.add(k);
    by.set(k, {
      name: r.tallyName,
      dealerId: r.systemDealerId,
      expectedGuid: bindings.get(k) ?? null,
    });
  }
  return [...by]
    .filter(([k, v]) => !blocked.has(k) && dealerIds.has(v.dealerId))
    .map(([, v]) => v)
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function validateResult(
  raw: unknown,
  scope: ScopeAlias[],
  companyName: string,
  anchorGuid: string,
  asOf: string,
  now = new Date(),
) {
  const r = resultSchema.parse(raw);
  if (r.companyName !== companyName || r.asOf !== asOf || asOf !== indiaDay(now))
    throw new Error("WRONG_REPORT_CONTEXT");
  const age = +now - Date.parse(r.observedAt);
  if (age < -60000 || age > 20 * 60 * 1000) throw new Error("STALE_REPORT");
  if (r.anchor.guid !== anchorGuid) throw new Error("COMPANY_ANCHOR_CHANGED");
  const prefix = anchorGuid.slice(0, 36).toLowerCase();
  const byKey = new Map(scope.map((a) => [tight(a.name), a]));
  if (byKey.size !== scope.length) throw new Error("AMBIGUOUS_SCOPE");
  const ledgers = new Map<string, (typeof r.ledgers)[number]>();
  const guids = new Set<string>();
  for (const l of r.ledgers) {
    const k = tight(l.name),
      s = byKey.get(k);
    if (
      !s ||
      ledgers.has(k) ||
      guids.has(l.guid.toLowerCase()) ||
      l.guid.slice(0, 36).toLowerCase() !== prefix ||
      (s.expectedGuid && s.expectedGuid !== l.guid)
    )
      throw new Error("LEDGER_IDENTITY_REJECTED");
    ledgers.set(k, l);
    guids.add(l.guid.toLowerCase());
  }
  const unavailable = new Set<string>();
  for (const n of r.unavailableNames) {
    const k = tight(n);
    if (!byKey.has(k) || ledgers.has(k) || unavailable.has(k))
      throw new Error("INVALID_LEDGER_COVERAGE");
    unavailable.add(k);
  }
  if (ledgers.size + unavailable.size !== scope.length)
    throw new Error("INCOMPLETE_LEDGER_COVERAGE");
  const rows = new Map<string, typeof r.bills>();
  const refs = new Set<string>();
  for (const b of r.bills) {
    const k = tight(b.partyName),
      id = JSON.stringify([k, b.billDate, b.reference]);
    if (!byKey.has(k) || refs.has(id) || b.billDate > asOf)
      throw new Error("INVALID_BILL_IDENTITY");
    refs.add(id);
    const list = rows.get(k) ?? [];
    list.push(b);
    rows.set(k, list);
  }
  const held: { name: string; reason: string }[] = [];
  const accepted: {
    alias: ScopeAlias;
    ledger: (typeof r.ledgers)[number];
    bills: typeof r.bills;
    amounts: { outstanding: string; overdue: string; due: string; running: string };
  }[] = [];
  const dealerCounts = new Map<string, number>();
  for (const a of scope) dealerCounts.set(a.dealerId, (dealerCounts.get(a.dealerId) ?? 0) + 1);
  for (const a of scope) {
    const k = tight(a.name),
      l = ledgers.get(k),
      bills = rows.get(k) ?? [];
    if (!l) {
      held.push({ name: a.name, reason: "LEDGER_UNAVAILABLE" });
      continue;
    }
    // Several saved aliases may describe a renamed ledger. Never sum two ledgers automatically.
    const presentForDealer = scope.filter(
      (x) =>
        x.dealerId === a.dealerId &&
        ((rows.get(tight(x.name))?.length ?? 0) > 0 ||
          (ledgers.get(tight(x.name)) && cents(ledgers.get(tight(x.name))!.closingBalance) !== 0n)),
    );
    if (presentForDealer.length > 1) {
      held.push({ name: a.name, reason: "MULTIPLE_LIVE_LEDGERS_FOR_DEALER" });
      continue;
    }
    const n = { outstanding: 0n, overdue: 0n, due: 0n, running: 0n };
    for (const b of bills) {
      const v = cents(b.pendingAmount);
      n.outstanding += v;
      n[bucket(b.dueDate, asOf).toLowerCase() as "overdue" | "due" | "running"] += v;
    }
    if (Object.values(n).some((v) => !amount.safeParse(decimal(v)).success)) {
      held.push({ name: a.name, reason: "AGGREGATE_OUT_OF_RANGE" });
      continue;
    }
    if (n.outstanding !== -cents(l.closingBalance)) {
      held.push({ name: a.name, reason: "BILLS_LEDGER_MISMATCH" });
      continue;
    }
    // If another alias has actual pending data, don't overwrite it with this alias's zero.
    if (presentForDealer.length === 1 && presentForDealer[0].name !== a.name) continue;
    if (accepted.some((x) => x.alias.dealerId === a.dealerId)) continue;
    accepted.push({
      alias: a,
      ledger: l,
      bills,
      amounts: {
        outstanding: decimal(n.outstanding),
        overdue: decimal(n.overdue),
        due: decimal(n.due),
        running: decimal(n.running),
      },
    });
  }
  return { report: r, accepted, held };
}
