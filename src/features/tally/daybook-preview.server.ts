import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { loadEffectiveLastPayments } from "@/lib/dealer-last-payment.server";
import { indiaDay } from "./billwise";
import { creditTotals, validateDaybookCapture, type DaybookCredit } from "./daybook-preview";

const NON_DEALER_LEDGERS = new Set(["PMVBRY SCHEME - EPF", "BANK CHARGES", "SUSPENSE"]);

export async function resolveDaybookCapture(
  db: Pick<
    Prisma.TransactionClient,
    "dealer" | "dealerAlias" | "recoveryPlan" | "dealerAssignment"
  >,
  capture: ReturnType<typeof validateDaybookCapture>,
) {
  const grouped = new Map<string, DaybookCredit[]>();
  for (const credit of capture.credits) {
    const list = grouped.get(credit.ledgerName);
    if (list) list.push(credit);
    else grouped.set(credit.ledgerName, [credit]);
  }
  if (grouped.size > 1_500)
    throw new ApiError(422, "This capture exceeds the review limit of 1,500 ledgers.");
  const [calendarYear, calendarMonth] = capture.month.split("-").map(Number);
  const [resolver, plans] = await Promise.all([
    loadDealerResolver(db, { includeInactive: true }),
    db.recoveryPlan.findMany({
      where: {
        lifecycleState: "ACTIVE",
        seasonMonth: { calendarYear, calendarMonth, status: "OPEN", season: { status: "OPEN" } },
        OR: [{ seasonPlanId: null }, { seasonPlan: { lifecycleState: "ACTIVE" } }],
      },
      select: {
        id: true,
        officerId: true,
        officer: { select: { name: true } },
        season: { select: { name: true, year: true } },
        dealers: {
          where: { dealer: { isActive: true, deletedAt: null } },
          select: { dealerId: true, liveRecovery: true, srCr: true },
        },
      },
    }),
  ]);
  type Plan = (typeof plans)[number];
  type ExistingRow = Plan["dealers"][number];
  const plansByOfficer = new Map<string, Plan[]>();
  const existing = new Map<string, { plan: Plan; row: ExistingRow }[]>();
  for (const plan of plans) {
    plansByOfficer.set(plan.officerId, [...(plansByOfficer.get(plan.officerId) ?? []), plan]);
    for (const row of plan.dealers)
      existing.set(row.dealerId, [...(existing.get(row.dealerId) ?? []), { plan, row }]);
  }
  const assignments = await db.dealerAssignment.findMany({
    where: {
      officerId: { in: [...plansByOfficer.keys()] },
      effectiveTo: null,
      dealer: { isActive: true, deletedAt: null },
    },
    select: { dealerId: true, officerId: true },
  });
  const assigned = new Map<string, Set<Plan>>();
  for (const assignment of assignments) {
    const options = assigned.get(assignment.dealerId) ?? new Set<Plan>();
    for (const plan of plansByOfficer.get(assignment.officerId) ?? []) options.add(plan);
    assigned.set(assignment.dealerId, options);
  }

  const matches = new Map<
    string,
    { dealerName: string; credits: DaybookCredit[]; ledgers: string[] }
  >();
  const unmatched: {
    ledgerName: string;
    candidates: string[];
    candidateIds: string[];
    liveRecovery: string;
    srCr: string;
  }[] = [];
  const candidatesFor = new Map<string, ReturnType<typeof resolver.candidates>>();
  function candidatesForLedger(ledgerName: string) {
    const saved = candidatesFor.get(ledgerName);
    if (saved) return saved;
    const candidates = resolver.candidates(ledgerName);
    candidatesFor.set(ledgerName, candidates);
    return candidates;
  }
  function uniqueDealer(ledgerName: string) {
    const candidates = candidatesForLedger(ledgerName);
    const candidate = candidates[0];
    return candidates.length === 1 && ["ALIAS", "EXACT"].includes(candidate.matchType)
      ? candidate.dealer
      : null;
  }
  const excludedAccounts: { ledgerName: string; liveRecovery: string; srCr: string }[] = [];
  for (const [ledgerName, credits] of grouped) {
    if (NON_DEALER_LEDGERS.has(ledgerName.toUpperCase())) {
      const { liveRecovery, srCr } = creditTotals(credits);
      excludedAccounts.push({ ledgerName, liveRecovery, srCr });
      continue;
    }
    const dealer = uniqueDealer(ledgerName);
    if (!dealer) {
      const candidates = candidatesForLedger(ledgerName);
      const { liveRecovery, srCr } = creditTotals(credits);
      unmatched.push({
        ledgerName,
        candidateIds: candidates.map((c) => c.dealer.id),
        candidates: candidates.slice(0, 5).map((c) => c.dealer.name),
        liveRecovery,
        srCr,
      });
      continue;
    }
    const { id, name } = dealer;
    const match = matches.get(id) ?? { dealerName: name, credits: [], ledgers: [] };
    match.credits.push(...credits);
    match.ledgers.push(ledgerName);
    matches.set(id, match);
  }
  function recoveryFor(dealerId: string) {
    const rows = existing.get(dealerId) ?? [];
    const options = rows.length
      ? rows.map(({ plan }) => plan)
      : [...(assigned.get(dealerId) ?? [])];
    const plan = options.length === 1 ? options[0] : null;
    return {
      plan,
      saved: plan ? rows[0]?.row : undefined,
      issue: options.length > 1 ? "Multiple eligible Recovery plans" : "No eligible Recovery plan",
    };
  }
  return { matches, unmatched, excludedAccounts, uniqueDealer, recoveryFor };
}

