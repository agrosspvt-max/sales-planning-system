import "server-only";
import { createHash } from "node:crypto";
import approved from "../../../config/tally-sales-preview.json";
export function salesSyncEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.TALLY_SALES_SYNC_ENABLED === "false") return false;
  if (env.TALLY_SALES_SYNC_ENABLED === "true") return true;
  if (
    env.VERCEL_ENV !== "preview" ||
    env.VERCEL_GIT_COMMIT_REF !== approved.branch ||
    env.TALLY_SYNC_ENABLED !== "true"
  )
    return false;
  try {
    const norm = (host: string) => host.replace("-pooler.", ".").toLowerCase();
    return [env.DATABASE_URL, env.DIRECT_URL].every((value) => {
      const host = norm(new URL(value ?? "").hostname);
      return (
        host === norm(env.TALLY_EXPECTED_DB_HOST ?? "") &&
        createHash("sha256").update(host).digest("hex") === approved.databaseHostSha256
      );
    });
  } catch {
    return false;
  }
}
