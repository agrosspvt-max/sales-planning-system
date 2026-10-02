# Centralized Dealer Tags — implementation and verification

Implemented against the clarified business rules of 1 October 2026. This is a display/approval feature attached to existing Dealer IDs. Dealer names, aliases, current ownership, reassignment and financial/lifecycle data are not rewritten.

## Existing architecture reused

- `getOfficerScope`, `getCurrentOwnerByDealer` and `getCurrentManagerId` remain authoritative. They retain their existing selection/filter/ownership rules; an optional read client lets the new tag transactions reuse their own connection. Every old caller defaults to the same Prisma client as before.
- The existing Approval page receives a Dealer Tag section. Existing seasonal, monthly, recovery, CN and extension approval types remain intact. Tag history uses the existing `ApprovalAction` model and status badges.
- Existing `AuditLog`, `Notification`, `notifyMany` and `SYSTEM` notifications record and announce requests/decisions. `notifyMany` accepts an optional transaction client; old callers retain their existing behavior.
- The existing alias resolver/provider remains the source of displayed dealer names. Marker metadata stays separate from `Dealer.name`, aliases, imported names and selection values.
- Tag Master reuses `ResourceForm`, adding optional static select options/defaults without changing other resource forms.

## Persisted state and migration

The additive migration is `prisma/migrations/20261001010000_dealer_tags/migration.sql`.

| Model | Purpose |
|---|---|
| DealerTag | One global definition: name, normalized unique name key, text/symbol marker, active flag, timestamps. |
| DealerTagAssignment | One unique `(dealerId, tagId)` relationship, active flag, stable ID and timestamps. Revoke deactivates; re-add reactivates the same relationship. |
| DealerTagRequest | Add/Revoke request, requester, dealer/tag IDs, existing PlanStatus and timestamps. |
| ApprovalAction | One new nullable `dealerTagRequestId` link/index; existing approval records remain unchanged. |

Additional checks restrict marker types, operations and valid request stages. A partial unique index prevents more than one unresolved Add/Revoke request for a dealer/tag. Foreign keys prevent deleting definitions/relationships referenced by history. No existing unique constraint is replaced. No existing dealer/assignment/planning/financial data is backfilled or migrated.

**Rollout:** apply this migration through the normal deployment process before releasing/running the updated application. The migration was applied and tested only in a disposable local PostgreSQL database. It has not been deployed to the application database. The global display-metadata API requires these new tables.

## Routing, visibility and atomicity

| Actor/operation | Required stages |
|---|---|
| SO with applicable RM, Add or Revoke | PENDING_RM → PENDING_ADMIN → APPROVED |
| SO without applicable RM, Add or Revoke | PENDING_ADMIN → APPROVED |
| RM-authored Add or Revoke | PENDING_ADMIN → APPROVED |
| Admin direct Add/Revoke | Immediate assignment activation/deactivation, audited separately |

Admin cannot skip a pending RM stage through the approval endpoint. Only the applicable RM can review an SO request. RMs cannot approve their own requests or perform Admin final approval. Server scope/permission checks protect all mutations. Requests outside the current permitted dealer scope are rejected.

Pending Add never activates an assignment. Pending Revoke leaves the approved assignment active until Admin final approval. Rejected requests retain history and leave assignments unchanged; a later request creates a new history record. Admin direct actions are idempotent. Already-decided request retries are rejected without duplicate assignment/history/notification writes.

Pair mutations lock Dealer then DealerTag in a consistent order, re-read state, and keep assignments, request transitions, ApprovalAction, audit and notifications in one transaction. Audit entries include the actor, actual assignment/request ID, dealer/tag IDs, operation and approval action ID where applicable. New tag mutations have scoped 15-second transactions; no global transaction setting changes. Authorization reads inside them use the same connection, including with a one-connection pool.

Inactive definitions cannot receive new additions. Their approved assignments remain stored but are hidden and do not qualify for ordering. Reactivation restores valid still-active assignments. Inactive definitions can still be revoked. No history is deleted.

An Admin direct action is a separate bypass: it changes the approved assignment immediately and does not erase a pending request/history. Any later final decision remains idempotent at the assignment layer.

## APIs/pages

| Path | Operation |
|---|---|
| `/dealer-tags` | Universal scoped dealer selection, Add/Revoke request or Admin direct action, assignments and request history. |
| `/masters/dealer-tags` | Admin Tag Master create/edit/activation. |
| `GET /api/dealer-tags` | Authenticated global definitions. |
| `POST /api/dealer-tags` | Admin create. |
| `PATCH /api/dealer-tags/[id]` | Admin edit/activate/deactivate. |
| `GET /api/dealer-tags/dealers` | Current authorized dealers, aliases and assignment metadata. |
| `GET/POST /api/dealer-tags/requests` | Scoped request history / create request. |
| `POST /api/dealer-tags/requests/[id]/decide` | Applicable RM review / Admin final review. |
| `POST /api/dealer-tags/direct` | Separate Admin-only immediate Add/Revoke. |
| `GET /api/dealer-display-names` | Existing alias response extended with batched, authorized marker metadata. |

