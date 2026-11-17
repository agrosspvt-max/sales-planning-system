export type DealerAuditSummary = {
  scanned: number;
  matched: number;
  unmatched: { name: string; groups: string[] }[];
};

export type DealerAuditStatus = {
  configured: boolean;
  completedAt: string | null;
  summary: DealerAuditSummary | null;
  failed: boolean;
};
