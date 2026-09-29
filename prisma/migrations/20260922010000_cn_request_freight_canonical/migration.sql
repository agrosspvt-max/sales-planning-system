-- CN Request Freight terminology: the old dropdown submitted FRAT while displaying Freight.
-- The column is plain TEXT, so this narrowly updates only equivalent legacy rows.
UPDATE "CnRequest"
SET "cnType" = 'Freight'
WHERE "cnType" = 'FRAT';
