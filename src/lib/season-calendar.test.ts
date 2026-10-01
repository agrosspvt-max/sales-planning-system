import assert from "node:assert/strict";
import { generateSeasonMonths } from "./season-months";
import {
  calendarRows,
  recoveryCalendar,
  resolveWorkDateMonth,
  validateAddMonths,
} from "./season-calendar";
import { resolveWorkbookMonths, workbookMonthColumns } from "./season-workbook-months";

const original = generateSeasonMonths({
  startMonth: 6,
  startYear: 2026,
  endMonth: 11,
  endYear: 2026,
}).months.map((m) => ({
  id: `${m.month}`,
  name: m.name,
  order: m.order,
  calendarMonth: m.month,
  calendarYear: m.year,
  status: m.order === 1 ? "OPEN" : "CLOSED",
}));
const snapshot = structuredClone(original);
assert.equal(validateAddMonths(original, [{ month: 5, year: 2026 }]).newPeriod.startMonth, 5);
assert.equal(validateAddMonths(original, [{ month: 12, year: 2026 }]).newPeriod.endMonth, 12);
const additions = [
  { month: 4, year: 2026 },
  { month: 5, year: 2026 },
  { month: 12, year: 2026 },
  { month: 1, year: 2027 },
];
assert.deepEqual(validateAddMonths(original, additions).newPeriod, {
  startMonth: 4,
  startYear: 2026,
  endMonth: 1,
  endYear: 2027,
});
const twelve = generateSeasonMonths({
  startMonth: 1,
  startYear: 2026,
  endMonth: 12,
  endYear: 2026,
}).months;
assert.equal(
  validateAddMonths(
    original,
    twelve.filter((m) => m.month < 6 || m.month > 11),
  ).additions.length,
  6,
);
assert.throws(
  () =>
    validateAddMonths(original, [
      ...twelve.filter((m) => m.month < 6 || m.month > 11),
      { month: 1, year: 2027 },
    ]),
  /12 calendar/,
);
assert.throws(() => validateAddMonths(original, [{ month: 4, year: 2026 }]), /continuous/);
assert.throws(() => validateAddMonths(original, [{ month: 6, year: 2026 }]), /already/);
assert.throws(
  () =>
    validateAddMonths(original, [
      { month: 12, year: 2026 },
      { month: 12, year: 2026 },
    ]),
  /already/,
);
assert.throws(
  () => validateAddMonths([{ calendarMonth: null, calendarYear: null }], additions),
  /ambiguous/,
);
assert.deepEqual(original, snapshot);
const anchor = { startMonth: 6, startYear: 2026 };
const expanded = { startMonth: 4, startYear: 2026 };
for (const month of original) {
  assert.deepEqual(
    recoveryCalendar(anchor, month, new Date()),
    recoveryCalendar(expanded, month, new Date()),
  );
  assert.deepEqual(
    recoveryCalendar(anchor, { order: month.order }, new Date()),
    recoveryCalendar(expanded, month, new Date()),
  );
}
assert.deepEqual(
  recoveryCalendar(expanded, { order: 10, calendarMonth: 1, calendarYear: 2027 }, new Date()),
  { year: 2027, month0: 0 },
);
const all = [
  ...original,
  ...additions.map((m, i) => ({
    id: `new${i}`,
    name: "",
    order: 7 + i,
    calendarMonth: m.month,
    calendarYear: m.year,
    status: "OPEN",
  })),
];
assert.deepEqual(
  calendarRows(all).map((m) => m.calendarMonth),
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 1],
);
assert.equal(resolveWorkDateMonth(all, "2027-01-05")?.calendarYear, 2027);
assert.equal(resolveWorkDateMonth(all, "2026-01-05"), null);
assert.throws(
  () =>
    resolveWorkDateMonth(
      [{ name: "January", calendarYear: null, calendarMonth: null }],
      "2027-01-05",
    ),
  /unresolved/,
);
const sheet = [
  ["Product", "1kg", "Month 1 Name -June", null, "July 2026"],
  ["Product", "1kg", "QTY", "Amount", "QTY"],
  ["Product A", 2, 3, 100, 4],
];
const columns = workbookMonthColumns(sheet, 1, [2, 4]);
assert.deepEqual(columns, [
  { month: 6, year: null },
  { month: 7, year: 2026 },
]);
assert.deepEqual(resolveWorkbookMonths(all, columns), ["6", "7"]); // June never becomes April after prepend.
assert.throws(() => resolveWorkbookMonths(all, [{ month: null, year: null }]), /positional/);
assert.throws(() => resolveWorkbookMonths(all, [{ month: 6, year: 2027 }]), /unambiguously/);
assert.throws(
  () =>
    resolveWorkbookMonths(all, [
      { month: 6, year: null },
      { month: 6, year: 2026 },
    ]),
  /duplicate/,
);
assert.throws(
  () =>
    resolveWorkbookMonths(
      [...all, { ...original[0], id: "otherJune", calendarYear: 2027 }],
      [{ month: 6, year: null }],
    ),
  /unambiguously/,
);
console.log(
  "Season calendar tests passed: extension, continuity, historical Recovery, chronological ranges, year resolution, and workbook mapping.",
);

assert.throws(
  () =>
    resolveWorkbookMonths(
      all,
      workbookMonthColumns(
        [
          ["", "June / July 2026"],
          ["", "QTY"],
        ],
        1,
        [1],
      ),
    ),
  /Ambiguous/,
);
assert.throws(
  () =>
    resolveWorkbookMonths(
      all,
      workbookMonthColumns(
        [
          ["", "", "June 2026"],
          ["", "QTY", "Amount"],
        ],
        1,
        [1],
      ),
    ),
  /positional/,
); // Never borrow a neighboring block's heading.
