import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  announcePlanningPeriodChange,
  listenForPlanningPeriodChanges,
} from "./planning-period-cache";

const channels = new Set<Channel>();
class Channel {
  onmessage?: (e: { data: unknown }) => void;
  constructor(public name: string) {
    channels.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of channels)
      if (peer !== this && peer.name === this.name) peer.onmessage?.({ data });
  }
  close() {
    channels.delete(this);
  }
}
async function main() {
  const original = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
  const a = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const b = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let plansA = 0,
    plansB = 0,
    labels = 0,
    inactive = 0;
  let open = true;
  const observerA = new QueryObserver(a, {
    queryKey: ["plans"],
    queryFn: async () => {
      plansA++;
      return open ? ["November"] : [];
    },
  });
  const observerB = new QueryObserver(b, {
    queryKey: ["monthly-plans"],
    queryFn: async () => {
      plansB++;
      return open ? ["November"] : [];
    },
  });
  const labelObserver = new QueryObserver(a, {
    queryKey: ["labels"],
    queryFn: async () => {
      labels++;
      return {};
    },
  });
  const subscriptions = [
    observerA.subscribe(() => {}),
    observerB.subscribe(() => {}),
    labelObserver.subscribe(() => {}),
  ];
  const stop = listenForPlanningPeriodChanges(b);
  try {
    await Promise.all([observerA.refetch(), observerB.refetch(), labelObserver.refetch()]);
    await a.fetchQuery({
      queryKey: ["recovery-plans"],
      queryFn: async () => {
        inactive++;
        return ["November"];
      },
    });
    const originalCalls = [plansA, plansB, labels, inactive];
    open = false;
    await announcePlanningPeriodChange(a);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(a.getQueryData<unknown[]>(["plans"])?.length, 0);
    assert.equal(
      b.getQueryData<unknown[]>(["monthly-plans"])?.length,
      0,
      "other tab removes the closed month",
    );
    assert.equal(plansA, originalCalls[0]! + 1);
    assert.equal(plansB, originalCalls[1]! + 1);
    assert.equal(labels, originalCalls[2], "no repeated label or unrelated lookup request");
    assert.equal(inactive, originalCalls[3], "hidden screens do not refetch");
    assert.equal(
      a.getQueryState(["recovery-plans"])?.isInvalidated,
      true,
      "inactive plans become stale for next open",
    );
    open = true;
    await announcePlanningPeriodChange(a);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(a.getQueryData<unknown[]>(["plans"])?.length, 1);
    assert.equal(b.getQueryData<unknown[]>(["monthly-plans"])?.length, 1);
    assert.equal(labels, originalCalls[2]);
    console.log(
      "Planning period cache: close/reopen updates mounted queries and other tabs, leaves inactive/unrelated queries unrequested, and uses no polling.",
    );
  } finally {
    stop();
    subscriptions.forEach((unsubscribe) => unsubscribe());
    a.clear();
    b.clear();
    globalThis.BroadcastChannel = original;
    assert.equal(channels.size, 0);
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
