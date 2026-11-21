/** LOCAL disposable PostgreSQL only. Uses and removes isolated fixtures; no deployment database.
 * PLAN_TX_TEST_URL=postgresql://rahmani@localhost:5432/plan_tx_test node --import tsx src/lib/district-auto-link.integration.ts
 */
import assert from "node:assert/strict";
import { PrismaClient, Role } from "@prisma/client";
import { autoLinkClearDistricts } from "./district-auto-link";

const url = process.env.PLAN_TX_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/plan_tx_test") throw new Error("Only a local plan_tx_test database is permitted.");
const db = new PrismaClient({ datasources: { db: { url } } });
const prefix = `district-auto-${Date.now()}`;
const id = (suffix: string) => `${prefix}-${suffix}`;
async function main() {
  const actorId = id("admin");
  try {
    await db.userGroup.createMany({ data: ["mp", "cg"].map(s => ({ id: id(s), name: id(s) })) });
    await db.user.createMany({ data: [
      { id: actorId, name: "Admin", username: actorId, passwordHash: "fixture", role: Role.SUPER_ADMIN },
      ...["one", "two", "cg", "stateless"].map(s => ({ id: id(s), name: s, username: id(s), passwordHash: "fixture", role: Role.SALES_OFFICER, groupId: s === "stateless" ? null : id(s === "cg" ? "cg" : "mp") })),
    ] });
    const districts = [
      ["harda", "Harda", "mp", true], ["narmada", "Narmada Puram", "mp", true], ["inactive", "Inactive", "mp", false],
      ["raipur", "Raipur", "cg", true], ["gari", "Gariyaband", "cg", true], ["ujjain", "Ujjain", "mp", true],
      ["amb1", "Ambiguous", "mp", true], ["amb2", "AMBIGUOUS", "mp", true],
    ] as const;
    await db.district.createMany({ data: districts.map(([key, name, state, isActive]) => ({ id: id(key), groupId: id(state), name, nameKey: id(key), isActive })) });
    await db.districtAlias.create({ data: { groupId: id("cg"), districtId: id("gari"), alias: "Gariaband", aliasKey: "gariaband" } });
    const market = await db.market.create({ data: { id: id("market"), name: prefix, nameKey: prefix, source: "EXISTING" } });
    async function mapping(key: string, district: string | null, owner: string | null = "one", districtId: string | null = null) {
      await db.dealer.create({ data: { id: id(key), name: key, isActive: key !== "inactive-dealer", deletedAt: key === "deleted-dealer" ? new Date() : null } });
      if (owner) await db.dealerAssignment.create({ data: { dealerId: id(key), officerId: id(owner), effectiveFrom: new Date("2026-01-01") } });
      return db.dealerMarketMapping.create({ data: { dealerId: id(key), district, districtId: districtId ? id(districtId) : null, marketId: market.id, marketText: "Keep manual market", potential: "B" } });
    }
    await mapping("exact", "HARDA");
    await mapping("spaces", " \t NARMADA   PURAM \n");
    await mapping("other-officer", "harda", "two");
    await mapping("wrong-state", "Raipur");
    await mapping("alias", "Gariaband", "cg");
    await mapping("inactive-master", "INACTIVE");
    await mapping("ambiguous", "ambiguous");
    await mapping("already-linked", "HARDA", "one", "ujjain");
    await mapping("linked-wrong-state", "Harda", "cg", "harda");
    await mapping("missing-state", "Harda", "stateless");
    await mapping("missing-owner", "Harda", null);
    await mapping("inactive-dealer", "Harda");
    await mapping("deleted-dealer", "Harda");
    await mapping("empty", "  \t\n ");
    await mapping("punctuation", "Narmada-Puram");
    await mapping("latest-away", "Harda");
    await db.dealerAssignment.create({ data: { dealerId: id("latest-away"), officerId: id("cg"), effectiveFrom: new Date("2026-08-15") } });
    const where = { dealer: { id: { startsWith: prefix } } };
    const snapshot = () => db.dealerMarketMapping.findMany({ where, orderBy: { dealerId: "asc" } });
    const before = await snapshot();
    const options = { actorId, officerIds: [id("one")], apply: false };
    const preview = await autoLinkClearDistricts(db, options);
    assert.deepEqual(preview.map(r => r.dealerId).sort(), [id("exact"), id("spaces")].sort());
    assert.equal(JSON.stringify(await snapshot()), JSON.stringify(before), "dry run writes nothing");
    assert.equal(await db.auditLog.count({ where: { userId: actorId } }), 0);
    const linked = await autoLinkClearDistricts(db, { ...options, apply: true });
    assert.equal(linked.length, 2);
    const after = await snapshot();
    const changed = new Set(linked.map(r => r.dealerId));
    for (let i = 0; i < before.length; i++) {
      const old = before[i], current = after[i];
      if (!changed.has(old.dealerId)) assert.equal(JSON.stringify(current), JSON.stringify(old), `${old.dealerId} stays untouched`);
      else {
        assert.equal(current.districtId, id(old.dealerId === id("exact") ? "harda" : "narmada"));
        const preserved = (row: typeof old) => Object.fromEntries(Object.entries(row).filter(([key]) => !["district", "districtId", "updatedAt", "updatedById"].includes(key)));
        assert.equal(JSON.stringify(preserved(current)), JSON.stringify(preserved(old)), "market, potential and every other mapping field are preserved");
      }
    }
    const audits = await db.auditLog.findMany({ where: { userId: actorId } });
    assert.equal(audits.length, 2);
    assert(audits.some(a => a.summary?.includes("HARDA → Harda")), "audit retains the original text");
    assert.equal((await autoLinkClearDistricts(db, { ...options, apply: true })).length, 0, "repeat is idempotent");
    assert.equal(await db.auditLog.count({ where: { userId: actorId } }), 2);
    const all = await autoLinkClearDistricts(db, { ...options, apply: true, officerIds: null });
    assert.deepEqual(all.map(r => r.dealerId), [id("other-officer")], "admin can repair the other officer's same-state match");
    await mapping("rollback", "Harda");
    const rollbackBefore = JSON.stringify(await snapshot());
    await assert.rejects(autoLinkClearDistricts(db, { ...options, apply: true, actorId: id("nonexistent") }));
    assert.equal(JSON.stringify(await snapshot()), rollbackBefore, "failure to audit rolls back all link updates");
    const outcomes = await Promise.allSettled([1, 2].map(() => autoLinkClearDistricts(db, { ...options, apply: true })));
    const successes = outcomes.filter((o): o is PromiseFulfilledResult<typeof linked> => o.status === "fulfilled");
    assert.equal(successes.reduce((n, o) => n + o.value.length, 0), 1, "racing automatic requests link and audit a row once");
    for (const outcome of outcomes) if (outcome.status === "rejected") assert(outcome.reason.code === "P2034" || outcome.reason.meta?.code === "40001", "a racing write may only fail with a serialization conflict");
    assert.equal(await db.auditLog.count({ where: { userId: actorId, entityId: id("rollback") } }), 1);
    console.log("district-auto-link.integration.ts — case/space matching, current-owner scope, exclusions, preservation, dry run, idempotency, rollback and concurrency passed");
  } finally {
    await db.auditLog.deleteMany({ where: { userId: actorId } });
    await db.dealerMarketMapping.deleteMany({ where: { dealerId: { startsWith: prefix } } });
    await db.dealerAssignment.deleteMany({ where: { dealerId: { startsWith: prefix } } });
    await db.dealer.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.market.deleteMany({ where: { id: id("market") } });
    await db.districtAlias.deleteMany({ where: { groupId: { in: [id("mp"), id("cg")] } } });
    await db.district.deleteMany({ where: { groupId: { in: [id("mp"), id("cg")] } } });
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.userGroup.deleteMany({ where: { id: { in: [id("mp"), id("cg")] } } });
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
