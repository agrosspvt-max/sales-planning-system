/** The shared DD/MM/YYYY display rule: calendar dates never shift, timestamps use the business time zone, the result never depends on the process / browser locale. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { formatDMY, formatDateTimeDMY, isoDateToDMY, localizeDatesInText, monthEndIso } from "./date-format";
import { formatDate, formatDateShort } from "./utils";

const cases = (): unknown[] => [
  formatDMY("2026-02-04"),                         // date-only text: re-ordered, never parsed
  formatDMY("2026-10-14T00:00:00"),                // wall-clock text of a calendar date
  formatDMY(new Date("2026-10-14T00:00:00Z")),     // a @db.Date value (UTC midnight)
  formatDMY("2026-10-14T00:00:00.000Z"),
  formatDMY("2026-10-13T20:30:00.000Z"),           // 14 Oct 02:00 in India → the BUSINESS date is 14/10/2026
  formatDMY("2028-02-29"),
  formatDateTimeDMY("2026-10-14T10:15:00.000Z"),   // 3:45 pm IST
  formatDateTimeDMY("2026-10-13T20:30:00.000Z"),
  formatDate("2026-12-31"), formatDateShort("2026-01-05"),
];
if (process.env.DATE_FORMAT_CHILD) { console.log(JSON.stringify(cases())); process.exit(0); }

const expected = ["04/02/2026", "14/10/2026", "14/10/2026", "14/10/2026", "14/10/2026", "29/02/2028", "14/10/2026, 3:45 pm", "14/10/2026, 2:00 am", "31/12/2026", "05/01/2026"];
assert.deepEqual(cases(), expected);
// the same output under very different process time zones and locales (the way a browser's own locale / zone must never matter)
for (const [tz, lang] of [["America/Los_Angeles", "en_US.UTF-8"], ["Pacific/Kiritimati", "de_DE.UTF-8"], ["Asia/Kolkata", "ja_JP.UTF-8"], ["UTC", "en_US.UTF-8"]]) {
  const out = execFileSync(process.execPath, ["--import", "tsx", "src/lib/date-format.test.ts"], { env: { ...process.env, DATE_FORMAT_CHILD: "1", TZ: tz, LANG: lang, LC_ALL: lang }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), expected, `${tz} / ${lang}`);
}
// blanks, invalid input, impossible dates
assert.deepEqual([formatDMY(null), formatDMY(undefined), formatDMY(""), formatDMY("not a date"), formatDMY("2026-02-31"), formatDateTimeDMY(null)], ["—", "—", "—", "—", "—", "—"]);
assert.equal(isoDateToDMY("2026-02-29"), "", "2026 is not a leap year"); assert.equal(isoDateToDMY("2028-02-29"), "29/02/2028");
// text from the server: ISO dates become DD/MM/YYYY, everything else is left alone
assert.equal(localizeDatesInText("Billing Exception · promised 2026-10-20 · Days 104 · request 2026-13-45 · v2026-10-20x"), "Billing Exception · promised 20/10/2026 · Days 104 · request 2026-13-45 · v2026-10-20x");
assert.equal(localizeDatesInText(null), ""); assert.equal(localizeDatesInText("no dates here 12/2026"), "no dates here 12/2026");
assert.deepEqual(["2026-02", "2028-02", "2026-04", "2026-12", "bad"].map(monthEndIso), ["2026-02-28", "2028-02-29", "2026-04-30", "2026-12-31", ""]);
console.log("date-format.test.ts — all assertions passed");
