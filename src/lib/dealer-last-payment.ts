/**
 * Persistent latest-payment state for the Last Payment Report (DB access through a passed-in client; no "server-only", so the backfill script can use it).
 *
 *  • DealerPaymentReceipt = the ACCEPTED receipt ledger (import-independent). A receipt's identity is (dealer, date, amount, occurrence), where `occurrence` is its
 *    1-based index among IDENTICAL receipts of the SAME source file:
 *        – the same receipt delivered again (retry, identical file, replacement/overlapping file, regular + historical copy) lands on a key that already exists → not counted again;
 *        – two genuine identical payments inside one file get occurrence 1 and 2 → both kept;
 *        – a later file with MORE identical rows only adds the extra occurrences (a file's multiplicity can add, never subtract).
 *    Voucher numbers are not globally unique, so they are provenance only. Two different files that each legitimately hold one identical same-day payment are
 *    indistinguishable from an overlap and count once (the historical import's explicit "keep as distinct" review overrides this).
 *  • DealerLastPayment = ONE row per dealer: the newest qualifying date (≤ the business date) and the SUM of that date's accepted receipts, recomputed from the
 *    ledger with the SAME shared selector Recovery uses (`latestReceiptAsOf`), so date and amount always come from the same day and only grow. A stored summary
 *    ("LEGACY_SNAPSHOT") is a fallback for its date and is never added to individual receipts of that date.
 *  Callers hold the receipt-store advisory lock, so concurrent uploads serialize and an older upload finishing later cannot overwrite a newer result.
 */
import type { Prisma } from "@prisma/client";
import { latestReceiptAsOf, type ReceiptPoint } from "./last-payment";

export type PaymentDb = Pick<Prisma.TransactionClient, "dealerPaymentReceipt" | "dealerLastPayment">;
export const LEGACY_SNAPSHOT = "LEGACY_SNAPSHOT";

export interface IncomingReceipt {
  dealerId: string;
  /** "YYYY-MM-DD" */
  date: string;
  amount: number;
  sourceOrder?: number;
  voucherNumber?: string | null;
  /** The reviewer explicitly confirmed this row as a DISTINCT receipt although an equal one is already accepted: it takes the next free occurrence. */
  distinct?: boolean;
}
export interface AcceptResult { accepted: number; skipped: number; dealerIds: string[] }

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const keyOf = (dealerId: string, date: string, c: number) => JSON.stringify([dealerId, date, c]);

/** Receipts that can be accepted at all: a dealer, a real date, a positive finite amount. */
export function acceptableReceipts(receipts: readonly IncomingReceipt[]): IncomingReceipt[] {
  return receipts.filter((r) => r.dealerId && DATE.test(r.date) && Number.isFinite(r.amount) && r.amount > 0 && r.amount < 1e12);
}

/** PURE: give every receipt of ONE file its occurrence index among identical (dealer, date, amount) rows, in source order. */
export function assignOccurrences(receipts: readonly IncomingReceipt[]): (IncomingReceipt & { occurrence: number })[] {
  const seen = new Map<string, number>();
  return [...acceptableReceipts(receipts)].sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0)).map((r) => {
    const key = keyOf(r.dealerId, r.date, cents(r.amount));
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...r, occurrence };
  });
}

