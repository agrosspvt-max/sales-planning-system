/**
 * Profile DTOs for the analytical Sales Officer / Dealer dashboards.
 *
 * These are pure view models assembled server-side from the existing fact engine
 * (computeFacts + shared aggregations). No business calculation lives here.
 */

/** One performance row (dealer or product) — shared shape for reusable tables. */
export interface PerfRow {
  id: string;
  label: string;
  planQty: number;
  actualQty: number;
  pendingQty: number;
  planAmount: number;
  actualAmount: number;
  achievementAmount: number;
  planNbv: number;
  actualNbv: number;
  status?: string;
  /** Optional deep-link target (e.g. dealer profile) for a clickable label. */
  href?: string;
}

/** Month-wise trend row. */
export interface MonthRow {
  id: string;
  label: string;
  plan: number;
  actual: number;
  achievement: number;
}

/** A labelled KPI value for the KpiCards widget. */
export interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

/** A shortcut rendered in the profile's Quick Actions section. */
export interface QuickAction {
  label: string;
  href: string;
  variant?: "default" | "outline";
  /** true → download / server route: rendered as a plain anchor, not a client Link. */
  external?: boolean;
  disabled?: boolean;
}

export interface RankRowDTO {
  id: string;
  label: string;
  planAmount: number;
  actualAmount: number;
  achievementAmount: number;
  href?: string;
}

export interface ApprovalSummaryDTO {
  seasonalPlanStatus: string;
  monthlyPlansOpen: number;
  pending: number;
  approved: number;
  rejected: number;
  draft: number;
}

export interface HistoryDTO {
  imports: { id: string; workbookName: string; status: string; dealerCount: number; productRows: number; createdAt: string }[];
  revisions: { id: string; version: number; versionName: string | null; status: string; source: string; createdAt: string }[];
  approvals: { id: string; action: string; actorName: string; fromStatus: string | null; toStatus: string | null; remarks: string | null; createdAt: string }[];
}

export interface OfficerProfile {
  header: {
    id: string;
    name: string;
    role: string;
    territory: string;
    regionalManager: string;
    status: "Active" | "Inactive";
    seasonName: string;
    assignedDealers: number;
    planningStatus: string;
  };
  season: { id: string; name: string };
  quickActions: QuickAction[];
  kpis: Kpi[];
  dealers: PerfRow[];
  products: PerfRow[];
  productsNotPlanned: string[];
  topDealers: RankRowDTO[];
  lowestDealers: RankRowDTO[];
  topProducts: RankRowDTO[];
  lowestProducts: RankRowDTO[];
  highestSalesProducts: RankRowDTO[];
  lowestAchievementProducts: RankRowDTO[];
  monthly: MonthRow[];
  approvals: ApprovalSummaryDTO;
  history: HistoryDTO;
}

export interface DealerProfile {
  header: {
    id: string;
    name: string;
    salesOfficer: string;
    regionalManager: string;
    territory: string;
    status: "Active" | "Inactive";
    seasonName: string;
  };
  season: { id: string; name: string };
  quickActions: QuickAction[];
  kpis: Kpi[];
  products: PerfRow[];
  monthly: MonthRow[];
  contribution: {
    /** This dealer's share of the officer's total plan amount (0..1). */
    sharePct: number;
    /** 1-based rank among the officer's dealers by plan amount. */
    rank: number;
    totalDealers: number;
    officerName: string;
    officerId: string;
    dealerPlanAmount: number;
    officerPlanAmount: number;
  };
}
