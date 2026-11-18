"use client";

import { useState, type KeyboardEvent } from "react";
import { TallyDealerAudit } from "./dealer-audit-panel";
import { TallyMissingProducts } from "./missing-products-panel";

const tabs = ["Dealers", "Products"] as const;

export function TallyMissingRecords() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Dealers");
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "Dealers"
        : event.key === "End"
          ? "Products"
          : tab === "Dealers"
            ? "Products"
            : "Dealers";
    setTab(next);
    document.getElementById("tally-missing-tab-" + next)?.focus();
  }
  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4"
      aria-labelledby="tally-missing-title"
    >
      <h2 id="tally-missing-title" className="text-base font-semibold">
        Missing Dealers and Products
      </h2>
      <div role="tablist" aria-label="Missing records" className="flex gap-4 border-b">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={"tally-missing-tab-" + name}
            aria-selected={tab === name}
            aria-controls={"tally-missing-panel-" + name}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={onKeyDown}
            className={
              "border-b-2 px-1 py-2 text-sm font-medium " +
              (tab === name
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground")
            }
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={"tally-missing-panel-" + tab}
        aria-labelledby={"tally-missing-tab-" + tab}
      >
        {tab === "Dealers" ? <TallyDealerAudit /> : <TallyMissingProducts />}
      </div>
    </section>
  );
}
