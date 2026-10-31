/** Inclusive calendar months; each month remains an independent complete snapshot. */
export function salesMonths(fromMonth: string, toMonth: string, today: string) {
  const valid = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (
    !valid(fromMonth) ||
    !valid(toMonth) ||
    fromMonth > toMonth ||
    fromMonth < "2026-04" ||
    toMonth > "2027-03" ||
    toMonth > today.slice(0, 7)
  )
    throw new Error("Choose a From/To month range within April 2026 and the current month");
  const months: string[] = [];
  let cursor = fromMonth;
  while (cursor <= toMonth) {
    months.push(cursor);
    const next = new Date(Date.UTC(+cursor.slice(0, 4), +cursor.slice(5, 7), 1));
    cursor = next.toISOString().slice(0, 7);
  }
  return months;
}
