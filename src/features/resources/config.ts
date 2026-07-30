import type { Resource } from "@/lib/rbac";

/** Field types the generic form knows how to render. */
export type FieldType = "text" | "number" | "textarea" | "select" | "switch" | "password";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** For selects: key used to look up options from the options endpoint. */
  optionsKey?: string;
  /** Only shown/used when creating (e.g. password). */
  createOnly?: boolean;
  helpText?: string;
  step?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  /** Optional formatter name resolved on the client. */
  format?: "currency" | "percent" | "date" | "boolean" | "role";
}

/**
 * Makes a list cell a link to an analytical profile page (Sales Officer / Dealer
 * dashboard). Declarative so the generic list component stays data-driven.
 */
export interface ProfileLinkConfig {
  base: string; // e.g. "/masters/users" — the row id is appended
  column: string; // which column becomes the link (e.g. "name")
  onlyWhen?: { field: string; equals: string }; // e.g. only for role === "SALES_OFFICER"
}

export interface ResourceClientConfig {
  key: Resource;
  label: string; // plural, e.g. "Products"
  singular: string; // e.g. "Product"
  softDelete: boolean;
  searchPlaceholder: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  profile?: ProfileLinkConfig;
}

/**
 * Client-safe resource definitions (serializable). The generic list and form
 * components are driven entirely by these. Server-only concerns (Prisma model,
 * Zod schemas, transforms) live in `service.server.ts`.
 */
export const RESOURCE_CONFIG: Partial<Record<Resource, ResourceClientConfig>> = {
  categories: {
    key: "categories",
    label: "Categories",
    singular: "Category",
    softDelete: true,
    searchPlaceholder: "Search categories…",
    columns: [
      { key: "name", label: "Name" },
      { key: "isActive", label: "Active", format: "boolean" },
      { key: "createdAt", label: "Created", format: "date" },
    ],
    fields: [{ name: "name", label: "Name", type: "text", required: true }],
  },
  brands: {
    key: "brands",
    label: "Brands",
    singular: "Brand",
    softDelete: true,
    searchPlaceholder: "Search brands…",
    columns: [
      { key: "name", label: "Name" },
      { key: "isActive", label: "Active", format: "boolean" },
      { key: "createdAt", label: "Created", format: "date" },
    ],
    fields: [{ name: "name", label: "Name", type: "text", required: true }],
  },
  packSizes: {
    key: "packSizes",
    label: "Pack Sizes",
    singular: "Pack Size",
    softDelete: true,
    searchPlaceholder: "Search pack sizes…",
    columns: [
      { key: "name", label: "Name" },
      { key: "displayOrder", label: "Order" },
      { key: "isPlanning", label: "Planning", format: "boolean" },
      { key: "isActive", label: "Active", format: "boolean" },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      {
        name: "displayOrder",
        label: "Display order",
        type: "number",
        required: true,
        step: "1",
        helpText: "Controls the column order in the planning grid.",
      },
      {
        name: "isPlanning",
        label: "Planning pack",
        type: "switch",
        helpText:
          "Appears as a column in NEW plans. Independent of Active. Turning this off never hides or removes quantities already stored in existing plans.",
      },
    ],
  },
  products: {
    key: "products",
    label: "Products",
    singular: "Product",
    softDelete: true,
    searchPlaceholder: "Search products…",
    columns: [
      { key: "name", label: "Name" },
      { key: "technicalName", label: "Technical Name" },
      { key: "rate", label: "Rate", format: "currency" },
      { key: "nbvPercent", label: "NBV %", format: "percent" },
      { key: "isActive", label: "Active", format: "boolean" },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "technicalName", label: "Technical Name", type: "text" },
      { name: "rate", label: "Rate (₹)", type: "number", required: true, step: "0.01" },
      {
        name: "nbvPercent",
        label: "NBV fraction",
        type: "number",
        required: true,
        step: "0.0001",
        helpText: "Stored as a fraction — 0.25 means 25%.",
      },
      { name: "categoryId", label: "Category", type: "select", optionsKey: "categories" },
      { name: "brandId", label: "Brand", type: "select", optionsKey: "brands" },
    ],
  },
  dealers: {
    key: "dealers",
    label: "Dealers",
    singular: "Dealer",
    softDelete: true,
    searchPlaceholder: "Search dealers…",
    // Dealer rows open the analytical Dealer Profile (not the edit form).
    profile: { base: "/masters/dealers", column: "name" },
    columns: [
      { key: "name", label: "Name" },
      { key: "town", label: "Town" },
      { key: "isActive", label: "Active", format: "boolean" },
      { key: "createdAt", label: "Created", format: "date" },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "town", label: "Town", type: "text" },
    ],
  },
  users: {
    key: "users",
    label: "Users",
    singular: "User",
    softDelete: true,
    searchPlaceholder: "Search users…",
    // Sales Officer rows open the analytical Sales Officer Dashboard (not the edit form).
    profile: { base: "/masters/users", column: "name", onlyWhen: { field: "role", equals: "SALES_OFFICER" } },
    columns: [
      { key: "name", label: "Name" },
      { key: "username", label: "Username" },
      { key: "role", label: "Role", format: "role" },
      { key: "isActive", label: "Active", format: "boolean" },
    ],
    fields: [
      { name: "name", label: "Full Name", type: "text", required: true },
      { name: "username", label: "Username", type: "text", required: true },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: true,
        createOnly: true,
        helpText: "Set once on creation. Password changes are out of scope for Phase 1.",
      },
      { name: "role", label: "Role", type: "select", required: true, optionsKey: "roles" },
    ],
  },
  announcements: {
    key: "announcements",
    label: "Announcements",
    singular: "Announcement",
    softDelete: true,
    searchPlaceholder: "Search announcements…",
    columns: [
      { key: "title", label: "Title" },
      { key: "audienceRole", label: "Audience", format: "role" },
      { key: "isActive", label: "Active", format: "boolean" },
      { key: "createdAt", label: "Created", format: "date" },
    ],
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "body", label: "Body", type: "textarea", required: true },
      {
        name: "audienceRole",
        label: "Audience Role",
        type: "select",
        optionsKey: "rolesOptional",
        helpText: "Leave blank to target all roles.",
      },
    ],
  },
  settings: {
    key: "settings",
    label: "System Settings",
    singular: "Setting",
    softDelete: false,
    searchPlaceholder: "Search settings…",
    columns: [
      { key: "key", label: "Key" },
      { key: "value", label: "Value" },
      { key: "updatedAt", label: "Updated", format: "date" },
    ],
    fields: [
      { name: "key", label: "Key", type: "text", required: true },
      { name: "value", label: "Value", type: "text", required: true },
    ],
  },
};

export function getResourceConfig(key: string): ResourceClientConfig | undefined {
  return RESOURCE_CONFIG[key as Resource];
}
