-- Race-safe duplicate guard for Vacant-Market requests: at most ONE open (PENDING_RM / PENDING_ADMIN) request per normalized Market name.
-- The application's pre-check alone cannot stop two simultaneous submits (double click / retry); this index makes the database refuse the second.
-- Prisma cannot express a partial unique index, so it lives only in this SQL file (same approach as the Dealer Status Request index).
--
-- PRE-FLIGHT (run first; it must return no rows, otherwise resolve the listed duplicate open requests before deploying):
--   SELECT "nameKey", count(*) FROM "MarketRequest" WHERE "status" IN ('PENDING_RM','PENDING_ADMIN') GROUP BY "nameKey" HAVING count(*) > 1;
CREATE UNIQUE INDEX "MarketRequest_one_open_per_name" ON "MarketRequest"("nameKey") WHERE "status" IN ('PENDING_RM', 'PENDING_ADMIN');