/** Add the receipts of ONE source file to the ledger (idempotent) and refresh the affected dealers' latest payment. */
export async function acceptReceipts(db: PaymentDb, receipts: readonly IncomingReceipt[], meta: { sourceKind: string; importId?: string | null }, today: string): Promise<AcceptResult> {
  const rows = assignOccurrences(receipts);
  const dealerIds = [...new Set(rows.map((r) => r.dealerId))];
  if (rows.length === 0) return { accepted: 0, skipped: 0, dealerIds };
  const existing = await db.dealerPaymentReceipt.findMany({
    where: { dealerId: { in: dealerIds }, receiptDate: { in: [...new Set(rows.map((r) => r.date))].map(asDate) } },
    select: { dealerId: true, receiptDate: true, amount: true, occurrence: true, sourceKind: true },
  });
  // A stored summary of a date (LEGACY_SNAPSHOT) is only a FALLBACK for a date without individual receipts: real receipts of that date replace it (so they are never shadowed by it).
  const covered = new Set(rows.map((r) => `${r.dealerId}|${r.date}`));
  const shadow = existing.filter((e) => e.sourceKind === LEGACY_SNAPSHOT && covered.has(`${e.dealerId}|${iso(e.receiptDate)}`));
  if (shadow.length) await db.dealerPaymentReceipt.deleteMany({ where: { sourceKind: LEGACY_SNAPSHOT, OR: shadow.map((e) => ({ dealerId: e.dealerId, receiptDate: e.receiptDate })) } });
  const dropped = new Set(shadow);
  const taken = new Map<string, Set<number>>();
  for (const e of existing) {
    if (dropped.has(e)) continue; const k = keyOf(e.dealerId, iso(e.receiptDate), cents(Number(e.amount))); taken.set(k, (taken.get(k) ?? new Set()).add(e.occurrence)); }
  const data: Prisma.DealerPaymentReceiptUncheckedCreateInput[] = [];
  for (const r of rows) {
    const k = keyOf(r.dealerId, r.date, cents(r.amount));
    const used = taken.get(k) ?? new Set<number>();
    let occurrence = r.occurrence;
    if (r.distinct) occurrence = Math.max(0, ...used) + 1; // explicitly distinct: never merged into an equal accepted receipt
    else if (used.has(occurrence)) continue; // already accepted
    used.add(occurrence); taken.set(k, used);
    data.push({ dealerId: r.dealerId, receiptDate: asDate(r.date), amount: r.amount, occurrence, sourceKind: meta.sourceKind, importId: meta.importId ?? null, sourceOrder: r.sourceOrder ?? null, voucherNumber: r.voucherNumber ?? null });
  }
  if (data.length) await db.dealerPaymentReceipt.createMany({ data, skipDuplicates: true });
  await refreshLastPayments(db, dealerIds, today); // also on a pure re-delivery: repairs a summary left behind by an earlier failure
  return { accepted: data.length, skipped: rows.length - data.length, dealerIds };
}

/** The ledger as selector input (a LEGACY_SNAPSHOT entry is tagged so it is never added to individual receipts). */
export function ledgerPoints(rows: readonly { receiptDate: Date; amount: unknown; sourceKind: string }[]): ReceiptPoint[] {
  return rows.map((r) => ({ date: iso(r.receiptDate), amount: Number(r.amount), ...(r.sourceKind === LEGACY_SNAPSHOT ? { kind: "snapshot" as const } : {}) }));
}
export function selectLatest(points: readonly ReceiptPoint[], today: string): { date: string; amount: number; basis: "RECEIPTS" | "LEGACY_SNAPSHOT" } | null {
  const best = latestReceiptAsOf(points, today);
  if (!best) return null;
  return { date: best.date, amount: best.amount, basis: points.some((p) => p.date === best.date && p.kind !== "snapshot") ? "RECEIPTS" : LEGACY_SNAPSHOT };
}

