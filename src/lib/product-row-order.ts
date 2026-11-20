const alphabet = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Business figures only: prices, NBV percentages, IDs and flags are not planning/sales activity. */
export function hasPlanningFigures(...values: (number | null | undefined)[]): boolean {
  return values.some((value) => value != null && value !== 0);
}

/** Independent alphabetical groups; never mutate the source or change figures used by totals. */
export function partitionProductRows<T>(rows: readonly T[], nameOf: (row: T) => string, idOf: (row: T) => string, hasValues: (row: T) => boolean) {
  const active: T[] = [], empty: T[] = [];
  const compare = (a: T, b: T) => alphabet.compare(nameOf(a).trim(), nameOf(b).trim()) || alphabet.compare(idOf(a), idOf(b));
  for (const row of rows) (hasValues(row) ? active : empty).push(row);
  active.sort(compare);
  empty.sort(compare);
  return { active, empty };
}
