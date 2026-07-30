"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface SearchHit {
  type: string;
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(q), 250);
  }, [q]);

  const { data } = useQuery<SearchHit[]>({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchHit[]>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const hits = useMemo(() => data ?? [], [data]);

  return (
    <div className="relative hidden md:block">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        className="h-9 w-56 pl-8"
        placeholder="Search…"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
      />
      {open && debounced.trim().length >= 2 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-md border bg-popover shadow-lg">
            {hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results.</p>
            ) : (
              <div className="max-h-96 overflow-auto py-1">
                {hits.map((h) => (
                  <Link
                    key={`${h.type}-${h.id}`}
                    href={h.href}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => {
                      setOpen(false);
                      setQ("");
                    }}
                  >
                    <Badge variant="muted">{h.type}</Badge>
                    <span className="min-w-0">
                      <span className="font-medium">{h.label}</span>
                      {h.sublabel && (
                        <span className="ml-1 text-xs text-muted-foreground">{h.sublabel}</span>
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
