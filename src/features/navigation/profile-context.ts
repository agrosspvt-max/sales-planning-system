/**
 * Profile navigation context.
 *
 * Child pages (a plan, a summary, approvals, an import wizard) are shared global routes.
 * When one is opened FROM a profile we stamp the originating profile onto the link as
 * query params, so the child page can render a correct "Back to … Profile" control and a
 * breadcrumb trail that reflects how the user actually got there — without duplicating any
 * route. Framework-agnostic (no React) so it is used both server-side (to build links) and
 * client-side (to read them). Future profiles (RM, Territory, Product, Brand, Company)
 * reuse this unchanged.
 */

export type ProfileKind = "officer" | "dealer" | "regional" | "territory" | "product" | "brand" | "company";

export interface ProfileOrigin {
  /** Return URL — the profile page to go back to. */
  href: string;
  /** Profile display name, e.g. "Rahul Patidar". */
  label: string;
  kind: ProfileKind;
  /** Label of the CURRENT child page, used as the breadcrumb leaf. */
  pageLabel: string;
}

const KEY = {
  href: "pf_from",
  label: "pf_name",
  kind: "pf_kind",
  page: "pf_page",
} as const;

/** Minimal read interface satisfied by both URLSearchParams and Next's ReadonlyURLSearchParams. */
interface Readable {
  get(key: string): string | null;
}

/** Stamp an originating profile + current-page label onto a target href (merges existing query). */
export function withProfileContext(
  targetHref: string,
  origin: { href: string; label: string; kind: ProfileKind },
  pageLabel: string,
): string {
  const [path, existing] = targetHref.split("?");
  const sp = new URLSearchParams(existing ?? "");
  sp.set(KEY.href, origin.href);
  sp.set(KEY.label, origin.label);
  sp.set(KEY.kind, origin.kind);
  sp.set(KEY.page, pageLabel);
  return `${path}?${sp.toString()}`;
}

/** Read an originating profile from query params, or null when the page wasn't launched from one. */
export function readProfileOrigin(sp: Readable): ProfileOrigin | null {
  const href = sp.get(KEY.href);
  const kind = sp.get(KEY.kind);
  if (!href || !kind) return null;
  return {
    href,
    label: sp.get(KEY.label) ?? "Profile",
    kind: kind as ProfileKind,
    pageLabel: sp.get(KEY.page) ?? "",
  };
}

const KIND_LABEL: Record<ProfileKind, string> = {
  officer: "Sales Officer Profile",
  dealer: "Dealer Profile",
  regional: "Regional Manager Profile",
  territory: "Territory Profile",
  product: "Product Profile",
  brand: "Brand Profile",
  company: "Company Profile",
};

export function profileKindLabel(kind: ProfileKind): string {
  return KIND_LABEL[kind] ?? "Profile";
}
