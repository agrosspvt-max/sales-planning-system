import type { DealerMarker } from "@/lib/dealer-tags";
export interface TagDefinition extends DealerMarker {
  isActive: boolean;
}
export interface TagDealer {
  id: string;
  name: string;
  isActive: boolean;
  tags: DealerMarker[];
  assignedTags: TagDefinition[];
}
export interface TagRequest {
  id: string;
  dealerId: string;
  dealerName: string;
  tagId: string;
  tagName: string;
  marker: string;
  operation: "ADD" | "REVOKE";
  status: string;
  requestedById: string;
  requestedByName: string;
  createdAt: string;
  canAct: boolean;
  history: {
    action: string;
    actorName: string;
    fromStatus: string | null;
    toStatus: string | null;
    remarks: string | null;
    createdAt: string;
  }[];
}