/** Recompute the persistent latest payment of each dealer from its accepted ledger. Never moves a stored date backwards; never deletes. */
export async function refreshLastPayments(db: PaymentDb, dealerIds: readonly string[], today: string): Promise<number> {
  const ids = [...new Set(dealerIds)];
  if (ids.length === 0) return 0;
  const [ledger, current] = await Promise.all([
    db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: ids } }, select: { dealerId: true, receiptDate: true, amount: true, sourceKind: true } }),
    db.dealerLastPayment.findMany({ where: { dealerId: { in: ids } }, select: { dealerId: true, paymentDate: true, amount: true, basis: true } }),
  ]);
  const byDealer = new Map<string, typeof ledger>();
  for (const l of ledger) byDealer.set(l.dealerId, [...(byDealer.get(l.dealerId) ?? []), l]);
  const have = new Map(current.map((c) => [c.dealerId, c]));
  let written = 0;
  for (const id of ids) {
    const best = selectLatest(ledgerPoints(byDealer.get(id) ?? []), today);
    if (!best) continue; // nothing qualifies yet (e.g. only future-dated receipts): the stored state stays as it is
    const prev = have.get(id);
    if (prev && iso(prev.paymentDate) > best.date) continue; // monotonic: a stored newer date is never replaced by an older one
    if (prev && iso(prev.paymentDate) === best.date && Number(prev.amount) === best.amount && prev.basis === best.basis) { await db.dealerLastPayment.update({ where: { dealerId: id }, data: { asOfDate: asDate(today) } }); continue; }
    await db.dealerLastPayment.upsert({
      where: { dealerId: id },
      create: { dealerId: id, paymentDate: asDate(best.date), amount: best.amount, basis: best.basis, asOfDate: asDate(today) },
      update: { paymentDate: asDate(best.date), amount: best.amount, basis: best.basis, asOfDate: asDate(today) },
    });
    written++;
  }
  return written;
}

/* ------------------------------------------------ preservation across replacement ------------------------------------------------ */

export interface RetainedImport {
  id: string; scopeKey: string; isActive: boolean; createdAt: Date;
  receipts: { id: string; dealerId: string; receiptDate: Date; creditAmount: unknown; sourceOrder: number | null; voucherNumber?: string | null }[];
}
export interface SupersededPick { importId: string; scopeKey: string; receiptId: string; dealerId: string; date: string; amount: number; sourceOrder: number | null; voucherNumber: string | null }

/**
 * PURE. Which receipts of earlier REGULAR Day Book files still speak for a dealer that the CURRENT file of its month no longer mentions.
 * A replacement file supersedes what it says about the dealers it contains; for a dealer it does NOT contain, the newest earlier file that did is the last word about it,
 * and that file's receipts are valid payments that only lost their usable source (deactivation). Rules:
 *   • per month/scope, per dealer: the NEWEST file (createdAt, id) that contains the dealer — all of that file's receipts for the dealer (its own multiplicity); older versions of
 *     the same dealer are never added (a corrected amount in a later file is respected);
 *   • `incoming` (a replacement being committed): the dealers of the incoming file are skipped (the new file speaks for them); every other dealer of that scope is eligible,
 *     whether its newest file is still active (about to be deactivated) or already inactive;
 *   • without `incoming` (audit / repair): a dealer is eligible only if NO active file of its scope contains it and its newest file is inactive;
 *   • only REGULAR files are considered (the caller filters); rejected / excluded Historical rows are never touched.
 */
export function selectSupersededReceipts(imports: readonly RetainedImport[], incoming?: { scopeKey: string; dealerIds: ReadonlySet<string> }): SupersededPick[] {
  const out: SupersededPick[] = [];
  const scopes = new Map<string, RetainedImport[]>();
  for (const i of imports) scopes.set(i.scopeKey, [...(scopes.get(i.scopeKey) ?? []), i]);
  for (const [scopeKey, files] of scopes) {
    if (incoming && incoming.scopeKey !== scopeKey) continue;
    const newestFirst = [...files].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const activeDealers = new Set(files.filter((f) => f.isActive).flatMap((f) => f.receipts.map((r) => r.dealerId)));
    const settled = new Set<string>();
    for (const file of newestFirst) {
      const byDealer = new Map<string, RetainedImport["receipts"]>();
      for (const r of file.receipts) byDealer.set(r.dealerId, [...(byDealer.get(r.dealerId) ?? []), r]);
      for (const [dealerId, rows] of byDealer) {
        if (settled.has(dealerId)) continue; // a newer file already spoke for this dealer
        settled.add(dealerId);
        if (incoming ? incoming.dealerIds.has(dealerId) : activeDealers.has(dealerId) || file.isActive) continue;
        for (const r of rows) out.push({ importId: file.id, scopeKey, receiptId: r.id, dealerId, date: iso(r.receiptDate), amount: Number(r.creditAmount), sourceOrder: r.sourceOrder, voucherNumber: r.voucherNumber ?? null });
      }
    }
  }
  return out.filter((p) => acceptableReceipts([{ dealerId: p.dealerId, date: p.date, amount: p.amount }]).length === 1);
}

