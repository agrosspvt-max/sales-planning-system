export interface TerritoryPlanMetricSources {
  seasonQty: number;
  plannedAllMonths: number;
  seasonAmount: number;
  plannedAllMonthsAmount: number;
  seasonSales: number;
  seasonSalesAmount: number;
}

export interface TerritoryPlanDerivedMetrics {
  remaining: number;
  remainingAmount: number;
  pendingSales: number;
  pendingAmount: number;
}

/**
 * Territory Plan uses the operational monthly/sales position minus the seasonal baseline.
 * This signed direction is specific to the four Territory Plan comparison columns.
 */
export function deriveTerritoryPlanMetrics(sources: TerritoryPlanMetricSources): TerritoryPlanDerivedMetrics {
  return {
    remaining: sources.plannedAllMonths - sources.seasonQty,
    remainingAmount: sources.plannedAllMonthsAmount - sources.seasonAmount,
    pendingSales: sources.seasonSales - sources.seasonQty,
    pendingAmount: sources.seasonSalesAmount - sources.seasonAmount,
  };
}

/** Negative Territory Plan comparison values use the existing destructive/red presentation. */
export function isNegativeTerritoryPlanMetric(value: number): boolean {
  return value < 0;
}
