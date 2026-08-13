-- Dealer approval lifecycle decoupled from plan approval.
-- Reconcile legacy Dealer.status labels to the 4-status model: PENDING / ACTIVE / INACTIVE / DEFAULTER.
-- `status` is the source of truth; `isActive` is kept in sync as (status <> 'INACTIVE').

-- SO-created dealers awaiting approval: PENDING_APPROVAL -> PENDING (these remain isActive = true).
UPDATE "Dealer" SET "status" = 'PENDING' WHERE "status" = 'PENDING_APPROVAL';

-- Any inactive dealer maps to the INACTIVE label. This covers legacy 'REJECTED' rows AND admin-
-- deactivated dealers that kept status = 'ACTIVE' while isActive = false, and soft-deleted rows.
UPDATE "Dealer" SET "status" = 'INACTIVE' WHERE "isActive" = false;