type ScopeDb = PaymentDb & Pick<Prisma.TransactionClient, "lastPaymentImport">;
export interface PreserveResult { eligible: SupersededPick[]; accepted: number; skipped: number; dealerIds: string[] }
/**
 * Accept the eligible superseded receipts (see selectSupersededReceipts) into the permanent ledger, file by file, idempotently — and refresh the affected dealers' latest payment.
 * Called inside the retention transaction BEFORE a replacement deactivates the previous files (so no dealer, matched or absent, loses its usable source), and by the
 * backfill / repair for files that were already replaced before permanent storage (or its runtime) existed. `onlyReceiptIds` restricts a repair to explicitly named receipts.
 */
export async function preserveSupersededReceipts(db: ScopeDb, today: string, opts: { incoming?: { scopeKey: string; dealerIds: ReadonlySet<string> }; onlyReceiptIds?: readonly string[]; onlyDealerIds?: readonly string[]; dryRun?: boolean } = {}): Promise<PreserveResult> {
  const files = await db.lastPaymentImport.findMany({
    where: { kind: "REGULAR", ...(opts.incoming ? { scopeKey: opts.incoming.scopeKey } : {}) },
    select: { id: true, scopeKey: true, isActive: true, createdAt: true, receipts: { select: { id: true, dealerId: true, receiptDate: true, creditAmount: true, sourceOrder: true, voucherNumber: true } } },
  });
  let eligible = selectSupersededReceipts(files, opts.incoming);
  if (opts.onlyReceiptIds) { const wanted = new Set(opts.onlyReceiptIds); eligible = eligible.filter((p) => wanted.has(p.receiptId)); }
  if (opts.onlyDealerIds) { const wanted = new Set(opts.onlyDealerIds); eligible = eligible.filter((p) => wanted.has(p.dealerId)); }
  const result: PreserveResult = { eligible, accepted: 0, skipped: 0, dealerIds: [...new Set(eligible.map((p) => p.dealerId))] };
  if (opts.dryRun) return result;
  const byFile = new Map<string, IncomingReceipt[]>();
  for (const p of eligible) byFile.set(p.importId, [...(byFile.get(p.importId) ?? []), { dealerId: p.dealerId, date: p.date, amount: p.amount, sourceOrder: p.sourceOrder ?? undefined, voucherNumber: p.voucherNumber }]);
  for (const [importId, rows] of byFile) { const done = await acceptReceipts(db, rows, { sourceKind: "REGULAR", importId }, today); result.accepted += done.accepted; result.skipped += done.skipped; }
  return result;
}

/**
 * Post-condition of a retention — strict, not just "a key exists":
 *   • every acceptable incoming receipt has EVERY occurrence it needs (two genuine identical receipts of one file → occurrences 1 and 2 are both in the ledger);
 *   • every dealer with a receipt that has already happened has a latest-payment row;
 *   • that row follows the selection rules: never older than what the ledger's newest eligible receipt says, and on the same date equal to the ledger's same-day sum;
 *   • every dealer that had a payment before the replacement (`previous`) still has one at least that new.
 * Returns human-readable problems (empty = preserved). A retention that cannot prove this must fail / stay pending instead of reporting success.
 */
