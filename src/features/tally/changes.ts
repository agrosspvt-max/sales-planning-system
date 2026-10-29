import { z } from "zod";
import { cents, decimal } from "./billwise";

const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,11})\.\d{2}$/);
const changeSchema = z
  .object({
    dealerId: z.string().min(1).max(100),
    dealerName: z.string().min(1).max(256),
    before: amount,
    after: amount,
    reason: z.enum(["TALLY_CLOSING", "CREDIT_ADVANCE", "UNAVAILABLE_ZERO"]),
  })
  .strict();
export type OutstandingChange = z.infer<typeof changeSchema>;
export interface OutstandingHistory {
  records: (OutstandingChange & { id: string; observedAt: string | null; publishedAt: string })[];
  latestRefresh: {
    observedAt: string | null;
    publishedAt: string;
    changedCount: number | null;
  } | null;
  limit: number;
}

export function outstandingChanges(
  rows: {
    alias: { dealerId: string; name: string };
    ledger: unknown | null;
    amounts: { outstanding: string };
  }[],
  previous: Map<string, bigint>,
): OutstandingChange[] {
  return rows.flatMap((row) => {
    const before = previous.get(row.alias.dealerId);
    if (before === undefined) throw new Error("MISSING_PREVIOUS_OUTSTANDING");
    const after = cents(row.amounts.outstanding);
    if (before === after) return [];
    const reason: OutstandingChange["reason"] =
      row.ledger === null ? "UNAVAILABLE_ZERO" : after < 0n ? "CREDIT_ADVANCE" : "TALLY_CLOSING";
    return [
      {
        dealerId: row.alias.dealerId,
        dealerName: row.alias.name,
        before: decimal(before),
        after: decimal(after),
        reason,
      },
    ];
  });
}

export function savedOutstandingChanges(summary: string | null) {
  try {
    const value = JSON.parse(summary ?? "null");
    const parsed = z.array(changeSchema).max(1000).safeParse(value?.outstandingChanges);
    if (!parsed.success) return { recorded: false, changes: [] as OutstandingChange[] };
    return {
      recorded: true,
      changes: parsed.data.filter((row) => cents(row.before) !== cents(row.after)),
    };
  } catch {
    return { recorded: false, changes: [] as OutstandingChange[] };
  }
}
