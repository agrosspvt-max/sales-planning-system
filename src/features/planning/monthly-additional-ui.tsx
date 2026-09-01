"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ChevronDown, ChevronRight, UserPlus, Pencil } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ClearanceTag } from "@/components/ui/clearance-tag";
import { CategoryBadge } from "@/components/ui/category-badge";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { categoryForNbv, matchesCategoryFilter } from "@/lib/product-category";
import { DealerFormDialog, DealerFormBody, type DealerFields } from "./dealer-form-dialog";
import { useMonthlyEdit } from "./monthly-edit-context";

interface Candidate { productId: string; productName: string; rate: number; nbvPercent: number; isClearance?: boolean; clearanceQty?: number | null; clearanceRemaining?: number | null }

/** "+ Create Dealer" in Monthly Planning — opens the shared Dealer dialog (PENDING_APPROVAL). */
export function CreateDealerButton({ monthlyPlanId, onCreated }: { monthlyPlanId: string; onCreated: (dealerId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" /> Create Dealer
      </Button>
      <DealerFormDialog
        open={open}
        onOpenChange={setOpen}
        ctx={{ variant: "monthly", monthlyPlanId }}
        onDone={(id) => id && onCreated(id)}
      />
    </>
  );
}

/**
 * "+ Add Dealer" in Monthly Planning. One modal with two tabs:
 *   • Add Dealer   — pick an existing in-scope dealer (not already in this plan) and add it immediately.
 *   • Create Dealer — the existing create-dealer flow (reused via DealerFormBody, PENDING_APPROVAL).
 * Either path makes the dealer appear in the dropdown / progress bar without a refresh (the monthly-plan
 * query is invalidated), and selects it via `onAdded`.
 */
export function AddDealerButton({ monthlyPlanId, onAdded }: { monthlyPlanId: string; onAdded: (dealerId: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"add" | "create">("add");
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: addable, isFetching } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["addable-dealers", monthlyPlanId],
    queryFn: () => api.get(`/api/planning/monthly-plans/${monthlyPlanId}/dealers`),
    enabled: open && tab === "add",
  });

  const addMut = useMutation({
    mutationFn: (dealerId: string) => api.post(`/api/planning/monthly-plans/${monthlyPlanId}/dealers/add-existing`, { dealerId }),
    onSuccess: (_r, dealerId) => {
      qc.invalidateQueries({ queryKey: ["monthly-plan", monthlyPlanId] });
      qc.invalidateQueries({ queryKey: ["addable-dealers", monthlyPlanId] });
      setOpen(false); setPick(""); setError(null);
      onAdded(dealerId);
    },
    onError: (e) => setError((e as Error).message),
  });

  const openModal = () => { setTab("add"); setPick(""); setError(null); setOpen(true); };
  const Tab = ({ id, label }: { id: "add" | "create"; label: string }) => (
    <button type="button" onClick={() => { setTab(id); setError(null); }}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium", tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>{label}</button>
  );

  return (
    <>
      <Button variant="outline" size="sm" onClick={openModal}><Plus className="h-4 w-4" /> Add Dealer</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Dealer</DialogTitle></DialogHeader>
          <div className="flex gap-1 rounded-lg bg-muted/40 p-1">
            <Tab id="add" label="Add Dealer" />
            <Tab id="create" label="Create Dealer" />
          </div>
          {tab === "add" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Choose one of your dealers not already in this monthly plan.</p>
              {isFetching ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (addable?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">All your dealers are already in this plan.</p>
              ) : (
                <NativeSelect
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  options={[{ value: "", label: "Choose a dealer…" }, ...(addable ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                />
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={!pick || addMut.isPending} onClick={() => addMut.mutate(pick)}>{addMut.isPending ? "Adding…" : "Add"}</Button>
              </div>
            </div>
          ) : (
            <DealerFormBody
              ctx={{ variant: "monthly", monthlyPlanId }}
              onClose={() => setOpen(false)}
              onDone={(id) => { if (id) onAdded(id); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Edit a PENDING dealer created here — same dialog in Edit mode (DRAFT/RETURNED only). */
export function EditDealerButton({ monthlyPlanId, dealerId, initial }: { monthlyPlanId: string; dealerId: string; initial: DealerFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Pencil className="h-4 w-4" /> Edit dealer</Button>
      <DealerFormDialog
        open={open}
        onOpenChange={setOpen}
        ctx={{ variant: "monthly", monthlyPlanId, dealerId }}
        initial={initial}
        onDone={() => undefined}
      />
    </>
  );
}

/**
 * Collapsible product picker for this dealer and month. It includes products from the seasonal
 * plan that have not yet been added to this month, plus products outside the seasonal plan.
 */
export function AdditionalProductsSection({ monthlyPlanId, dealerId, canEdit }: { monthlyPlanId: string; dealerId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const categories = useCategories();
  const [categoryFilter, setCategoryFilter] = useState("");
  // Open-state is shared via the Monthly edit context so the mobile FAB / sticky bar can open this
  // section (and trigger the auto-scroll below) without the user hunting at the bottom of the page.
  const { additionalOpen: open, setAdditionalOpen: setOpen } = useMonthlyEdit();
  const sectionRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the section whenever it opens (requirement #3), on desktop and mobile alike.
  useEffect(() => {
    if (open) sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [open]);
  const base = `/api/planning/monthly-plans/${monthlyPlanId}/dealers/${dealerId}/additional-products`;
  const { data, isFetching } = useQuery<Candidate[]>({
    queryKey: ["additional-products", monthlyPlanId, dealerId],
    queryFn: () => api.get<Candidate[]>(base),
    enabled: open && !!dealerId,
  });
  const addMut = useMutation({
    mutationFn: (productId: string) => api.post(base, { productId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monthly-plan", monthlyPlanId] });
      qc.invalidateQueries({ queryKey: ["additional-products", monthlyPlanId, dealerId] });
    },
  });

  if (!dealerId) return null;
  return (
    <div ref={sectionRef} className="scroll-mt-4 rounded-lg border bg-background">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Show Additional Products
        <span className="text-xs font-normal text-muted-foreground">products not yet added to this monthly plan</span>
      </button>
      {open && (
        <div className="border-t p-3">
          {!canEdit ? (
            <p className="text-sm text-muted-foreground">This plan is read-only.</p>
          ) : isFetching ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No additional products available.</p>
          ) : (
            <>
              <div className="mb-2"><CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} /></div>
              <div className="flex max-h-72 flex-wrap gap-2 overflow-auto">
                {data!.filter((c) => matchesCategoryFilter(c.nbvPercent, categoryFilter, categories)).map((c) => (
                  <Button key={c.productId} variant="outline" size="sm" disabled={addMut.isPending} onClick={() => addMut.mutate(c.productId)}>
                    <Plus className="h-3.5 w-3.5" /> <span className={c.isClearance ? "text-warning" : undefined}>{c.productName}</span>
                    {c.isClearance && <ClearanceTag qty={c.clearanceQty} remaining={c.clearanceRemaining} />}
                    <CategoryBadge category={categoryForNbv(c.nbvPercent, categories)} />
                  </Button>
                ))}
              </div>
            </>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Adding a product places it in the table above for this dealer and month. The approved Seasonal Plan is not changed.</p>
        </div>
      )}
    </div>
  );
}
