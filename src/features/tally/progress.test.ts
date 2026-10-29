import assert from "node:assert/strict";
import { refreshProgress, type SyncProgress } from "./progress";
const now = Date.parse("2026-10-29T06:30:00Z");
const request = "2026-10-29T06:29:00Z";
const state = (): SyncProgress => ({
  configured: true,
  enabled: true,
  lastSeenAt: "2026-10-29T06:29:50Z",
  refreshRequestedAt: request,
  job: {
    status: "COMPLETE",
    createdAt: "2026-10-29T05:00:00Z",
    completedAt: "2026-10-29T05:10:00Z",
    leaseExpiresAt: "2026-10-29T05:20:00Z",
    heldCount: 0,
  },
});
assert.equal(refreshProgress(state(), request, now).phase, "queued");
const offline = state();
offline.lastSeenAt = "2026-10-29T05:28:00Z";
assert.equal(refreshProgress(offline, request, now).phase, "offline");
const active = state();
active.refreshRequestedAt = null;
active.job = {
  ...active.job!,
  status: "RUNNING",
  createdAt: "2026-10-29T06:29:10Z",
  completedAt: null,
  leaseExpiresAt: "2026-10-29T06:49:10Z",
};
assert.equal(refreshProgress(active, request, now).phase, "reading");
active.job = { ...active.job!, status: "COMPLETE", completedAt: "2026-10-29T06:29:58Z" };
assert.equal(refreshProgress(active, request, now).phase, "completed");
assert.equal(refreshProgress(active, request, now).busy, false);
active.job.heldCount = 1;
assert.match(refreshProgress(active, request, now).message, /need review/);
active.job.status = "FAILED";
assert.equal(refreshProgress(active, request, now).phase, "failed");
const stale = state();
stale.refreshRequestedAt = null;
assert.notEqual(
  refreshProgress(stale, request, now).phase,
  "completed",
  "old success cannot acknowledge a newer request",
);
const racing = state();
racing.job!.completedAt = "2026-10-29T06:29:55Z";
assert.equal(
  refreshProgress(racing, request, now).phase,
  "queued",
  "completion of a job claimed before the request must not clear it",
);
const disabled = state();
disabled.enabled = false;
assert.equal(refreshProgress(disabled, request, now).phase, "disabled");
const newer = state();
newer.refreshRequestedAt = "2026-10-29T06:29:59Z";
newer.job = {
  ...newer.job!,
  status: "COMPLETE",
  createdAt: "2026-10-29T06:29:10Z",
  completedAt: "2026-10-29T06:29:55Z",
};
assert.equal(
  refreshProgress(newer, request, now).phase,
  "queued",
  "another tab's newer request supersedes this tab's completed request",
);
const expired = state();
expired.refreshRequestedAt = null;
expired.job = {
  ...expired.job!,
  status: "RUNNING",
  createdAt: "2026-10-29T06:29:10Z",
  leaseExpiresAt: "2026-10-29T06:29:59Z",
};
assert.equal(refreshProgress(expired, request, now).phase, "failed");
console.log(
  "PASS refresh queue, offline, active, completion, review, failure and request race checks",
);
