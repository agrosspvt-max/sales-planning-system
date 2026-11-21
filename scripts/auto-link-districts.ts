/** Preview: node --import tsx scripts/auto-link-districts.ts
 * Apply: node --import tsx scripts/auto-link-districts.ts --apply --actor <admin-id>
 * Only clear case/whitespace matches to an active district of the current owner's state are linked.
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient, Role } from "@prisma/client";
import { autoLinkClearDistricts } from "../src/lib/district-auto-link";

loadEnvConfig(process.cwd());
const db = new PrismaClient();
async function main() {
  const apply = process.argv.includes("--apply");
  const actorIndex = process.argv.indexOf("--actor");
  const actorId = actorIndex < 0 ? undefined : process.argv[actorIndex + 1];
  const actor = await db.user.findFirst({ where: { ...(actorId ? { id: actorId } : {}), role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }, select: { id: true } });
  if (!actor) throw new Error("An active Super Admin is required for the matching audit.");
  const rows = await autoLinkClearDistricts(db, { apply, officerIds: null, actorId: actor.id });
  console.log(JSON.stringify({ applied: apply, linked: rows.length, byState: rows.reduce<Record<string, number>>((out, row) => { out[row.stateName] = (out[row.stateName] ?? 0) + 1; return out; }, {}) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
