"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ChevronDown, ChevronRight, UserPlus, Pencil } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { DealerFormDialog, type DealerFields } from "./dealer-form-dialog";
import { useMonthlyEdit } from "./monthly-edit-context";

interface Candidate { productId: string; productName: string; rate: number; nbvPercent: number }

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
            <div className="flex max-h-72 flex-wrap gap-2 overflow-auto">
              {data!.map((c) => (
                <Button key={c.productId} variant="outline" size="sm" disabled={addMut.isPending} onClick={() => addMut.mutate(c.productId)}>
                  <Plus className="h-3.5 w-3.5" /> {c.productName}
                </Button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Adding a product places it in the table above for this dealer and month. The approved Seasonal Plan is not changed.</p>
        </div>
      )}
    </div>
  );
}
