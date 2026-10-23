# CN Under Process

Submitted CNs can be sent for **Rate Confirmation** or **CN Approval**. Either action moves the CN into Accepted → Under Process without setting acceptance, expiry or grace dates.

- Rate Confirmation: choose existing products and one active SO, RM or administrative account other than the sender. The assignee enters a non-negative price, to two decimal places, per litre/kg for every product. A submission note is optional; rejection requires a reason.
- CN Approval: attach a PDF/XLSX CN Working document and select an active administrative account other than the sender. The assignee can view/download the document and approve with an optional note, or reject with a required reason.
- The assigned review appears in the existing Approvals page. Assignment allows responding to that particular review, without granting access to unrelated CNs or modules.
- An authorized CN handler may replace/reassign a request, including changing review type. Previous attempts are retained. Old pending attempts become Replaced and cannot receive a stale response.
- The latest successful review displays Price Confirmed or CN Approved. A review rejection leaves the CN Under Process and does not reject the CN.
- A handler can use the existing final rejection/acceptance dialogs at any point. The latest pending/rejected review requires an additional bypass reason. The server validates the attempt identifier again, so a stale screen cannot decide a reassigned review.
- A final CN decision closes pending review work. CN Working Shared sets its expiry date at that point, with no initial grace. Handlers can explicitly extend expiry through the row menu (see cn-manual-grace.md). Direct ledger posting does not ask for expiry/grace.

Review/product/price/document history and every assignment, response, cancellation and final-decision event remain accessible from CN View Details. Account names are snapshotted when actions occur. Timeline days continue to use original submission as Day 0. Under Process response-time counters continue counting from submission. Status filters use stable review identifiers independently of edited wording.

New wording is registered through `CN_REVIEW_LABELS` and the existing Labels catalog. CN actions retain their existing approve/reject/post permissions. Administrative accounts can reach their assigned personal Approvals inbox without receiving general CN or planning permissions.

## Deployment

The additive migration is `20261027000000_cn_processing`. It creates `CnReviewAttempt` and `CnProcessingEvent`; it does not rewrite existing CNs or payment records. Apply pending project migrations through the normal deployment process before using Under Process. During a rolling deployment, missing review tables do not break existing CN details or personal approvals; attempting to send a review explains that the database update is required.

No production database migration or deployment was performed for this change.

## Validation

- `npm run test:cn-processing`: UI, labels, price validation, status filtering and narrow Approvals access.
- `CN_REVIEW_TEST_URL=postgresql://…/cn_processing_test npm run test:cn-processing:db`: both branches, reassignment, concurrency, scope, bypass rollback, existing final actions, expiry timing and durable history. The test refuses non-local databases and any other database name. Use a fresh disposable database.
- Existing CN request, expiry, timeline, filter, export, account authorization and Labels checks were run. Both CN processing and existing expiry/payment integrations passed against disposable local PostgreSQL databases with all migrations applied.
- Type-checking, focused lint, schema validation and an isolated production build passed.

A full schema comparison also reported pre-existing index-name differences and RetailerRequest relation/index differences outside this feature. The new processing tables matched their migration. No unrelated schema changes were applied.
