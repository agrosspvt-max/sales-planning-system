export interface ReadProgress {
  stage: "report" | "ledgers" | "upload" | "publish";
  checked: number;
  total: number;
  updatedAt: string;
}

export interface SyncProgress {
  configured: boolean;
  enabled?: boolean;
  lastSeenAt?: string | null;
  lastPublishedAt?: string | null;
  refreshRequestedAt?: string | null;
  job?: {
    id?: string;
    progress?: ReadProgress | null;
    status: string;
    createdAt: string;
    completedAt: string | null;
    leaseExpiresAt: string;
    heldCount: number;
  } | null;
}

export function refreshProgress(
  state: SyncProgress | null | undefined,
  requestedAt?: string | null,
  now = Date.now(),
) {
  if (!state?.configured || !state.enabled)
    return { phase: "disabled", message: "Office connector is not enabled.", busy: false };
  const job = state.job;
  const requests = [requestedAt, state.refreshRequestedAt]
    .filter((value): value is string => !!value)
    .map(Date.parse);
  const requested = requests.length ? Math.max(...requests) : null;
  const thisRequest = requested !== null && job && Date.parse(job.createdAt) >= requested;
  const queued = !!state.refreshRequestedAt;
  const active = job?.status === "RUNNING" && Date.parse(job.leaseExpiresAt) > now;
  if (thisRequest && job.status === "COMPLETE")
    return {
      phase: "completed",
      message: job.heldCount
        ? "Refresh completed. Some dealers still need review."
        : "Refresh completed.",
      busy: false,
    };
  if (thisRequest && job.status === "FAILED")
    return {
      phase: "failed",
      message: "Refresh did not complete. Check the office connector.",
      busy: false,
    };
  const pending = queued || active || (requested !== null && !thisRequest);
  if (thisRequest && job.status === "RUNNING" && !active && !queued)
    return {
      phase: "failed",
      message: "The Tally read expired. Restart the office connector and request a new refresh.",
      busy: false,
    };
  const recent = !!state.lastSeenAt && now - Date.parse(state.lastSeenAt) <= 180000;
  if (pending && !recent)
    return {
      phase: "offline",
      message:
        "No recent contact from the office connector. Open it on the Tally computer; your refresh is queued.",
      busy: true,
    };
  if (active) {
    const progress = job.progress;
    if (!progress)
      return {
        phase: "reserved",
        message: "Waiting for the office connector to confirm this read.",
        busy: true,
      };
    if (now - Date.parse(progress.updatedAt) > 90000)
      return {
        phase: "stalled",
        message:
          "No recent progress from this read. Keep the office connector open; an administrator can restart the refresh.",
        busy: true,
      };
    const message =
      progress.stage === "report"
        ? "Reading Tally bill details."
        : progress.stage === "ledgers"
          ? `Checking dealer balances: ${progress.checked} of ${progress.total} aliases.`
          : progress.stage === "upload"
            ? "Sending the checked balances."
            : "Saving the checked balances. This page will update when it finishes.";
    return { phase: "reading", message, busy: true };
  }
  if (pending)
    return {
      phase: "queued",
      message: "Refresh queued. Waiting for the office connector to start.",
      busy: true,
    };
  return {
    phase: "idle",
    message: recent
      ? "Office connector contacted recently."
      : "No recent contact from the office connector.",
    busy: false,
  };
}

export function canRestartRefresh(job: SyncProgress["job"], now = Date.now()) {
  return (
    !!job?.id &&
    job.status === "RUNNING" &&
    now - Date.parse(job.createdAt) > 60000 &&
    (!job.progress || now - Date.parse(job.progress.updatedAt) > 90000)
  );
}
