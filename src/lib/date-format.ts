/**
 * THE shared rule for every date a user SEES: DD/MM/YYYY (04/02/2026 is 4 February), whatever the browser or device locale.
 *  • A date-only value ("YYYY-MM-DD", or a UTC-midnight Date from a @db.Date column) is a CALENDAR date: it is re-ordered as text / read in UTC, so no time-zone can move it a day.
 *  • A timestamp (an instant) is shown in the application's business time zone (India, Asia/Kolkata), the same zone Daily Work's business date uses; the time-of-day
 *    display ("3:45 pm") is unchanged — only its date part is standardized.
 * The locale used is fixed in code (never the browser's), and the parts are assembled by hand. Display only: stored values, API payloads and ISO keys are untouched.
 */
export const BUSINESS_TIME_ZONE = "Asia/Kolkata";
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "2026-10-14T00:00:00" (no zone) is a local wall-clock text of a calendar date; one with Z / an offset is an instant.
const NAIVE_ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const pad2 = (n: number | string) => String(n).padStart(2, "0");

const dateParts = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { timeZone: BUSINESS_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true });

function toInstant(value: Date | string): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function businessDateOf(d: Date): string {
  const p = Object.fromEntries(dateParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}
/** "2026-10-14" → "14/10/2026" (pure text: no Date, no time zone). "" for anything that is not a real calendar date. */
export function isoDateToDMY(iso: string): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
/** Any date value → DD/MM/YYYY, or "—" when empty / unreadable. */
export function formatDMY(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") {
    const trimmed = value.trim();
    const plain = ISO_DATE.test(trimmed) ? isoDateToDMY(trimmed) : "";
    if (plain) return plain;
    if (ISO_DATE.test(trimmed)) return "—"; // date-shaped but not a real day (2026-02-31): never let Date roll it into March
    const naive = NAIVE_ISO_DATETIME.exec(trimmed);
    if (naive) return isoDateToDMY(`${naive[1]}-${naive[2]}-${naive[3]}`) || "—"; // wall-clock text of a calendar date: keep its own day
    const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (dmy) return trimmed; // already in the display format
  }
  const instant = toInstant(value);
  return instant ? businessDateOf(instant) : "—";
}
/** A timestamp → "DD/MM/YYYY, 3:45 pm" (business time zone; the time display is the existing one). */
export function formatDateTimeDMY(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const instant = toInstant(value);
  return instant ? `${businessDateOf(instant)}, ${timeFormat.format(instant)}` : "—";
}
/** Replace ISO calendar dates inside application-generated text ("promised 2026-10-20") with DD/MM/YYYY — for audit summaries, notifications and messages. */
export function localizeDatesInText(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole) => isoDateToDMY(whole) || whole);
}
/** Last day of a month as ISO ("2026-02" → "2026-02-28") — for max limits on date fields (never an impossible "2026-02-31"). */
export function monthEndIso(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return "";
  return `${monthKey}-${String(new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate()).padStart(2, "0")}`;
}
