/**
 * Preview: node --import tsx scripts/repair-recovery-no-plan.ts
 * Apply:   node --import tsx scripts/repair-recovery-no-plan.ts --apply
 * Existing monthly/weekly amounts and approval status are verified unchanged before commit.
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { repairRecoveryNoPlan } from "../src/lib/recovery-no-plan-repair";

loadEnvConfig(process.cwd());
const db = new PrismaClient();
const actorIndex = process.argv.indexOf("--actor");
repairRecoveryNoPlan(db, process.argv.includes("--apply"), actorIndex < 0 ? undefined : process.argv[actorIndex + 1])
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
