import assert from "node:assert/strict";
import { deriveTerritoryPlanMetrics, isNegativeTerritoryPlanMetric } from "./group-plan-metrics";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test("Territory Remaining uses Planned (All Months) minus Season Qty", () => {
  const metrics = deriveTerritoryPlanMetrics({
    seasonQty: 44_088,
    plannedAllMonths: 40_667,
    seasonAmount: 0,
    plannedAllMonthsAmount: 0,
    seasonSales: 0,
    seasonSalesAmount: 0,
  });

  assert.equal(metrics.remaining, -3_421);
});

test("Territory Remaining is positive when monthly planned exceeds the season quantity", () => {
  const metrics = deriveTerritoryPlanMetrics({
    seasonQty: 25_300,
    plannedAllMonths: 35_900,
    seasonAmount: 0,
    plannedAllMonthsAmount: 0,
    seasonSales: 0,
    seasonSalesAmount: 0,
  });

  assert.equal(metrics.remaining, 10_600);
});

test("Territory Pending uses Season Sales minus Season Qty", () => {
  const shortfall = deriveTerritoryPlanMetrics({
    seasonQty: 44_088,
    plannedAllMonths: 0,
    seasonAmount: 0,
    plannedAllMonthsAmount: 0,
    seasonSales: 14_664,
    seasonSalesAmount: 0,
  });
  const aboveTarget = deriveTerritoryPlanMetrics({
    seasonQty: 43_500,
    plannedAllMonths: 0,
    seasonAmount: 0,
    plannedAllMonthsAmount: 0,
    seasonSales: 49_200,
    seasonSalesAmount: 0,
  });

  assert.equal(shortfall.pendingSales, -29_424);
  assert.equal(aboveTarget.pendingSales, 5_700);
});

test("Territory amount comparisons use the same new direction", () => {
  const metrics = deriveTerritoryPlanMetrics({
    seasonQty: 0,
    plannedAllMonths: 0,
    seasonAmount: 1_000_000,
    plannedAllMonthsAmount: 850_000,
    seasonSales: 0,
    seasonSalesAmount: 1_125_000,
  });

  assert.equal(metrics.remainingAmount, -150_000);
  assert.equal(metrics.pendingAmount, 125_000);
});

test("direction change preserves magnitudes and does not mutate source aggregates", () => {
  const sources = {
    seasonQty: 120,
    plannedAllMonths: 95,
    seasonAmount: 240_000,
    plannedAllMonthsAmount: 190_000,
    seasonSales: 75,
    seasonSalesAmount: 150_000,
  };
  const original = { ...sources };
  const metrics = deriveTerritoryPlanMetrics(sources);

  assert.deepEqual(sources, original);
  assert.equal(Math.abs(metrics.remaining), Math.abs(sources.seasonQty - sources.plannedAllMonths));
  assert.equal(Math.abs(metrics.remainingAmount), Math.abs(sources.seasonAmount - sources.plannedAllMonthsAmount));
  assert.equal(Math.abs(metrics.pendingSales), Math.abs(sources.seasonQty - sources.seasonSales));
  assert.equal(Math.abs(metrics.pendingAmount), Math.abs(sources.seasonAmount - sources.seasonSalesAmount));
});

test("negative values are red candidates while positive and zero stay neutral", () => {
  assert.equal(isNegativeTerritoryPlanMetric(-1), true);
  assert.equal(isNegativeTerritoryPlanMetric(1), false);
  assert.equal(isNegativeTerritoryPlanMetric(0), false);
});

console.log(`\n${passed} Territory Plan metric tests passed.`);