export async function missingPermanentPayments(db: PaymentDb, receipts: readonly IncomingReceipt[], today: string, previous?: ReadonlyMap<string, { date: string; amount: number }>): Promise<string[]> {
  const rows = assignOccurrences(receipts);
  const dealerIds = [...new Set([...rows.map((r) => r.dealerId), ...(previous?.keys() ?? [])])];
  if (dealerIds.length === 0) return [];
  const [ledger, latest] = await Promise.all([
    db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: dealerIds } }, select: { dealerId: true, receiptDate: true, amount: true, occurrence: true, sourceKind: true } }),
    db.dealerLastPayment.findMany({ where: { dealerId: { in: dealerIds } }, select: { dealerId: true, paymentDate: true, amount: true } }),
  ]);
  const haveOcc = new Set(ledger.map((l) => `${keyOf(l.dealerId, iso(l.receiptDate), cents(Number(l.amount)))}#${l.occurrence}`));
  const stored = new Map(latest.map((l) => [l.dealerId, { date: iso(l.paymentDate), amount: Number(l.amount) }]));
  const byDealer = new Map<string, typeof ledger>();
  for (const l of ledger) byDealer.set(l.dealerId, [...(byDealer.get(l.dealerId) ?? []), l]);
  const problems = new Set<string>();
  for (const r of rows) {
    if (!haveOcc.has(`${keyOf(r.dealerId, r.date, cents(r.amount))}#${r.occurrence}`)) problems.add(`${r.dealerId}: receipt ${r.date} ${r.amount} (occurrence ${r.occurrence}) is not in the permanent ledger`);
  }
  for (const id of dealerIds) {
    const best = selectLatest(ledgerPoints(byDealer.get(id) ?? []), today);
    const have = stored.get(id);
    if (best && !have) problems.add(`${id}: no latest-payment record although the ledger has a payment on ${best.date}`);
    else if (best && have && (have.date < best.date || (have.date === best.date && Math.round(have.amount * 100) !== Math.round(best.amount * 100)))) problems.add(`${id}: latest payment ${have.date}/${have.amount} does not follow the ledger (${best.date}/${best.amount})`);
    const before = previous?.get(id);
    if (before && (!have || have.date < before.date)) problems.add(`${id}: previous payment ${before.date} was not preserved`);
  }
  return [...problems];
}

/* ------------------------------------------------ legacy sources → ledger (initialization + backfill) ------------------------------------------------ */

type BackfillDb = PaymentDb & Pick<Prisma.TransactionClient, "lastPaymentReceipt" | "lastPaymentImport" | "$queryRaw" | "$executeRaw">;
export interface BackfillConflict { dealerId: string; kind: "SNAPSHOT_DIFFERS_FROM_RECEIPTS" | "FILE_VERSIONS_DIFFER"; detail: string }
export interface BackfillStats {
  dealersExamined: number; dealersMissingBefore: number; receiptsAccepted: number; receiptsSkipped: number; snapshotsAdded: number; summariesWritten: number; supersededAccepted: number;
  compared: number; identical: number; different: number; differences: { dealerId: string; legacy: { date: string; amount: number } | null; persisted: { date: string; amount: number } | null }[];
  /** Every dealer whose persistent latest payment changes (or is created): before → after. */
  changes: { dealerId: string; before: { date: string; amount: number } | null; after: { date: string; amount: number } | null }[];
  /** Sources that disagree and deserve a human look (nothing is written differently because of them). */
  conflicts: BackfillConflict[];
}
const emptyStats = (): BackfillStats => ({ dealersExamined: 0, dealersMissingBefore: 0, receiptsAccepted: 0, receiptsSkipped: 0, snapshotsAdded: 0, summariesWritten: 0, supersededAccepted: 0, compared: 0, identical: 0, different: 0, differences: [], changes: [], conflicts: [] });
type SnapshotRow = { dealerId: string; date: string; amount: string | null };
type ActiveReceipt = { dealerId: string; receiptDate: Date; creditAmount: unknown; importId: string; sourceOrder: number | null; voucherNumber: string | null; import: { kind: string } };