export async function previewDaybook(raw: unknown) {
  const connections = await prisma.tallyConnection.findMany({
    where: { enabled: true },
    select: { companyName: true, anchorGuid: true },
    take: 2,
  });
  if (connections.length !== 1) throw new ApiError(409, "Configure one office connector first.");
  const today = indiaDay();
  let capture: ReturnType<typeof validateDaybookCapture>;
  try {
    capture = validateDaybookCapture(raw, connections[0], today);
  } catch {
    throw new ApiError(
      422,
      "Choose an original Daybook capture from the configured Tally company and approved period.",
    );
  }
  const { matches, unmatched, excludedAccounts, recoveryFor } = await resolveDaybookCapture(
    prisma,
    capture,
  );
  const receiptDealerIds = [...matches]
    .filter(([, match]) => match.credits.some((c) => c.category === "receipt"))
    .map(([id]) => id);
  const lastPayments = await loadEffectiveLastPayments(receiptDealerIds, today);
  const dealers = [...matches]
    .map(([id, match]) => {
      const { plan, saved, issue } = recoveryFor(id);
      const totals = creditTotals(match.credits);
      return {
        dealerName: match.dealerName,
        ledgers: match.ledgers,
        ...totals,
        recovery: plan
          ? {
              season: `${plan.season.name} ${plan.season.year}`,
              officer: plan.officer.name,
              liveRecovery: saved?.liveRecovery.toFixed(2) ?? "0.00",
              srCr: saved?.srCr.toFixed(2) ?? "0.00",
            }
          : null,
        recoveryIssue: issue,
        lastPaymentOnFile: lastPayments.get(id) ?? null,
      };
    })
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName));
  return {
    month: capture.month,
    throughDate: capture.throughDate,
    observedAt: capture.observedAt,
    completeMonth: capture.completeMonth,
    excluded: capture.excluded,
    totals: creditTotals(capture.credits),
    dealers,
    unmatched: unmatched.map(({ ledgerName, candidates, liveRecovery, srCr }) => ({
      ledgerName,
      candidates,
      liveRecovery,
      srCr,
    })),
    excludedAccounts,
    review: capture.review,
  };
}

export type DaybookPreviewResult = Awaited<ReturnType<typeof previewDaybook>>;
