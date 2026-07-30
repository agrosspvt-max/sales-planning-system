"use client";

import { useEffect, useRef, useState } from "react";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "./theme-provider";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const CurrentIcon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CurrentIcon className="h-5 w-5" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-40 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {OPTIONS.map((o) => {
            const Icon = o.icon;
            const active = theme === o.value;
            return (
              <button
                key={o.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  active && "font-medium",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{o.label}</span>
                {active && <Check className="h-4 w-4 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
