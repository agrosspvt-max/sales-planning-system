"use client";
import { useState } from "react";
import { accountSnapshotName } from "@/features/accounts/identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useLabelResolver } from "@/features/labels/label-ui";
import { cnReviewStatusKey, type CnReview, type CnReviewType } from "@/lib/cn-review";
import { formatDateTimeDMY } from "@/lib/date-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CN_WORKING_MAX_BYTES,
  CN_WORKING_PDF_MIME,
  type CnAcceptanceStatus,
} from "@/lib/cn-request";

function useReviewChanged() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["cn-requests", "cn-review-inbox", "cn-review-history", "cn-request-detail"])
      void qc.invalidateQueries({ queryKey: [key] });
  };
}
export function ReviewDocument({ review }: { review: CnReview }) {
  const t = useLabelResolver();
  if (!review.fileName) return null;
  const url = `/api/cn-reviews/${review.id}/document`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{review.fileName}</span>
      {review.mimeType === CN_WORKING_PDF_MIME && (
        <a className="underline" href={url} target="_blank" rel="noreferrer">
          {t("cn_requests.acceptance.view")}
        </a>
      )}
      <a className="underline" href={`${url}?download=1`}>
        {t("cn_requests.acceptance.download")}
      </a>
    </div>
  );
}
export function ReviewProducts({ review }: { review: CnReview }) {
  const t = useLabelResolver();
  if (!review.products.length) return null;
  return (
    <Table numbered>
      <TableHeader>
        <TableRow>
          <TableHead>{t("cn_requests.processing.product")}</TableHead>
          <TableHead>{t("cn_requests.processing.price")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {review.products.map((p) => (
          <TableRow key={p.id}>
            <TableCell>{p.name}</TableCell>
            <TableCell>{p.price == null ? "—" : `₹${p.price.toFixed(2)}`}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function CnReviewHistory({ requestId }: { requestId: string }) {
  const t = useLabelResolver();
  const { data, isLoading, error } = useQuery<CnReview[]>({
    queryKey: ["cn-review-history", requestId],
    queryFn: () => api.get(`/api/cn-reviews/requests/${requestId}`),
    staleTime: 0,
  });
  if (isLoading) return <p role="status">{t("cn_requests.detail.timeline_loading")}</p>;
  if (error)
    return (
      <p role="alert" className="text-destructive">
        {(error as Error).message}
      </p>
    );
  if (!data?.length) return null;
  return (
    <section className="space-y-3 pt-4">
      <h3 className="font-semibold">{t("cn_requests.processing.history")}</h3>
      {data.map((r) => (
        <div key={r.id} className="space-y-2 rounded border p-3">
          <p className="font-medium">
            {t(
              r.kind === "RATE_CONFIRMATION"
                ? "cn_requests.processing.rate"
                : "cn_requests.processing.cn",
            )}{" "}
            · {t(cnReviewStatusKey(r))}
          </p>
          <p className="text-sm">
            {t("cn_requests.processing.sender")}: {accountSnapshotName(r.sentByName)}
          </p>
          <p className="text-sm">
            {t("cn_requests.processing.depends")}: {accountSnapshotName(r.assignedToName)}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTimeDMY(r.createdAt)}
            {r.respondedAt ? ` · ${formatDateTimeDMY(r.respondedAt)}` : ""}
          </p>
          <ReviewProducts review={r} />
          <ReviewDocument review={r} />
          {r.note && <p className="whitespace-pre-wrap text-sm">{r.note}</p>}
        </div>
      ))}
    </section>
  );
}

/** Both review branches share assignment/replacement; final outcomes reuse the existing CN dialogs. */
export function CnProcessingDialog({
  requestId,
  underProcess,
  canHandle,
  canAccept,
  canPost,
  canReject,
  onClose,
  onDecision,
}: {
  requestId: string;
  underProcess: boolean;
  canHandle: boolean;
  canAccept: boolean;
  canPost: boolean;
  canReject: boolean;
  onClose: () => void;
  onDecision: (
    destination: CnAcceptanceStatus | "REJECTED",
    expectedReviewId: string,
    bypassReason: string,
  ) => void;
}) {
  const t = useLabelResolver();
  const changed = useReviewChanged();
  const [kind, setKind] = useState<CnReviewType>("RATE_CONFIRMATION");
  const [assignedToId, setAssignedToId] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [bypass, setBypass] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const choices = useQuery<{
    people: Array<{ id: string; name: string; administrative: boolean }>;
    products: Array<{ id: string; name: string }>;
  }>({
    queryKey: ["cn-review-choices"],
    queryFn: () => api.get("/api/cn-reviews/choices"),
    enabled: canHandle,
  });
  const history = useQuery<CnReview[]>({
    queryKey: ["cn-review-history", requestId],
    queryFn: () => api.get(`/api/cn-reviews/requests/${requestId}`),
    refetchInterval: underProcess ? 15000 : false,
  });
  const last = history.data?.at(-1);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!assignedToId || (kind === "RATE_CONFIRMATION" ? !products.length : !file))
        throw new Error(t("cn_requests.processing.error.invalid"));
      if (file && file.size > CN_WORKING_MAX_BYTES)
        throw new Error(t("cn_requests.validation.working_too_large"));
      const form = new FormData();
      form.set("kind", kind);
      form.set("assignedToId", assignedToId);
      form.set("requestKey", requestKey);
      if (last) form.set("expectedReviewId", last.id);
      for (const id of products) form.append("productId", id);
      if (file) form.set("file", file);
      const response = await fetch(`/api/cn-reviews/requests/${requestId}`, {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("cn_requests.processing.error.invalid"));
    },
    onSuccess: () => {
      changed();
      onClose();
    },
  });
  const finish = (destination: CnAcceptanceStatus | "REJECTED") => {
    if (!last) return;
    if (last.status !== "CONFIRMED" && !bypass.trim()) {
      setProblem(t("cn_requests.processing.error.bypass"));
      return;
    }
    onDecision(destination, last.id, bypass.trim());
  };
  const people = (choices.data?.people ?? [])
    .filter((p) => kind === "RATE_CONFIRMATION" || p.administrative)
    .map((p) => ({ value: p.id, label: accountSnapshotName(p.name) }));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("cn_requests.processing.tab")}</DialogTitle>
        </DialogHeader>
        {(history.error || choices.error) && (
          <p role="alert" className="text-destructive">
            {((history.error ?? choices.error) as Error).message}
          </p>
        )}
        {canHandle && (
          <div className="space-y-3">
            <Label>{t("cn_requests.processing.type")}</Label>
            <NativeSelect
              value={kind}
              options={[
                { value: "RATE_CONFIRMATION", label: t("cn_requests.processing.rate") },
                { value: "CN_APPROVAL", label: t("cn_requests.processing.cn") },
              ]}
              onChange={(e) => {
                setKind(e.target.value as CnReviewType);
                setAssignedToId("");
              }}
            />
            {kind === "RATE_CONFIRMATION" ? (
              <SearchableMultiSelect
                label={t("cn_requests.processing.products")}
                placeholder={t("cn_requests.processing.products")}
                searchPlaceholder={t("cn_requests.processing.search")}
                emptyText={t("cn_requests.processing.none")}
                noMatchText={t("cn_requests.processing.none")}
                removeLabel={t("cn_requests.processing.remove")}
                unavailableLabel={t("cn_requests.processing.unavailable")}
                value={products}
                options={(choices.data?.products ?? []).map((p) => ({
                  value: p.id,
                  label: accountSnapshotName(p.name),
                }))}
                onChange={setProducts}
              />
            ) : (
              <div>
                <Label htmlFor="cn-review-file">{t("cn_requests.acceptance.cn_working")} *</Label>
                <Input
                  id="cn-review-file"
                  type="file"
                  accept=".pdf,.xlsx"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
            )}
            <Label>{t("cn_requests.processing.depends")} *</Label>
            <SearchableSelect
              value={assignedToId}
              options={people}
              onChange={setAssignedToId}
              placeholder={t("cn_requests.processing.choose")}
              emptyText={t("cn_requests.processing.none")}
              ariaLabel={t("cn_requests.processing.depends")}
            />
            <Button
              disabled={
                mutation.isPending ||
                history.isLoading ||
                choices.isLoading ||
                !!history.error ||
                !!choices.error
              }
              onClick={() => mutation.mutate()}
            >
              {t(underProcess ? "cn_requests.processing.replace" : "cn_requests.processing.send")}
            </Button>
          </div>
        )}
        {underProcess && <CnReviewHistory requestId={requestId} />}
        {underProcess && last && (canAccept || canPost || canReject) && (
          <div className="space-y-3 border-t pt-4">
            {last.status !== "CONFIRMED" && (
              <div>
                <Label htmlFor="cn-review-bypass">{t("cn_requests.processing.bypass")} *</Label>
                <Textarea
                  id="cn-review-bypass"
                  maxLength={2000}
                  value={bypass}
                  onChange={(e) => setBypass(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("cn_requests.processing.bypass_hint")}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {canReject && (
                <Button variant="destructive" onClick={() => finish("REJECTED")}>
                  {t("cn_requests.action.reject")}
                </Button>
              )}
              {canAccept && (
                <>
                  <Button onClick={() => finish("ACCEPTED_NOT_POSTED")}>
                    {t("cn_requests.view.accepted_not_posted")}
                  </Button>
                  {canPost && (
                    <Button onClick={() => finish("POSTED_IN_LEDGER")}>
                      {t("cn_requests.view.posted_in_ledger")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {(mutation.error || problem) && (
          <p role="alert" className="text-sm text-destructive">
            {(mutation.error as Error | null)?.message ?? problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cn_requests.action.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CnReviewInbox() {
  const t = useLabelResolver();
  const changed = useReviewChanged();
  const { data, error, isLoading } = useQuery<CnReview[]>({
    queryKey: ["cn-review-inbox"],
    queryFn: () => api.get("/api/cn-reviews/inbox"),
    refetchInterval: 30000,
  });
  const [selected, setSelected] = useState<CnReview | null>(null);
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">{t("cn_requests.processing.inbox")}</h2>
      {error ? (
        <p role="alert" className="text-destructive">
          {(error as Error).message}
        </p>
      ) : isLoading ? (
        <p role="status">{t("cn_requests.detail.timeline_loading")}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground">{t("cn_requests.processing.empty")}</p>
      ) : (
        <Table numbered>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.dealer")}</TableHead>
              <TableHead>{t("cn_requests.processing.type")}</TableHead>
              <TableHead>{t("cn_requests.processing.sender")}</TableHead>
              <TableHead>{t("cn_requests.col.action")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.partyName}</TableCell>
                <TableCell>
                  {t(
                    r.kind === "RATE_CONFIRMATION"
                      ? "cn_requests.processing.rate"
                      : "cn_requests.processing.cn",
                  )}
                </TableCell>
                <TableCell>{accountSnapshotName(r.sentByName)}</TableCell>
                <TableCell>
                  <Button variant="outline" onClick={() => setSelected(r)}>
                    {t("cn_requests.processing.open")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {selected && (
        <CnReviewResponseDialog
          key={selected.id}
          review={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            changed();
            setSelected(null);
          }}
        />
      )}
    </section>
  );
}
export function CnReviewResponseDialog({
  review,
  onClose,
  onChanged,
}: {
  review: CnReview;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useLabelResolver();
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      api.post(`/api/cn-reviews/${review.id}/respond`, {
        action,
        note,
        prices: review.products.map((p) => ({
          id: p.id,
          price: prices[p.id]?.trim() ? Number(prices[p.id]) : null,
        })),
      }),
    onSuccess: onChanged,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {review.partyName} ·{" "}
            {t(
              review.kind === "RATE_CONFIRMATION"
                ? "cn_requests.processing.rate"
                : "cn_requests.processing.cn",
            )}
          </DialogTitle>
        </DialogHeader>
        {review.details && <p className="whitespace-pre-wrap text-sm">{review.details}</p>}
        <p className="text-sm">
          {t("cn_requests.processing.sender")}: {accountSnapshotName(review.sentByName)}
        </p>
        {review.products.map((p) => (
          <div key={p.id} className="grid gap-2 sm:grid-cols-2">
            <Label htmlFor={`price-${p.id}`}>{p.name}</Label>
            <div>
              <Label htmlFor={`price-${p.id}`} className="text-xs">
                {t("cn_requests.processing.price")}
              </Label>
              <Input
                id={`price-${p.id}`}
                type="number"
                min="0"
                step="0.01"
                value={prices[p.id] ?? ""}
                onChange={(e) => setPrices({ ...prices, [p.id]: e.target.value })}
              />
            </div>
          </div>
        ))}
        <ReviewDocument review={review} />
        <Label htmlFor="review-note">{t("cn_requests.processing.note")}</Label>
        <Textarea
          id="review-note"
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {mutation.error && (
          <p role="alert" className="text-destructive">
            {(mutation.error as Error).message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cn_requests.action.close")}
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending || !note.trim()}
            onClick={() => mutation.mutate("reject")}
          >
            {t("cn_requests.processing.reject")}
          </Button>
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate("approve")}>
            {t(
              review.kind === "RATE_CONFIRMATION"
                ? "cn_requests.processing.submit_prices"
                : "cn_requests.processing.approve",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
