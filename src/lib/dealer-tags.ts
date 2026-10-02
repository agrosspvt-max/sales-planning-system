/** Display-only metadata. Neither names nor business identity include marker text. */
export interface DealerMarker {
  id: string;
  name: string;
  markerType: "TEXT" | "SYMBOL";
  marker: string;
}
export type DealerMarkerMap = Readonly<Record<string, readonly DealerMarker[]>>;

/** Stable partition: callers first apply their own sort. This never ranks tags against each other. */
export function taggedDealersFirst<T>(
  rows: readonly T[],
  getId: (row: T) => string | null | undefined,
  tags: DealerMarkerMap,
): T[] {
  const tagged: T[] = [],
    plain: T[] = [];
  for (const row of rows) ((tags[getId(row) ?? ""]?.length ?? 0) > 0 ? tagged : plain).push(row);
  return [...tagged, ...plain];
}

/** Reorder only dealer slots, preserving summary rows, totals, notes and other non-dealer elements. */
export function groupDealerSlots<T>(
  rows: readonly T[],
  getId: (row: T) => string | null | undefined,
  tags: DealerMarkerMap,
): T[] {
  const sorted = taggedDealersFirst(
    rows.filter((row) => !!getId(row)),
    getId,
    tags,
  );
  let i = 0;
  return rows.map((row) => (getId(row) ? sorted[i++] : row));
}
