import { Role } from "@prisma/client";
import {
  LayoutDashboard,
  Package,
  Tags,
  Ruler,
  Store,
  Users,
  CalendarRange,
  Megaphone,
  Settings,
  Link2,
  Network,
  ClipboardList,
  CheckSquare,
  BarChart3,
  ScrollText,
  FileUp,
  FileSpreadsheet,
  History,
  SlidersHorizontal,
  FilePlus2,
  FileInput,
  Rocket,
  Upload,
  PackageCheck,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: Role[];
  group?: string;
  /** Optional nested items — renders the item as an expandable parent (a toggle, not a link). */
  children?: NavItem[];
}

const ADMIN_ONLY = [Role.SUPER_ADMIN];
const ALL_ROLES = [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER, Role.SALES_OFFICER];

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ALL_ROLES },
  { label: "Company Onboarding", href: "/onboarding", icon: Rocket, roles: ADMIN_ONLY, group: "Setup" },
  { label: "Onboarding History", href: "/onboarding/history", icon: History, roles: ADMIN_ONLY, group: "Setup" },

  // Planning is organised around the business lifecycle: Create Plan (work-in-progress /
  // drafts) and View Plans (approved). Recovery/Scheme/Party are selectable MODULES inside
  // those two workspaces (module cards), not sidebar items. Import + Approvals are
  // independent workflows and stay as their own entries.
  { label: "Create New Plan", href: "/planning/create", icon: FilePlus2, roles: ALL_ROLES, group: "Planning" },
  { label: "View Approved Plans", href: "/planning/view", icon: ClipboardList, roles: ALL_ROLES, group: "Planning" },
  {
    label: "Import Seasonal Plan",
    href: "/planning/sales/import",
    icon: FileInput,
    roles: ADMIN_ONLY,
    group: "Planning",
  },
  { label: "Sales Upload", href: "/planning/sales-upload", icon: Upload, roles: ADMIN_ONLY, group: "Planning" },
  { label: "Dealer Alias", href: "/planning/dealer-alias", icon: Link2, roles: ADMIN_ONLY, group: "Planning" },
  {
    label: "Approvals",
    href: "/planning/approvals",
    icon: CheckSquare,
    roles: [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER],
    group: "Planning",
  },
  { label: "My Account", href: "/account", icon: Users, roles: ALL_ROLES, group: "Insights" },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: ALL_ROLES, group: "Insights" },
  { label: "Announcements", href: "/announcements", icon: Megaphone, roles: ALL_ROLES, group: "Insights" },
  {
    label: "Audit Logs",
    href: "/audit",
    icon: ScrollText,
    roles: [Role.SUPER_ADMIN],
    group: "Insights",
  },

  {
    label: "Products and Catalogues",
    href: "/masters/products",
    icon: Package,
    roles: ADMIN_ONLY,
    group: "Master Data",
    children: [
      { label: "Product Master", href: "/masters/products", icon: Package, roles: ADMIN_ONLY, group: "Master Data" },
      { label: "State Catalogue", href: "/masters/product-catalogue", icon: PackageCheck, roles: ADMIN_ONLY, group: "Master Data" },
    ],
  },
  { label: "Categories", href: "/masters/categories", icon: Tags, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Pack Sizes", href: "/masters/packSizes", icon: Ruler, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Dealers", href: "/masters/dealers", icon: Store, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Users", href: "/masters/users", icon: Users, roles: [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER], group: "Master Data" },
  { label: "Seasons", href: "/seasons", icon: CalendarRange, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Announcements", href: "/masters/announcements", icon: Megaphone, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Settings", href: "/masters/settings", icon: Settings, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Planning Configuration", href: "/masters/planning-config", icon: SlidersHorizontal, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Dealer Import Wizard", href: "/masters/dealer-import", icon: FileUp, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Product Price Import", href: "/masters/product-price-import", icon: FileSpreadsheet, roles: ADMIN_ONLY, group: "Master Data" },
  { label: "Import History", href: "/masters/import-history", icon: History, roles: ADMIN_ONLY, group: "Master Data" },

  { label: "Dealer Assignments", href: "/assignments/dealers", icon: Link2, roles: ADMIN_ONLY, group: "Organization" },
  { label: "RM Assignments", href: "/assignments/rm", icon: Network, roles: ADMIN_ONLY, group: "Organization" },
];

export function navForRole(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role)).map((item) =>
    item.children ? { ...item, children: item.children.filter((c) => c.roles.includes(role)) } : item,
  );
}
