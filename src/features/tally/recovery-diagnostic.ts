import { z } from "zod";
import { decimal, tight } from "./billwise";
import type { RecoveryLedgerEvidence } from "./recovery-evidence";

const cents = (value: string) => BigInt(value.replace(".", ""));
const amount = z.string().regex(/^-?\d+\.\d{2}$/);
const entry = z.object({ name: z.string(), amount });
const allocation = z.object({
  ledgerName: z.string().nullish(),
  billReference: z.string().nullish(),
  referenceType: z.string().nullish(),
  amount: amount.nullish(),
});
const rawVoucher = z.object({
  guid: z.string(),
  ledgerName: z.string().optional(),
  date: z.string().optional(),
  billDate: z.string().optional(),
  voucherNumber: z.string().optional(),
  billNumber: z.string().optional(),
  voucherType: z.string().optional(),
  typeName: z.string().optional(),
  cancelled: z.boolean().optional(),
  optional: z.boolean().optional(),
  reason: z.string().optional(),
  creditAmount: amount.optional(),
  amount: amount.optional(),
  direction: z.string().optional(),
  ledgerEntries: z.array(entry).optional(),
  billAllocations: z.object({ entries: z.array(allocation), entryCount: z.number() }).optional(),
  details: z
    .object({
      voucher: z
        .object({
          cancelled: z.string().nullish(),
          optional: z.string().nullish(),
          ledgerEntries: z
            .array(z.object({ ledgerName: z.string().nullish(), amount: amount.nullish() }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type RecoveryDaybookSource = {
  jobId: string;
  monthKey: string;
  capturedAt: string;
  kind: "product" | "credit" | "other";
  voucher: unknown;
};
export type RecoveryDiagnosticVoucher = {
  guid: string;
  date: string;
  number: string;
  type: string;
  jobId: string;
  capturedAt: string;
  movement: string | null;
  excluded: boolean;
  allocations: { reference: string | null; type: string; movement: string | null }[];
  issues: string[];
};
export type RecoveryDiagnostic = {
  jobId: string;
  ledgerName: string;
  dealerName: string;
  asOf: string;
  recoveryCapturedAt: string;
  reason: string;
  evidence: RecoveryLedgerEvidence | null;
  coverage: {
    month: string;
    throughDate: string | null;
    capturedAt: string | null;
    complete: boolean;
  }[];
  coverageComplete: boolean;
  messages: string[];
  daybook: {
    movement: string | null;
    onAccount: string;
    allocationComplete: boolean;
    vouchers: RecoveryDiagnosticVoucher[];
    references: {
      reference: string;
      movement: string;
      openingReference: boolean;
      recoveryPending: string | null;
      difference: string | null;
    }[];
  };
};

/** One source voucher can occur in product evidence AND the receipt/other list. Count once. */
export function recoveryDaybookVouchers(
  sources: RecoveryDaybookSource[],
  ledgerName: string,
  asOf: string,
) {
  const key = tight(ledgerName);
  const groups = new Map<string, RecoveryDaybookSource[]>();
  let invalid = 0;
  for (const source of [...sources].sort(
    (a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.jobId.localeCompare(a.jobId),
  )) {
    const parsed = rawVoucher.safeParse(source.voucher);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const id = parsed.data.guid.toLowerCase();
    const rows = groups.get(id) ?? [];
    // The newest successful capture wins, including changed dates/flags. Sources
    // in that same capture enrich each other; older copies cannot double count.
    if (rows.length && rows[0].jobId !== source.jobId) continue;
    rows.push(source);
    groups.set(id, rows);
  }
  const vouchers: RecoveryDiagnosticVoucher[] = [];
  for (const [guid, copies] of groups) {
    copies.sort(
      (a, b) =>
        ["product", "credit", "other"].indexOf(a.kind) -
        ["product", "credit", "other"].indexOf(b.kind),
    );
    const rows = copies.map((source) => ({ source, row: rawVoucher.parse(source.voucher) }));
    const first = rows[0].row;
    const date = first.billDate ?? first.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      invalid++;
      continue;
    }
    if (date > asOf || date < "2026-04-01") continue;
    const issues: string[] = [];
    const excluded = rows.some(
      ({ row }) =>
        row.cancelled ||
        row.optional ||
        ["cancelled", "optional"].includes(row.reason ?? "") ||
        /^(yes|true|1)$/i.test(row.details?.voucher?.cancelled ?? "") ||
        /^(yes|true|1)$/i.test(row.details?.voucher?.optional ?? ""),
    );
    const amounts: bigint[] = [];
    for (const { source, row } of rows) {
      const ledgers = row.ledgerEntries?.filter((e) => tight(e.name) === key);
      const original = row.details?.voucher?.ledgerEntries?.filter(
        (e) => e.ledgerName && tight(e.ledgerName) === key,
      );
      if (ledgers?.length) amounts.push(-ledgers.reduce((sum, e) => sum + cents(e.amount), 0n));
      else if (source.kind === "credit" && row.creditAmount) amounts.push(-cents(row.creditAmount));
      else if (original?.length && original.every((e) => e.amount != null))
        amounts.push(-original.reduce((sum, e) => sum + cents(e.amount!), 0n));
      else if (
        row.amount &&
        row.ledgerName &&
        tight(row.ledgerName) === key &&
        ["credit", "debit", "zero"].includes(row.direction ?? "")
      )
        amounts.push(
          cents(row.amount) *
            (row.direction === "credit" ? -1n : row.direction === "zero" ? 0n : 1n),
        );
    }
    if (new Set(amounts.map(String)).size > 1)
      issues.push("Saved copies disagree on the party amount.");
    if (!amounts.length) issues.push("The original party-ledger amount was not recorded.");
    const movement = !issues.length ? decimal(amounts[0]) : null;
    const withAllocations = rows.filter(({ row }) => row.billAllocations);
    const captured = withAllocations[0]?.row.billAllocations;
    if (new Set(withAllocations.map(({ row }) => JSON.stringify(row.billAllocations))).size > 1)
      issues.push("Saved copies disagree on the bill allocations.");
    if (captured && captured.entryCount !== captured.entries.length)
      issues.push("Some bill allocations were omitted from this capture.");
    const allocations = (captured?.entries ?? [])
      .filter((e) => e.ledgerName && tight(e.ledgerName) === key)
      .map((e) => ({
        reference: e.billReference?.trim() || null,
        type: e.referenceType?.trim() || "Not recorded",
        movement: e.amount == null ? null : decimal(-cents(e.amount)),
      }));
    if (!excluded && movement !== "0.00" && !allocations.length)
      issues.push("No complete bill-reference allocation was captured for this voucher.");
    if (allocations.some((e) => e.movement === null))
      issues.push("An allocation amount was not recorded.");
    if (
      movement !== null &&
      allocations.length &&
      allocations.every((e) => e.movement !== null) &&
      allocations.reduce((sum, e) => sum + cents(e.movement!), 0n) !== cents(movement)
    )
      issues.push("The voucher's bill allocations do not add up to its party-ledger amount.");
    vouchers.push({
      guid,
      date,
      number: first.billNumber ?? first.voucherNumber ?? "",
      type: first.typeName ?? first.voucherType ?? "",
      jobId: copies[0].jobId,
      capturedAt: copies[0].capturedAt,
      movement,
      excluded,
      allocations,
      issues,
    });
  }
  return {
    vouchers: vouchers.sort(
      (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
    ),
    invalid,
  };
}

export function explainRecovery(
  base: Omit<RecoveryDiagnostic, "coverageComplete" | "messages" | "daybook">,
  sources: RecoveryDaybookSource[],
  truncated = false,
): RecoveryDiagnostic {
  const { vouchers, invalid } = recoveryDaybookVouchers(sources, base.ledgerName, base.asOf);
  const active = vouchers.filter((v) => !v.excluded);
  const coverageComplete = base.coverage.every((month) => month.complete) && !invalid && !truncated;
  const allocationComplete = coverageComplete && active.every((v) => !v.issues.length);
  const movement =
    !invalid && !truncated && active.every((v) => v.movement !== null)
      ? decimal(active.reduce((sum, v) => sum + cents(v.movement!), 0n))
      : null;
  let onAccount = 0n;
  const refs = new Map<string, { movement: bigint; hasNew: boolean }>();
  for (const v of active)
    for (const entry of v.allocations) {
      if (entry.movement === null) continue;
      if (/^on\s*account$/i.test(entry.type)) {
        onAccount += cents(entry.movement);
        continue;
      }
      if (!entry.reference) continue;
      const row = refs.get(entry.reference) ?? { movement: 0n, hasNew: false };
      row.movement += cents(entry.movement);
      row.hasNew ||= /^new\s*ref$/i.test(entry.type);
      refs.set(entry.reference, row);
    }
  const pending = new Map<string, bigint>();
  for (const bill of base.evidence?.bills ?? [])
    pending.set(bill.reference, (pending.get(bill.reference) ?? 0n) + cents(bill.pendingAmount));
  const messages = [
    "Recovery compares full party-ledger amounts including GST and rounding. The sales totals excluding GST are not a closing-balance calculation.",
  ];
  if (base.reason === "VERIFIED")
    messages.push(
      "The latest completed Recovery read accepted this ledger. There is no current hold in that read.",
    );
  else if (!base.evidence)
    messages.push(
      "This older Recovery read did not retain its rejected amounts. The next Recovery sync will save the exact closing balance, pending-bill total and difference here.",
    );
  if (!coverageComplete)
    messages.push(
      "Daybook coverage is incomplete for this cutoff. The displayed transactions cannot establish a complete reconciliation.",
    );
  if (!allocationComplete)
    messages.push(
      "Some bill-reference evidence is missing, conflicting or truncated. No exact cause is claimed for the remaining gap.",
    );
  if (onAccount !== 0n)
    messages.push(
      "Recorded On Account entries change the ledger balance without identifying a named bill. Review the highlighted vouchers below.",
    );
  if (
    allocationComplete &&
    base.evidence?.difference &&
    cents(base.evidence.difference) !== 0n &&
    cents(base.evidence.difference) === onAccount
  )
    messages.push(
      "The Recovery difference exactly matches the net On Account entries below. This is matching evidence to review in Tally; the captured opening balance and every outstanding reference are still needed to prove the full reconciliation.",
    );
  messages.push(
    "Daybook movement starts on 1 April 2026 and excludes any opening balance. References without a captured New Ref may belong to earlier bills; a missing original bill is not proof of an error.",
  );
  return {
    ...base,
    coverageComplete,
    messages,
    daybook: {
      movement,
      onAccount: decimal(onAccount),
      allocationComplete,
      vouchers,
      references: [...refs].map(([reference, row]) => ({
        reference,
        movement: decimal(row.movement),
        openingReference: !row.hasNew,
        recoveryPending: base.evidence ? decimal(pending.get(reference) ?? 0n) : null,
        difference:
          base.evidence && row.hasNew && allocationComplete
            ? decimal((pending.get(reference) ?? 0n) - row.movement)
            : null,
      })),
    },
  };
}
