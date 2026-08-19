-- Static Outstanding Mode: a per-dealer flag marking that Outstanding Till Date was set by a static-mode
-- aging import and must be protected from future dynamic imports/updates. Default false keeps every
-- existing row on the current dynamic behaviour.
ALTER TABLE "RecoveryPlanDealer" ADD COLUMN "outstandingStatic" BOOLEAN NOT NULL DEFAULT false;
