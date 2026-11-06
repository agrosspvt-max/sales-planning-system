import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { testLoader } from "@/features/dealer-tags/test-loader";
const load = testLoader({
  "../../../config/tally-sales-preview.json": {
    branch: "codex/tally-billwise-test",
    databaseHostSha256: createHash("sha256").update("test-db.example").digest("hex"),
  },
});
const { approvedTestPreview, missingSalesLedgerAsZeroEnabled, salesSyncEnabled } = load<
  typeof import("./sales-rollout")
>("src/features/tally/sales-rollout.ts");
const preview = {
  NODE_ENV: "test" as const,
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/tally-billwise-test",
  TALLY_SYNC_ENABLED: "true",
  DATABASE_URL: "postgresql://user:example@test-db-pooler.example/db",
  DIRECT_URL: "postgresql://user:example@test-db.example/db",
  TALLY_EXPECTED_DB_HOST: "test-db.example",
};
assert.equal(approvedTestPreview(preview), true);
assert.equal(approvedTestPreview({ ...preview, VERCEL_ENV: "production" }), false);
assert.equal(
  approvedTestPreview({ ...preview, DIRECT_URL: "postgresql://user:example@other-db.example/db" }),
  false,
);
assert.equal(missingSalesLedgerAsZeroEnabled(preview), true);
assert.equal(
  missingSalesLedgerAsZeroEnabled({
    ...preview,
    VERCEL_ENV: "production",
    TALLY_SALES_SYNC_ENABLED: "true",
  }),
  false,
);
assert.equal(
  salesSyncEnabled({ ...preview, VERCEL_ENV: "production", TALLY_SALES_SYNC_ENABLED: "true" }),
  true,
  "existing sales enable flag retains its meaning outside the test Preview",
);
for (const change of [
  { VERCEL_GIT_COMMIT_REF: "main" },
  { DIRECT_URL: "postgresql://user:example@another.example/db" },
  { TALLY_EXPECTED_DB_HOST: "another.example" },
  { TALLY_SALES_SYNC_ENABLED: "false" },
  { TALLY_SYNC_ENABLED: "false" },
])
  assert.equal(missingSalesLedgerAsZeroEnabled({ ...preview, ...change }), false);
console.log(
  "PASS missing-ledger zero rule is restricted to the approved test Preview branch/database; production retains previous policy",
);
