import "server-only";
import { SeasonStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { seasonSchema } from "@/lib/validations/assignments";
import { ApiError } from "@/lib/http";
import { getPlanningConfig } from "@/lib/planning-config";
import { generateSeasonMonths } from "@/lib/season-months";
import { canonicalSeasonName } from "@/lib/season-name";
import type { PlanningMode } from "@/lib/calc";

/**
 * Case-insensitive lookup of a season by (name, year). Season names are case-insensitive app-wide,
 * so "Kharif"/"KHARIF"/"kharif" for the same year all resolve to one season. Optionally excludes a
 * season id (used when renaming, so a season doesn't collide with itself).
 *
 * READ-ONLY: this only *finds* a season — it never renames or otherwise modifies existing rows.
 * Production may still contain historical case-duplicate rows (e.g. both "Kharif" and "KHARIF"); when
 * more than one variant matches, the EXACT canonical spelling is preferred (then the oldest), so a
 * variant like "kharif" deterministically resolves to the canonical "Kharif" rather than a stray dup.
 */
async function findSeasonByName(name: string, year: number, excludeId?: string): Promise<{ id: string; name: string } | null> {
  const matches = (await prisma.season.findMany({
    where: {
      year,
      name: { equals: name, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; name: string }[];
  if (matches.length === 0) return null;
  return matches.find((m) => m.name === name) ?? matches[0];
}

/**
 * A season is "locked" once it holds any operational data — a Season Plan (draft or
 * beyond), monthly plans, actual sales, or approval history. In this model any
 * SeasonPlan implies all of those live underneath it, so the presence of a plan is
 * the lock. When locked, the period and planning modes can no longer be changed.
 */
async function seasonHasPlans(seasonId: string): Promise<boolean> {
  const count = await prisma.seasonPlan.count({ where: { seasonId } });
  return count > 0;
}

export async function listSeasons(search: string) {
  const seasons = await prisma.season.findMany({
    where: search ? { name: { contains: search, mode: "insensitive" } } : undefined,
    include: { months: { orderBy: { order: "asc" } }, _count: { select: { plans: true } } },
    orderBy: [{ year: "desc" }, { name: "asc" }],
  });
  return seasons.map((s) => ({
    id: s.id,
    name: s.name,
    year: s.year,
    startMonth: s.startMonth,
    startYear: s.startYear,
    endMonth: s.endMonth,
    endYear: s.endYear,
    status: s.status,
    seasonalMode: s.seasonalMode as PlanningMode,
    monthlyMode: s.monthlyMode as PlanningMode,
    months: s.months.map((m) => m.name),
    // Locked once any operational data (a Season Plan) exists.
    locked: s._count.plans > 0,
  }));
}

function periodFrom(raw: unknown) {
  const parsed = seasonSchema.parse(raw);
  const gen = generateSeasonMonths({
    startMonth: parsed.startMonth,
    startYear: parsed.startYear,
    endMonth: parsed.endMonth,
    endYear: parsed.endYear,
  });
  if (!gen.ok) throw new ApiError(422, gen.error ?? "Invalid season period");
  return { parsed, months: gen.months };
}

export async function createSeason(raw: unknown) {
  const { parsed, months } = periodFrom(raw);
  // Name is already canonical (schema transform); reject a case-insensitive duplicate up front so the
  // admin sees a clear message instead of a raw unique-constraint error.
  const dup = await findSeasonByName(parsed.name, parsed.startYear);
  if (dup) throw new ApiError(409, `A season "${parsed.name} ${parsed.startYear}" already exists.`);
  // The global Planning Configuration supplies DEFAULTS; the season captures its own
  // modes here and uses them for its entire life (independent of later default changes).
  const defaults = await getPlanningConfig();
  return prisma.season.create({
    data: {
      name: parsed.name,
      year: parsed.startYear, // label & unique key follow the start year
      startMonth: parsed.startMonth,
      startYear: parsed.startYear,
      endMonth: parsed.endMonth,
      endYear: parsed.endYear,
      seasonalMode: parsed.seasonalMode ?? defaults.seasonalMode,
      monthlyMode: parsed.monthlyMode ?? defaults.monthlyMode,
      // Open-Month (Section 42): the first month (order 1, derived from the period) starts OPEN;
      // the rest LOCKED — so a new season is immediately workable without manual setup.
      months: { create: months.map((m) => ({ name: m.name, order: m.order, status: m.order === 1 ? "OPEN" : "LOCKED" })) },
    },
  });
}

export interface SeasonPeriodInput {
  name: string;
  startMonth: number;
  startYear: number;
  endMonth: number;
  endYear: number;
}

/**
 * The single authoritative season create — find by (name, year) or create with generated
 * months + default planning modes. Reused by manual create and Company Onboarding, so
 * season-creation business logic lives in exactly one place.
 */
export async function findOrCreateSeason(input: SeasonPeriodInput): Promise<{ id: string; created: boolean }> {
  const name = canonicalSeasonName(input.name);
  const existing = await findSeasonByName(name, input.startYear);
  if (existing) {
    // Resolve to the EXISTING season and never modify it. Historical rows (including case-duplicates
    // like "KHARIF") are left exactly as they are — entering "kharif"/"KHARIF"/etc. simply maps to the
    // already-stored season. Canonicalisation applies only to NEWLY created seasons (below).
    return { id: existing.id, created: false };
  }

  const gen = generateSeasonMonths({
    startMonth: input.startMonth,
    startYear: input.startYear,
    endMonth: input.endMonth,
    endYear: input.endYear,
  });
  if (!gen.ok) throw new ApiError(422, gen.error ?? "Invalid season period");
  const defaults = await getPlanningConfig();
  const s = await prisma.season.create({
    data: {
      name,
      year: input.startYear,
      startMonth: input.startMonth,
      startYear: input.startYear,
      endMonth: input.endMonth,
      endYear: input.endYear,
      seasonalMode: defaults.seasonalMode,
      monthlyMode: defaults.monthlyMode,
      // Open-Month (Section 42): first month OPEN, rest LOCKED (derived from the period).
      months: { create: gen.months.map((m) => ({ name: m.name, order: m.order, status: m.order === 1 ? "OPEN" : "LOCKED" })) },
    },
  });
  return { id: s.id, created: true };
}

export async function setSeasonStatus(id: string, status: SeasonStatus) {
  const season = await prisma.season.findUnique({ where: { id } });
  if (!season) throw new ApiError(404, "Season not found");
  return prisma.season.update({ where: { id }, data: { status } });
}

export async function updateSeason(id: string, raw: unknown) {
  const season = await prisma.season.findUnique({ where: { id } });
  if (!season) throw new ApiError(404, "Season not found");

  const locked = await seasonHasPlans(id);
  const { parsed, months } = periodFrom(raw);

  // Reject a rename that would collide (case-insensitively) with a different season in the same year.
  const clash = await findSeasonByName(parsed.name, parsed.startYear, id);
  if (clash) throw new ApiError(409, `A season "${parsed.name} ${parsed.startYear}" already exists.`);

  if (locked) {
    // Period and planning modes are frozen once operational data exists; allow only a
    // name correction, never a change that would invalidate existing plans/reports.
    if (
      parsed.startMonth !== season.startMonth ||
      parsed.startYear !== season.startYear ||
      parsed.endMonth !== season.endMonth ||
      parsed.endYear !== season.endYear ||
      (parsed.seasonalMode && parsed.seasonalMode !== season.seasonalMode) ||
      (parsed.monthlyMode && parsed.monthlyMode !== season.monthlyMode)
    ) {
      throw new ApiError(
        409,
        "This season already contains planning data; its period and planning modes can no longer be changed.",
      );
    }
    return prisma.season.update({ where: { id }, data: { name: parsed.name } });
  }

  // Unlocked: fully editable — regenerate the SeasonMonth rows from the new period.
  return prisma.$transaction(async (tx) => {
    await tx.seasonMonth.deleteMany({ where: { seasonId: id } });
    return tx.season.update({
      where: { id },
      data: {
        name: parsed.name,
        year: parsed.startYear,
        startMonth: parsed.startMonth,
        startYear: parsed.startYear,
        endMonth: parsed.endMonth,
        endYear: parsed.endYear,
        seasonalMode: parsed.seasonalMode ?? season.seasonalMode,
        monthlyMode: parsed.monthlyMode ?? season.monthlyMode,
        months: { create: months.map((m) => ({ name: m.name, order: m.order })) },
      },
    });
  });
}