## Centralized display and ordering

`loadDealerMarkerMap` performs one assignment/definition query for any number of dealer IDs. Only approved active assignments with active definitions appear. Display metadata for SO/RM includes their current authorized dealers and historical dealer rows authorized by existing modules; mutation permissions continue to use current ownership only.

`DealerName` appends text capsules/symbols after the alias/fallback name, with the full tag name as tooltip/accessibility text. Native dealer selects append plain marker text to their existing labels; their Dealer IDs, territory suffixes and status indicators remain unchanged. Multiple active markers are displayed; their definition name/ID only determines a stable display order, not dealer ranking priority.

`taggedDealersFirst` is a stable partition. Callers retain their original alphabetic/business/user-selected sort within each group. `DealerTableBody` and `DealerOrder` opt in only rows explicitly identified by dealer ID. Dealer expansion groups move together; summaries, totals, products, schemes and unrelated rows retain their slots. Handlers are bound before presentation grouping, so edit-state indices and financial calculations remain unchanged.

The paginated Dealer Master query applies active-tag `EXISTS` ordering **before LIMIT/OFFSET**, then existing alias/display alphabetical order. Its raw edit records and search predicates remain unchanged. Dealer reports retain explicit sorting within groups and compute totals before display decoration/grouping, preserving the prior aggregation order. Top/Lowest dealer ranking membership and calculated rank numbers remain intact; only presentation groups the selected dealer entries.

Marker metadata refreshes every 15 seconds while the client is active and on normal stale-query focus/reload. Own tag mutations invalidate the relevant queries immediately. Changed metadata also invalidates server-ordered dealer pages/reports; pagination never depends on sorting just the returned page. This is cache refresh, not a push subscription. Pending request creation does not change markers.

## Consumer integration

Display/grouping covers dealer Master/Alias/coverage, dealer profile, officer dealer performance/ranking, seasonal/monthly dealer summaries and selectors, Territory Plan/Recovery dealer breakdowns, Recovery Month/Week views, CN lists/approval/details/payment dialogs, Daily Work dealer rows/auto tasks/Admin viewer/team performance, Scheme creation/planning/approved/enrolled/follow-up/payments/conversion dialogs/upload preview, Calendar conversion events/upcoming cards, dealer reports and matched import previews.

Where preview/detail responses had an authoritative Dealer ID internally but did not expose it, a display-only ID was added: CN payment detail, Calendar conversion projection, Sales import matched/planned-without-sales rows, Recovery accepted import rows and Daybook matched rows. Matching, imports, receipt calculations and financial writes are unchanged.

Unmatched import text, prospect Party/Appointment names, canonical-name editing inputs, audit summaries and source-file names are not treated as Dealer IDs. Tags are never guessed by name or embedded into editable/persisted name strings. Existing grouping boundaries such as officer/scheme/product/date remain in place.

## Verification results

- `npm run test:dealer-tags`: passed. Master validation/duplicates, role navigation/permissions, scoped routing, both approval stages, unauthorized/self decisions, pending visibility, Add/Revoke, rejection/re-request, multiple tags, direct retries/audit, injected rollback, stable alphabetic/business sorting, fixed summary slots and 1,000-ID batched lookup.
- React static-render tests: passed. Alias/fallback, multiple markers after name, native option text, tagged-first table expansion groups, dealer-vs-product performance tables, unchanged numeric row data and existing Approval integration.
- `npm run test:dealer-tags:db`: passed on isolated PostgreSQL with `connection_limit=1`. The actual migration/constraints, current scope, Admin/RM/SO routing, database-level duplicate prevention, concurrent requests, inactive/reactivation behavior, before-pagination ordering, real transaction rollback, audit/history, query count and unchanged Dealer/DealerAssignment records were verified.
- `npm test`: passed, including existing Scheme, CN, Daily Work, recovery, ownership and planning coverage.
- `npm run typecheck`: passed.
- `npm run lint`: passed with three pre-existing unused-variable warnings in import/dealers service, onboarding wizard and dealer profile service.
- `npm run build`: passed.
- `git diff --check`: passed.
- Browser against synthetic local fixtures: Tag Master text/symbol configuration, SO current dealer scope, Add request → RM Approve → Admin Final Approve in existing Approvals, marker hidden until final approval, then multiple markers after the alias and tagged dealers above untagged. No new React errors appeared during this flow. An initial stale session from an earlier local test was rejected normally and replaced with the fixture login.

## Practical limits

