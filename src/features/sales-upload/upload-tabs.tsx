"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useLabel } from "@/features/labels/label-ui";
import { SalesUploadWizard } from "./wizard";
import { DaybookUploadWizard } from "./daybook-wizard";
import { SchemeUploadWizard } from "@/features/schemes/scheme-upload-wizard";
import { HistoricalDaybookWizard } from "@/features/historical-daybook/wizard";

type Tab = "sales" | "daybook" | "scheme" | "historical";

/**
 * Four SEPARATE upload workflows under one screen — Sales Upload (Tally Sales Register → monthly
 * actuals), Daybook Upload (Tally Day Book → SR/CR + Live Recovery), and Scheme Upload (Tally Sales
 * Register → scheme achievement tracking, isolated from normal actuals), Historical Daybook (Last
 * Payment-only receipt history). They are never merged; the tab
 * only chooses which independent wizard to show. Sales/Daybook behaviour is unchanged.
 */
export function UploadTabs() {
  const [tab, setTab] = useState<Tab>("sales");
  const schemeTabLabel = useLabel("scheme_upload.tab");
  const historicalTabLabel = useLabel("historical_daybook.tab");
  const labelOf = (t: Tab) => (t === "sales" ? "Sales Upload" : t === "daybook" ? "Daybook Upload" : t === "scheme" ? schemeTabLabel : historicalTabLabel);
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["sales", "daybook", "scheme", "historical"] as Tab[]).map((t) => (
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
      {tab === "sales" ? <SalesUploadWizard /> : tab === "daybook" ? <DaybookUploadWizard /> : tab === "scheme" ? <SchemeUploadWizard /> : <HistoricalDaybookWizard />}
    </div>
  );
}