const loadSnapshots = (db: BackfillDb, dealerIds?: readonly string[]) => dealerIds
  ? db.$queryRaw<SnapshotRow[]>`SELECT "dealerId", "lastReceiptDate"::text AS "date", "lastReceiptAmount"::text AS "amount" FROM "RecoveryPlanDealer" WHERE "lastReceiptDate" IS NOT NULL AND "dealerId" = ANY(${[...dealerIds]})`
  : db.$queryRaw<SnapshotRow[]>`SELECT "dealerId", "lastReceiptDate"::text AS "date", "lastReceiptAmount"::text AS "amount" FROM "RecoveryPlanDealer" WHERE "lastReceiptDate" IS NOT NULL`;
const loadActiveReceipts = (db: BackfillDb, dealerIds?: readonly string[]) => db.lastPaymentReceipt.findMany({
  where: { import: { isActive: true }, ...(dealerIds ? { dealerId: { in: [...dealerIds] } } : {}) },
  orderBy: [{ import: { createdAt: "asc" } }, { importId: "asc" }, { sourceOrder: "asc" }, { id: "asc" }],
  select: { dealerId: true, receiptDate: true, creditAmount: true, importId: true, sourceOrder: true, voucherNumber: true, import: { select: { kind: true } } },
}) as Promise<ActiveReceipt[]>;

/** Accept the legacy sources of ONE chunk of dealers (receipts of ACTIVE files file by file, then fallback snapshots) and refresh their latest payment. Idempotent. */
async function acceptLegacyChunk(db: BackfillDb, chunk: ReadonlySet<string>, snapshots: readonly SnapshotRow[], receipts: readonly ActiveReceipt[], today: string, stats: BackfillStats): Promise<void> {
  // 1) individual receipts, file by file (an import = one file), so identical receipts of one file keep their multiplicity and overlap across files collapses.
  const byImport = new Map<string, { kind: string; rows: IncomingReceipt[] }>();
  for (const r of receipts) {
    if (!chunk.has(r.dealerId)) continue;
    const g = byImport.get(r.importId) ?? { kind: r.import.kind, rows: [] };
    g.rows.push({ dealerId: r.dealerId, date: iso(r.receiptDate), amount: Number(r.creditAmount), sourceOrder: r.sourceOrder ?? undefined, voucherNumber: r.voucherNumber });
    byImport.set(r.importId, g);
  }
  for (const [importId, g] of byImport) {
    const done = await acceptReceipts(db, g.rows, { sourceKind: g.kind, importId }, today);
    stats.receiptsAccepted += done.accepted; stats.receiptsSkipped += done.skipped;
  }
  // 2) legacy snapshots: a fallback entry only for a date that has NO individual receipt (never added to receipts), first snapshot of a date wins.
  const wanted = snapshots.filter((s) => chunk.has(s.dealerId) && DATE.test(s.date.slice(0, 10)) && Number(s.amount ?? 0) >= 0);
  const have = wanted.length ? await db.dealerPaymentReceipt.findMany({ where: { dealerId: { in: [...chunk] } }, select: { dealerId: true, receiptDate: true } }) : [];
  const occupied = new Set(have.map((h) => `${h.dealerId}|${iso(h.receiptDate)}`));
  const add: Prisma.DealerPaymentReceiptUncheckedCreateInput[] = [];
  for (const s of wanted) {
    const day = s.date.slice(0, 10), k = `${s.dealerId}|${day}`;
    if (occupied.has(k)) continue;
    occupied.add(k);
    add.push({ dealerId: s.dealerId, receiptDate: asDate(day), amount: Number(s.amount ?? 0), occurrence: 1, sourceKind: LEGACY_SNAPSHOT });
  }
  if (add.length) { await db.dealerPaymentReceipt.createMany({ data: add, skipDuplicates: true }); stats.snapshotsAdded += add.length; }
  stats.summariesWritten += await refreshLastPayments(db, [...chunk], today);
}

/**
 * Make sure the given dealers have PERMANENT payment state for everything their current (active) sources say — used right before a replacement removes those sources
 * (receipts of active files + the per-plan "Last Payment" snapshots the monthly commit resets). Only what the report currently shows is preserved: deactivated older
 * versions of a file are NOT restored here. Idempotent; never moves a stored date backwards.
 */
