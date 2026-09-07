"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useLabel } from "@/features/labels/label-ui";
import { SalesUploadWizard } from "./wizard";
import { DaybookUploadWizard } from "./daybook-wizard";
import { SchemeUploadWizard } from "@/features/schemes/scheme-upload-wizard";

type Tab = "sales" | "daybook" | "scheme";

/**
 * Three SEPARATE upload workflows under one screen — Sales Upload (Tally Sales Register → monthly
 * actuals), Daybook Upload (Tally Day Book → SR/CR + Live Recovery), and Scheme Upload (Tally Sales
 * Register → scheme achievement tracking, isolated from normal actuals). They are never merged; the tab
 * only chooses which independent wizard to show. Sales/Daybook behaviour is unchanged.
 */
export function UploadTabs() {
  const [tab, setTab] = useState<Tab>("sales");
  const schemeTabLabel = useLabel("scheme_upload.tab");
  const labelOf = (t: Tab) => (t === "sales" ? "Sales Upload" : t === "daybook" ? "Daybook Upload" : schemeTabLabel);
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["sales", "daybook", "scheme"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-3 py-1.5 font-medium",
              tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {labelOf(t)}
          </button>
        ))}
      </div>
      {tab === "sales" ? <SalesUploadWizard /> : tab === "daybook" ? <DaybookUploadWizard /> : <SchemeUploadWizard />}
    </div>
  );
}
