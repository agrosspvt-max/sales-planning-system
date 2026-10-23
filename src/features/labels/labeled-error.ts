import { ApiError } from "@/lib/api-error";
import { DEFAULT_LABELS, type LabelKey } from "./labels";
import { fillLabel } from "@/lib/label-fill";

/**
 * An ApiError whose text is an editable label. The message is the DEFAULT wording filled with the runtime values (what direct callers and tests see); the API
 * handler re-resolves it against the administrator's current wording before responding (see `handle`). The HTTP status and control flow never depend on the wording.
 */
export type LabeledApiError = ApiError & { labelKey: LabelKey; labelVars: Record<string, string | number> };
export function labeledError(status: number, key: LabelKey, vars: Record<string, string | number> = {}): LabeledApiError {
  return Object.assign(new ApiError(status, fillLabel(DEFAULT_LABELS[key], vars)), { labelKey: key, labelVars: vars });
}