export async function initializeDealers(db: BackfillDb, dealerIds: readonly string[], today: string, opts: { snapshots?: boolean } = {}): Promise<{ receiptsAccepted: number; snapshotsAdded: number; summariesWritten: number; previous: Map<string, { date: string; amount: number }> }> {
  const ids = [...new Set(dealerIds)];
  const stats = emptyStats();
  const previous = new Map<string, { date: string; amount: number }>();
  const size = 200;
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    const [snapshots, receipts, stored] = await Promise.all([opts.snapshots === false ? Promise.resolve([] as SnapshotRow[]) : loadSnapshots(db, chunk), loadActiveReceipts(db, chunk), db.dealerLastPayment.findMany({ where: { dealerId: { in: chunk } }, select: { dealerId: true, paymentDate: true, amount: true } })]);
    await acceptLegacyChunk(db, new Set(chunk), snapshots, receipts, today, stats);
    const after = await db.dealerLastPayment.findMany({ where: { dealerId: { in: chunk } }, select: { dealerId: true, paymentDate: true, amount: true } });
    for (const a of after) previous.set(a.dealerId, { date: iso(a.paymentDate), amount: Number(a.amount) });
    void stored;
  }
  return { receiptsAccepted: stats.receiptsAccepted, snapshotsAdded: stats.snapshotsAdded, summariesWritten: stats.summariesWritten, previous };
}

/** Every dealer id that has ANY existing payment source (snapshot, receipt of any REGULAR / active file) — the backfill's universe. */
export async function legacySourceDealerIds(db: BackfillDb): Promise<string[]> {
  const [snap, rec] = await Promise.all([
    db.$queryRaw<{ dealerId: string }[]>`SELECT DISTINCT "dealerId" FROM "RecoveryPlanDealer" WHERE "lastReceiptDate" IS NOT NULL`,
    db.lastPaymentReceipt.findMany({ where: { OR: [{ import: { isActive: true } }, { import: { kind: "REGULAR" } }] }, select: { dealerId: true }, distinct: ["dealerId"] }),
  ]);
  return [...new Set([...snap.map((s) => s.dealerId), ...rec.map((r) => r.dealerId)])].sort();
}

/**
 * Copy EXISTING payment data into the ledger + latest-payment state (restartable, idempotent, `dealerIds` restricts it to a slice). Sources: receipts of ACTIVE imports, the
 * receipts of REGULAR files that a normal replacement deactivated for dealers the replacement never mentioned (selectSupersededReceipts — never an older version of a
 * dealer the current file covers, never a Historical / excluded row), and legacy per-plan snapshots (fallback entries, only for a date that has no individual receipt).
 * Billing-exception snapshots are never a source. Writes ONLY the ledger and the latest-payment table. The returned stats are the reviewable preview: dealers examined / missing
 * before, receipts and summaries added, before → after per dealer, and conflicting sources.
 */
