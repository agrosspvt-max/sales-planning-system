import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { DEFAULT_LABELS } from "./labels";

/**
 * Label overrides are persisted as ONE JSON row in the existing SystemSetting key/value store (no new
 * table). Only Super Admin may write. Only known label keys are accepted — never arbitrary data.
 */
const SETTING_KEY = "labelOverrides";
const LABEL_CACHE_TTL_MS = Number(process.env.LABEL_SETTING_CACHE_TTL_MS ?? 10_000);
let overrideCache: { value: Record<string, string>; expiresAt: number } | null = null;
let overrideLookup: Promise<Record<string, string>> | null = null;

function rememberOverrides(value: Record<string, string>) {
  overrideCache = { value: { ...value }, expiresAt: Date.now() + Math.max(0, LABEL_CACHE_TTL_MS) };
  return { ...value };
}

async function readOverrides(): Promise<Record<string, string>> {
  if (overrideCache && overrideCache.expiresAt > Date.now()) return { ...overrideCache.value };
  if (overrideLookup) return overrideLookup.then((value) => ({ ...value }));
  overrideLookup = prisma.systemSetting.findUnique({ where: { key: SETTING_KEY }, select: { value: true } }).then((row) => {
    if (!row) return rememberOverrides({});
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed && typeof parsed === "object") {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (k in DEFAULT_LABELS && typeof v === "string") out[k] = v;
        return rememberOverrides(out);
      }
    } catch {
      /* corrupt value → treat as no overrides */
    }
    return rememberOverrides({});
  });
  try {
    return await overrideLookup;
  } finally {
    overrideLookup = null;
  }
}

/** Overrides + whether the caller may edit them (Super Admin only). */
export async function getLabelState(ctx: AuthContext): Promise<{ overrides: Record<string, string>; canEdit: boolean }> {
  return { overrides: await readOverrides(), canEdit: ctx.role === Role.SUPER_ADMIN };
}

const patchSchema = z.object({
  key: z.string().min(1),
  // Empty string clears the override (revert to default).
  value: z.string().max(120),
});

/** Set or clear ONE label override (Super Admin only). Returns the full override map. */
export async function setLabelOverride(ctx: AuthContext, raw: unknown): Promise<Record<string, string>> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can edit labels");
  const { key, value } = patchSchema.parse(raw);
  if (!(key in DEFAULT_LABELS)) throw new ApiError(422, "Unknown label key");

  const overrides = await readOverrides();
  const trimmed = value.trim();
  if (!trimmed || trimmed === (DEFAULT_LABELS as Record<string, string>)[key]) delete overrides[key];
  else overrides[key] = trimmed;

  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(overrides) },
    update: { value: JSON.stringify(overrides) },
  });
  return rememberOverrides(overrides);
}
