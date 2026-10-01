import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import * as calendar from "@/lib/season-calendar";
import * as months from "@/lib/season-months";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const localRequire = createRequire(import.meta.url);
const load = (prisma: unknown) => {
  const source = readFileSync(resolve("src/features/seasons/add-months.server.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule,
    exports: testModule.exports,
    require: (name: string) =>
      ({
        "server-only": {},
        "@prisma/client": { Prisma, Role },
        zod: { z },
        "@/lib/prisma": { prisma },
        "@/lib/http": { ApiError },
        "@/lib/season-calendar": calendar,
        "@/lib/season-months": months,
        "@/lib/audit": {
          writeAudit: async (
            data: unknown,
            tx: { auditLog: { create: (arg: unknown) => Promise<unknown> } },
          ) => tx.auditLog.create({ data }),
        },
      })[name] ?? localRequire(name),
    console,
    Date,
    Set,
    Math,
  });
  return testModule.exports as typeof import("./add-months.server");
};
const initial = () => ({
  season: {
    id: "season",
    status: "OPEN",
    year: 2026,
    startMonth: 6,
    startYear: 2026,
    endMonth: 11,
    endYear: 2026,
  },
  months: months
    .generateSeasonMonths({ startMonth: 6, startYear: 2026, endMonth: 11, endYear: 2026 })
    .months.map((m) => ({
      id: `old-${m.month}`,
      seasonId: "season",
      name: m.name,
      order: m.order,
      calendarMonth: m.month,
      calendarYear: m.year,
      status: m.order % 2 ? "OPEN" : "CLOSED",
    })),
  planning: [{ monthlyQty: 100, actualSales: 70 }],
  recovery: [{ balance: 800, aging: 15, status: "APPROVED" }],
  audits: [] as unknown[],
});
function harness(failure?: "write" | "audit") {
  let state = initial();
  let tail = Promise.resolve();
  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      const draft = structuredClone(state);
      const tx = {
        $queryRaw: async (sql: Prisma.Sql) => {
          assert.match(sql.text, /FOR UPDATE/);
          assert.deepEqual(sql.values, ["season"]);
          return [{ id: "season" }];
        },
        season: {
          findUnique: async () => ({ ...draft.season, months: draft.months }),
          update: async ({ data }: { data: object }) => {
            Object.assign(draft.season, data);
            return draft.season;
          },
        },
        seasonMonth: {
          createManyAndReturn: async ({ data }: { data: typeof draft.months }) => {
            if (failure === "write") throw new Error("write failed");
            const rows = data.map((m, i) => ({ ...m, id: `new-${draft.months.length + i}` }));
            draft.months.push(...rows);
            return rows;
          },
        },
        auditLog: {
          create: async ({ data }: { data: unknown }) => {
            if (failure === "audit") throw new Error("audit failed");
            draft.audits.push(data);
          },
        },
      };
      try {
        const result = await work(tx);
        state = draft;
        return result;
      } finally {
        release();
      }
    },
  };
  return { service: load(prisma), state: () => state };
}
const admin = { userId: "admin", role: Role.SUPER_ADMIN, username: "admin", groupId: null };
const addition = {
  months: [
    { month: 5, year: 2026 },
    { month: 12, year: 2026 },
    { month: 1, year: 2027 },
  ],
};
async function main() {
  const h = harness();
  const before = structuredClone(h.state());
  await h.service.addSeasonMonths(admin, "season", addition);
  assert.deepEqual(h.state().months.slice(0, 6), before.months);
  assert.deepEqual(h.state().planning, before.planning);
  assert.deepEqual(h.state().recovery, before.recovery);
  assert.equal(h.state().season.year, 2026);
  assert.equal(h.state().season.startMonth, 5);
  assert.deepEqual(
    h
      .state()
      .months.slice(6)
      .map((m) => m.order),
    [7, 8, 9],
  );
  assert.equal(h.state().audits.length, 1);
  const audit = h.state().audits[0] as { entity: string; summary: string; userId: string };
  assert.equal(audit.entity, "seasonMonths");
  assert.equal(audit.userId, "admin");
  assert.equal(JSON.parse(audit.summary).added.length, 3);
  const closed = harness();
  closed.state().season.status = "CLOSED";
  await assert.rejects(closed.service.addSeasonMonths(admin, "season", addition), /Reopen/);
  assert.equal(closed.state().audits.length, 0);
  await assert.rejects(
    h.service.addSeasonMonths({ ...admin, role: Role.SALES_OFFICER }, "season", addition),
    /Super Admin/,
  );
  for (const failure of ["write", "audit"] as const) {
    const f = harness(failure);
    const snap = structuredClone(f.state());
    await assert.rejects(f.service.addSeasonMonths(admin, "season", addition), /failed/);
    assert.deepEqual(f.state(), snap);
  }
  const gap = harness();
  const snap = structuredClone(gap.state());
  await assert.rejects(
    gap.service.addSeasonMonths(admin, "season", { months: [{ month: 4, year: 2026 }] }),
    /continuous/,
  );
  assert.deepEqual(gap.state(), snap);
  const concurrent = harness();
  const outcomes = await Promise.allSettled(
    [1, 2].map(() => concurrent.service.addSeasonMonths(admin, "season", addition)),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(concurrent.state().audits.length, 1);
  console.log(
    "Add Months transaction contract tests passed: permissions, preservation, audit, rollback, and concurrent duplicate revalidation. No dependent planning/financial creation methods are exposed.",
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