export async function backfillDealerLastPayments(db: BackfillDb, today: string, opts: { chunk?: number; dealerIds?: readonly string[] } = {}): Promise<BackfillStats> {
  const stats = emptyStats();
  const only = opts.dealerIds;
  const [snapshots, receipts, files] = await Promise.all([
    loadSnapshots(db, only), loadActiveReceipts(db, only),
    db.lastPaymentImport.findMany({ where: { kind: "REGULAR" }, select: { id: true, scopeKey: true, isActive: true, createdAt: true, receipts: { select: { id: true, dealerId: true, receiptDate: true, creditAmount: true, sourceOrder: true, voucherNumber: true } } } }),
  ]);
  // Conflicts (informational): a snapshot that disagrees with the receipts of its date; several file versions that disagree about one dealer/date.
  const sums = new Map<string, number>();
  for (const r of receipts) { const k = `${r.dealerId}|${iso(r.receiptDate)}`; sums.set(k, (sums.get(k) ?? 0) + Number(r.creditAmount)); }
  for (const sn of snapshots) { const k = `${sn.dealerId}|${sn.date.slice(0, 10)}`; const rs = sums.get(k); if (rs !== undefined && Math.round(rs * 100) !== Math.round(Number(sn.amount ?? 0) * 100)) stats.conflicts.push({ dealerId: sn.dealerId, kind: "SNAPSHOT_DIFFERS_FROM_RECEIPTS", detail: `${sn.date.slice(0, 10)}: snapshot ${sn.amount} vs receipts ${rs}` }); }
  const versions = new Map<string, Map<string, number>>();
  for (const f of files) for (const r of f.receipts) { if (only && !only.includes(r.dealerId)) continue; const k = `${r.dealerId}|${iso(r.receiptDate)}`; const m = versions.get(k) ?? new Map<string, number>(); m.set(f.id, (m.get(f.id) ?? 0) + Number(r.creditAmount)); versions.set(k, m); }
  for (const [k, m] of versions) { const totals = new Set([...m.values()].map((v) => Math.round(v * 100))); if (totals.size > 1) { const [dealerId, date] = k.split("|"); stats.conflicts.push({ dealerId: dealerId!, kind: "FILE_VERSIONS_DIFFER", detail: `${date}: ${[...totals].map((t) => t / 100).join(" vs ")} across ${m.size} files — please review (the ledger counts each identical receipt once; the active file is the report source)` }); } }

  const universe = only ? [...new Set(only)].sort() : await legacySourceDealerIds(db);
  const beforeAll = new Map((await db.dealerLastPayment.findMany({ where: { dealerId: { in: universe } }, select: { dealerId: true, paymentDate: true, amount: true } })).map((p) => [p.dealerId, { date: iso(p.paymentDate), amount: Number(p.amount) }]));
  stats.dealersMissingBefore = universe.filter((id) => !beforeAll.has(id)).length;
  // Superseded-but-valid payments (a replacement removed their usable source before permanent storage existed): accepted first, file by file.
  const superseded = await preserveSupersededReceipts(db, today, { onlyDealerIds: only });
  stats.supersededAccepted = superseded.accepted;
  const dealerIds = [...new Set([...universe, ...superseded.dealerIds])].sort();
  const size = opts.chunk ?? 200;
  for (let i = 0; i < dealerIds.length; i += size) {
    const chunk = new Set(dealerIds.slice(i, i + size));
    stats.dealersExamined += chunk.size;
    await acceptLegacyChunk(db, chunk, snapshots, receipts, today, stats);
    // compare with the previous selection (active receipts + snapshots through the shared selector) and record before → after.
    const persisted = new Map((await db.dealerLastPayment.findMany({ where: { dealerId: { in: [...chunk] } } })).map((p) => [p.dealerId, { date: iso(p.paymentDate), amount: Number(p.amount) }]));
    const points = new Map<string, ReceiptPoint[]>();
    for (const r of receipts) if (chunk.has(r.dealerId)) points.set(r.dealerId, [...(points.get(r.dealerId) ?? []), { date: iso(r.receiptDate), amount: Number(r.creditAmount) }]);
    for (const sn of snapshots) if (chunk.has(sn.dealerId)) points.set(sn.dealerId, [...(points.get(sn.dealerId) ?? []), { date: sn.date.slice(0, 10), amount: Number(sn.amount ?? 0), kind: "snapshot" }]);
    for (const id of chunk) {
      const legacy = latestReceiptAsOf(points.get(id) ?? [], today);
      const now = persisted.get(id) ?? null, before = beforeAll.get(id) ?? null;
      stats.compared++;
      if (JSON.stringify(before) !== JSON.stringify(now)) stats.changes.push({ dealerId: id, before, after: now });
      if (legacy?.date === now?.date && legacy?.amount === now?.amount) stats.identical++;
      else { stats.different++; if (stats.differences.length < 50) stats.differences.push({ dealerId: id, legacy: legacy ? { date: legacy.date, amount: legacy.amount } : null, persisted: now }); }
    }
  }
  return stats;
}
