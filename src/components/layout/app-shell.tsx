"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Role } from "@prisma/client";
import { Menu, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { navForRole } from "@/features/navigation/nav";
import { resolveNavState } from "@/features/navigation/nav-state";
import { ROLE_LABELS } from "@/lib/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "./logout-button";
import { NotificationBell } from "@/features/notifications/notification-bell";
import { GlobalSearch } from "@/features/search/global-search";
import { ThemeToggle } from "@/components/theme/theme-toggle";

interface AppUser {
  name: string;
  username: string;
  role: Role;
}

export function AppShell({ user, children }: { user: AppUser; children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Groups the user has manually collapsed. The active section is always forced open
  // regardless of this set, so navigation never hides the current page.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const pathname = usePathname();
  const items = navForRole(user.role);

  // One centralized computation of the active page + its section. The sidebar reuses this
  // instead of each item running its own prefix test — so only one leaf can be selected.
  const navState = useMemo(() => resolveNavState(pathname, items), [pathname, items]);

  const groups = useMemo(
    () =>
      Array.from(
        items.reduce((map, item) => {
          const key = item.group ?? "";
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(item);
          return map;
        }, new Map<string, typeof items>()),
      ),
    [items],
  );

  const toggleGroup = (group: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });

  const leaf = (item: (typeof items)[number]) => {
    const Icon = item.icon;
    const active = item.href === navState.activeHref;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileOpen(false)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-primary text-primary-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
        {item.label}
      </Link>
    );
  };

  const sidebar = (
    <nav className="flex min-h-full flex-col gap-3 p-4">
      <div className="px-2 py-1 text-sm font-bold tracking-tight text-primary">
        Sales Planning
      </div>
      {groups.map(([group, groupItems]) => {
        // Ungrouped items (e.g. Dashboard) render as plain top-level leaves.
        if (!group) {
          return (
            <div key="__root" className="space-y-1">
              {groupItems.map(leaf)}
            </div>
          );
        }
        // "Expanded section" and "active page" are separate concepts: the section that
        // contains the active leaf is always expanded and gets a subtle header emphasis,
        // but never the selected pill — that belongs to exactly one leaf.
        const containsActive = group === navState.activeGroup;
        const expanded = containsActive || !collapsed.has(group);
        return (
          <div key={group} className="space-y-1">
            <button
              type="button"
              onClick={() => toggleGroup(group)}
              aria-expanded={expanded}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-foreground",
                containsActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span>{group}</span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 transition-transform",
                  expanded ? "" : "-rotate-90",
                )}
              />
            </button>
            {expanded && <div className="space-y-1">{groupItems.map(leaf)}</div>}
          </div>
        );
      })}
    </nav>
  );

  return (
    // Lock the viewport: the shell fills the screen and hides overflow, so each region
    // below owns its own scroll instead of the whole document body scrolling as one.
    <div className="flex h-screen overflow-hidden bg-muted/20">
      {/* Desktop sidebar — its own surface tokens + independent scroll (height: 100vh). */}
      <aside className="hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block">
        {sidebar}
      </aside>

      {/* Mobile sidebar — its own scroll region too. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex h-screen min-w-0 flex-1 flex-col">
        {/* Global header — always visible. Never scrolls; the content region does. */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <span className="text-sm font-semibold tracking-tight text-primary lg:hidden">
              Sales Planning
            </span>
          </div>
          <div className="flex items-center gap-3">
            <GlobalSearch />
            <NotificationBell />
            <ThemeToggle />
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-none">{user.name}</p>
              <p className="text-xs text-muted-foreground">@{user.username}</p>
            </div>
            <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
            <LogoutButton />
          </div>
        </header>

        {/* Content — independent scroll region. PageHeader sticks to the top of THIS. */}
        <main className="flex-1 overflow-y-auto">
          <div className="px-4 py-4 md:px-6 md:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
