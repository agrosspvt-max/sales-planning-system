import "server-only";
import { prisma } from "@/lib/prisma";
import { listSeasons } from "@/features/seasons/service.server";
import { SEASON_MONTH_ORDER, calendarPeriod, identity, monthLabel } from "@/lib/season-calendar";
import { formatPeriod } from "@/lib/season-months";
import { monthKey } from "@/lib/monthly-plan";

/**
 * Party Planning's one view of a Sales Planning Season: its name, status, period text (exactly what the Seasons page shows) and its months in
 * CALENDAR order (SEASON_MONTH_ORDER — never the creation-order `order`). Seasons are always chosen explicitly; nothing here looks at "today".
 */
export interface MonthOption { id: string; name: string; label: string; key: string }
export interface SeasonInfo { id: string; name: string; year: number; status: string; period: string | null; months: MonthOption[] }

export async function getSeasonInfo(seasonId: string): Promise<SeasonInfo | null> {
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { id: true, name: true, year: true, status: true, startMonth: true, startYear: true, endMonth: true, endYear: true } });
  if (!season) return null;
  const rows = await prisma.seasonMonth.findMany({ where: { seasonId }, orderBy: SEASON_MONTH_ORDER, select: { id: true, name: true, calendarMonth: true, calendarYear: true } });
  const ids = rows.map((m) => identity(m));
  const effective = rows.length > 0 && ids.every((m) => m) ? calendarPeriod(ids.map((m) => m!)) : null;
  const period = formatPeriod(effective?.startMonth ?? season.startMonth, effective?.startYear ?? season.startYear, effective?.endMonth ?? season.endMonth, effective?.endYear ?? season.endYear) || null;
  return {
    id: season.id, name: season.name, year: season.year, status: season.status, period,
    months: rows.filter((m) => identity(m)).map((m) => ({ id: m.id, name: m.name, label: monthLabel(m), key: monthKey(m)! })),
  };
}

/** Every OPEN season, by the Seasons module's own rule (`listSeasons(…, activeOnly)` = status OPEN) — the choices for "Create". */
export async function listOpenSeasonInfos(): Promise<SeasonInfo[]> {
  const open = await listSeasons("", true);
  const infos = await Promise.all(open.map((s) => getSeasonInfo(s.id)));
  return infos.filter((s): s is SeasonInfo => s != null && s.status === "OPEN");
}

export async function isSeasonOpen(seasonId: string): Promise<boolean> {
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { status: true } });
  return season?.status === "OPEN";
}
