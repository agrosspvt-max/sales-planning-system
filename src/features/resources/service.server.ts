import "server-only";
import { z, type ZodTypeAny } from "zod";
import bcrypt from "bcryptjs";
import { Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildPage, type PageParams, type Paginated } from "@/lib/pagination";
import type { Resource } from "@/lib/rbac";
import { announcementRecipientIds, notifyMany } from "@/features/notifications/service.server";
import { categoryIdForNbv, resyncAllProductCategories } from "@/features/products/categories.server";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ServerResource {
  model: string;
  searchFields: string[];
  orderBy: Record<string, "asc" | "desc">;
  softDelete: boolean;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  transform?: (data: any, mode: "create" | "update") => Promise<any> | any;
  afterCreate?: (id: string) => Promise<void>;
  afterUpdate?: (id: string) => Promise<void>;
  afterSetActive?: (id: string, isActive: boolean) => Promise<void>;
}

const optionalString = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.string().nullable(),
);

// Switch fields arrive from the form as the strings "true"/"false"; omit → leave unchanged.
const optionalBool = z.preprocess(
  (v) => (v === undefined ? undefined : v === true || v === "true"),
  z.boolean().optional(),
);

const roleEnum = z.nativeEnum(Role);

const SERVER: Partial<Record<Resource, ServerResource>> = {
  categories: {
    model: "category",
    searchFields: ["name", "notation"],
    orderBy: { name: "asc" },
    softDelete: true,
    // NBV% arrives from the form as a PERCENT (35) and is stored as a fraction (0.35) to match Product.nbvPercent.
    createSchema: z.object({ name: z.string().min(1), nbvPercent: z.coerce.number().min(0), notation: optionalString, color: optionalString }),
    updateSchema: z.object({ name: z.string().min(1), nbvPercent: z.coerce.number().min(0), notation: optionalString, color: optionalString }),
    transform: (data) => ({ ...data, nbvPercent: data.nbvPercent / 100 }),
    // Any category mutation re-derives every product's category from its NBV% (auto-mapping).
    afterCreate: resyncAllProductCategories,
    afterUpdate: resyncAllProductCategories,
    afterSetActive: resyncAllProductCategories,
  },
  brands: {
    model: "brand",
    searchFields: ["name"],
    orderBy: { name: "asc" },
    softDelete: true,
    createSchema: z.object({ name: z.string().min(1) }),
    updateSchema: z.object({ name: z.string().min(1) }),
  },
  packSizes: {
    model: "packSize",
    searchFields: ["name"],
    orderBy: { displayOrder: "asc" },
    softDelete: true,
    createSchema: z.object({ name: z.string().min(1), displayOrder: z.coerce.number().int().min(0), isPlanning: optionalBool }),
    updateSchema: z.object({ name: z.string().min(1), displayOrder: z.coerce.number().int().min(0), isPlanning: optionalBool }),
  },
  products: {
    model: "product",
    searchFields: ["name", "technicalName"],
    orderBy: { name: "asc" },
    softDelete: true,
    // categoryId/brandId are NOT form fields: category is auto-derived from NBV% (below); brandId is left
    // untouched on update (not in the payload) so existing Brand links / Reports are preserved.
    createSchema: z.object({
      name: z.string().min(1),
      canonicalName: optionalString, // Tally/Sales-Upload matching only
      technicalName: optionalString,
      rate: z.coerce.number().min(0),
      nbvPercent: z.coerce.number().min(0),
    }),
    updateSchema: z.object({
      name: z.string().min(1),
      canonicalName: optionalString, // Tally/Sales-Upload matching only
      technicalName: optionalString,
      rate: z.coerce.number().min(0),
      nbvPercent: z.coerce.number().min(0),
    }),
    // Auto-place the product in the category matching its NBV% (fraction). No manual mapping.
    transform: async (data) => ({ ...data, categoryId: await categoryIdForNbv(data.nbvPercent) }),
  },
  dealers: {
    model: "dealer",
    searchFields: ["name", "town"],
    orderBy: { name: "asc" },
    softDelete: true,
    createSchema: z.object({ name: z.string().min(1), town: optionalString }),
    updateSchema: z.object({ name: z.string().min(1), town: optionalString }),
  },
  users: {
    model: "user",
    searchFields: ["name", "username"],
    orderBy: { name: "asc" },
    softDelete: true,
    createSchema: z.object({
      name: z.string().min(1),
      username: z.string().min(3),
      password: z.string().min(6),
      role: roleEnum,
    }),
    updateSchema: z.object({
      name: z.string().min(1),
      username: z.string().min(3),
      role: roleEnum,
    }),
    transform: async (data, mode) => {
      if (mode === "create") {
        const { password, ...rest } = data;
        return { ...rest, passwordHash: await bcrypt.hash(password, 10) };
      }
      return data;
    },
  },
  announcements: {
    model: "announcement",
    searchFields: ["title", "body"],
    orderBy: { createdAt: "desc" },
    softDelete: true,
    afterCreate: async (id: string) => {
      const a = await prisma.announcement.findUnique({ where: { id } });
      if (!a) return;
      const recipients = await announcementRecipientIds({
        targetUserId: a.targetUserId,
        audienceRole: a.audienceRole,
      });
      await notifyMany(recipients, {
        type: NotificationType.ANNOUNCEMENT,
        title: "New announcement",
        message: a.title,
        relatedEntityType: "Announcement",
        relatedEntityId: a.id,
      });
    },
    createSchema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      audienceRole: z.preprocess(
        (v) => (v === "" || v === undefined ? null : v),
        roleEnum.nullable(),
      ),
    }),
    updateSchema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      audienceRole: z.preprocess(
        (v) => (v === "" || v === undefined ? null : v),
        roleEnum.nullable(),
      ),
    }),
  },
  settings: {
    model: "systemSetting",
    searchFields: ["key", "value"],
    orderBy: { key: "asc" },
    softDelete: false,
    createSchema: z.object({ key: z.string().min(1), value: z.string().min(1) }),
    updateSchema: z.object({ key: z.string().min(1), value: z.string().min(1) }),
  },
};

