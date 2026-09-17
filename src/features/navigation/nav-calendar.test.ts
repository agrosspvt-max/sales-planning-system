import assert from "node:assert/strict";
import { Role } from "@prisma/client";
import { navForRole } from "./nav";

const roles = [Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN];
for (const role of roles) {
  assert.equal(navForRole(role).some((item) => item.href === "/planning/calendar"), true, `${role}: Calendar defaults ON`);
  assert.equal(navForRole(role, true).some((item) => item.href === "/planning/calendar"), true, `${role}: Calendar appears when ON`);
  assert.equal(navForRole(role, false).some((item) => item.href === "/planning/calendar"), false, `${role}: Calendar is hidden when OFF`);
  assert.equal(navForRole(role, false).some((item) => item.href === "/dashboard"), true, `${role}: unrelated navigation remains`);
}

console.log("12 Calendar navigation setting contracts passed");