The application database was not modified and production/Neon latency was not benchmarked. Every individual consumer was not exercised with a complete real-world dataset; the full regression suite, centralized rendering tests and scoped browser flow supplement the SQL/service integration checks. The new periodic batched metadata reads should be monitored under production traffic; no N+1 tag queries or new per-row requests were introduced.

## Exact changed files

90 files (including this report). Paths below are relative to the repository root.

```text
docs/dealer-tags.md
package.json
prisma/migrations/20261001010000_dealer_tags/migration.sql
prisma/schema.prisma
src/app/(dashboard)/dealer-tags/page.tsx
src/app/(dashboard)/masters/dealer-tags/page.tsx
src/app/api/dealer-display-names/route.ts
src/app/api/dealer-tags/[id]/route.ts
src/app/api/dealer-tags/dealers/route.ts
src/app/api/dealer-tags/direct/route.ts
src/app/api/dealer-tags/requests/[id]/decide/route.ts
src/app/api/dealer-tags/requests/route.ts
src/app/api/dealer-tags/route.ts
src/components/dashboard/performance-table.tsx
src/components/dashboard/top-bottom-ranking.tsx
src/components/ui/select.tsx
src/features/calendar/calendar-view.tsx
src/features/calendar/calendar.server.ts
src/features/calendar/upcoming-card.tsx
src/features/cn-requests/cn-payment-dialog.tsx
src/features/cn-requests/cn-request-detail-dialog.tsx
src/features/cn-requests/cn-requests-page.tsx
src/features/cn-requests/service.server.ts
src/features/daily-work/admin-daily-work-viewer.tsx
src/features/daily-work/daily-work-page.tsx
src/features/daily-work/team-performance-page.tsx
src/features/dealer-tags/dealer-tag-requests.tsx
src/features/dealer-tags/dealer-tags-page.tsx
src/features/dealer-tags/dealer-tags-ui.test.tsx
src/features/dealer-tags/dealer-tags.integration.ts
src/features/dealer-tags/dealer-tags.test.ts
src/features/dealer-tags/refresh.ts
src/features/dealer-tags/service.server.ts
src/features/dealer-tags/tag-master-page.tsx
src/features/dealer-tags/test-loader.ts
src/features/dealer-tags/types.ts
src/features/dealers/dealer-name-ui.tsx
src/features/dealers/dealer-table-ui.tsx
src/features/import/dealers/wizard.tsx
src/features/import/seasonal/wizard.tsx
src/features/navigation/nav.ts
src/features/notifications/notification-bell.tsx
src/features/notifications/notifications-page.tsx
src/features/notifications/service.server.ts
src/features/planning/approvals-inbox.tsx
src/features/planning/dealer-form-dialog.tsx
src/features/planning/dealer-summary-view.tsx
src/features/planning/group-plan-page.tsx
src/features/planning/group-recovery-page.tsx
src/features/planning/monthly-additional-ui.tsx
src/features/planning/monthly-dealer-summary.tsx
src/features/planning/monthly-plan-actions.tsx
src/features/planning/monthly-planner.tsx
src/features/planning/my-approvals.tsx
src/features/planning/plan-actions.tsx
src/features/planning/plan-grid.tsx
src/features/profiles/dealer-profile.tsx
src/features/profiles/officer-profile.tsx
src/features/recovery/recovery-actions.tsx
src/features/recovery/recovery-import-wizard.tsx
src/features/recovery/recovery-workspace.tsx
src/features/recovery/service.server.ts
src/features/reports/reports-page.tsx
src/features/reports/service.server.ts
src/features/resources/config.ts
src/features/resources/resource-form.tsx
src/features/resources/resource-page.tsx
src/features/resources/service.server.ts
src/features/sales-upload/create-dealer-dialog.tsx
src/features/sales-upload/daybook-wizard.tsx
src/features/sales-upload/dealer-alias-page.tsx
src/features/sales-upload/dealer-coverage-panel.tsx
src/features/sales-upload/import-preview-report.tsx
src/features/sales-upload/service.server.ts
src/features/schemes/scheme-create-plan.tsx
src/features/schemes/scheme-detail-dialog.tsx
src/features/schemes/scheme-enrolled-view.tsx
src/features/schemes/scheme-follow-up-monitor.tsx
src/features/schemes/scheme-follow-up-view.tsx
src/features/schemes/scheme-officer-workspace.tsx
src/features/schemes/scheme-payments-page.tsx
src/features/schemes/scheme-planning-page.tsx
src/features/schemes/scheme-upload-wizard.tsx
src/features/schemes/scheme-view-plan.tsx
src/lib/calendar.ts
src/lib/dealer-page.server.ts
src/lib/dealer-tags.server.ts
src/lib/dealer-tags.ts
src/lib/rbac.ts
src/lib/scope.ts
```
