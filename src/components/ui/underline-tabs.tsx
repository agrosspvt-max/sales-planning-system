import Link from "next/link";

export interface UnderlineTab { key: string; label: React.ReactNode; href?: string }

/**
 * The underline tab strip used for Sales Planning's Seasonal / Monthly / Yearly tabs (same container, spacing, font and active /
 * inactive colours), as a shared component. With `href` each tab is a route link (so refresh and Back/Forward keep the section);
 * without it the tab is a button that calls `onChange`.
 */
export function UnderlineTabs({ tabs, active, onChange }: { tabs: UnderlineTab[]; active: string; onChange?: (key: string) => void }) {
  const cls = (key: string) => `border-b-2 px-3 py-2 text-sm font-medium transition-colors ${active === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="flex gap-1 border-b">
      {tabs.map((tab) => tab.href
        ? <Link key={tab.key} href={tab.href} className={cls(tab.key)} aria-current={active === tab.key ? "page" : undefined}>{tab.label}</Link>
        : <button key={tab.key} type="button" onClick={() => onChange?.(tab.key)} className={cls(tab.key)}>{tab.label}</button>)}
    </div>
  );
}