export function getServerResource(key: Resource): ServerResource {
  const r = SERVER[key];
  if (!r) throw new Error(`Unknown resource: ${key}`);
  return r;
}

function delegate(model: string) {
  return (prisma as any)[model];
}

function buildWhere(r: ServerResource, search: string) {
  if (!search) return {};
  return {
    OR: r.searchFields.map((f) => ({ [f]: { contains: search, mode: "insensitive" } })),
  };
}

export async function listResource(
  key: Resource,
  params: PageParams,
): Promise<Paginated<unknown>> {
  const r = getServerResource(key);
  const where = buildWhere(r, params.search);
  const [items, total] = await Promise.all([
    delegate(r.model).findMany({
      where,
      orderBy: r.orderBy,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    delegate(r.model).count({ where }),
  ]);
  return buildPage(items, total, params);
}

export async function getResource(key: Resource, id: string): Promise<unknown> {
  const r = getServerResource(key);
  return delegate(r.model).findUnique({ where: { id } });
}

export async function createResource(key: Resource, raw: unknown): Promise<{ id: string }> {
  const r = getServerResource(key);
  const parsed = r.createSchema.parse(raw);
  const data = r.transform ? await r.transform(parsed, "create") : parsed;
  const created = await delegate(r.model).create({ data });
  if (r.afterCreate) await r.afterCreate(created.id);
  return { id: created.id };
}

export async function updateResource(
  key: Resource,
  id: string,
  raw: unknown,
): Promise<{ id: string }> {
  const r = getServerResource(key);
  const parsed = r.updateSchema.parse(raw);
  const data = r.transform ? await r.transform(parsed, "update") : parsed;
  const updated = await delegate(r.model).update({ where: { id }, data });
  if (r.afterUpdate) await r.afterUpdate(updated.id);
  return { id: updated.id };
}

export async function setResourceActive(
  key: Resource,
  id: string,
  isActive: boolean,
): Promise<void> {
  const r = getServerResource(key);
  if (!r.softDelete) {
    // Hard delete only for records without a soft-delete flag (e.g. settings).
    await delegate(r.model).delete({ where: { id } });
    return;
  }
  await delegate(r.model).update({ where: { id }, data: { isActive } });
  if (r.afterSetActive) await r.afterSetActive(id, isActive);
}

export async function loadOptions(): Promise<Record<string, { value: string; label: string }[]>> {
  const [categories, brands] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.brand.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const roleOptions = [
    { value: Role.SUPER_ADMIN, label: "Super Admin" },
    { value: Role.REGIONAL_MANAGER, label: "Regional Manager" },
    { value: Role.SALES_OFFICER, label: "Sales Officer" },
  ];
  return {
    categories: categories.map((c) => ({ value: c.id, label: c.name })),
    brands: brands.map((b) => ({ value: b.id, label: b.name })),
    roles: roleOptions,
    rolesOptional: roleOptions,
  };
}
