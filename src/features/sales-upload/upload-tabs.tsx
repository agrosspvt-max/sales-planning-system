"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { SalesUploadWizard } from "./wizard";
import { DaybookUploadWizard } from "./daybook-wizard";

type Tab = "sales" | "daybook";

/**
 * Two SEPARATE upload workflows under one screen — Sales Upload (Tally Sales Register → monthly
 * actuals) and Daybook Upload (Tally Day Book → SR/CR + Live Recovery). They are never merged; the
 * tab only chooses which independent wizard to show.
 */
export function UploadTabs() {
  const [tab, setTab] = useState<Tab>("sales");
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["sales", "daybook"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-3 py-1.5 font-medium",
              tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "sales" ? "Sales Upload" : "Daybook Upload"}
          </button>
        ))}
      </div>
      {tab === "sales" ? <SalesUploadWizard /> : <DaybookUploadWizard />}
    </div>
  );
}
