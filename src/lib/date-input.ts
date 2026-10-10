/**
 * DD/MM/YYYY display helpers for date inputs. Pure string handling — no `Date` objects, so there is no time-zone shift: the internal value stays
 * the ISO `YYYY-MM-DD` key the APIs already use, and only what the user SEES and TYPES is DD/MM/YYYY.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (y: number, m: number): number => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
/** True for a real calendar date (rejects 31/02, 00/05, month 13, year 0000…). */
export function isRealDate(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}
/** "2026-10-09" → "09/10/2026" ("" for anything that is not a real ISO date). */
export function isoToDisplay(iso: string): string {
  const m = ISO.exec(iso);
  return m && isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
/** "09/10/2026" → "2026-10-09"; null unless the text is a complete, real DD/MM/YYYY date. */
export function displayToIso(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  return m && isRealDate(Number(m[3]), Number(m[2]), Number(m[1])) ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
/** What a user has typed → the masked draft: digits only (max 8), with the slashes inserted as they go ("0910" → "09/10"). */
export function maskDisplayInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return digits.length <= 2 ? digits : digits.length <= 4 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
