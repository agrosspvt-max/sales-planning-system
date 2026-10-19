"use client";

import { useLabel } from "@/features/labels/label-ui";

/**
 * How an abandonment reads everywhere (Daily Report, Performance → Tasks, Daily Work Review): "Abandoned — Product Unavailable", "Abandoned — Other: <explanation>". A record made before reason
 * codes existed has only its free text: it is shown exactly as written, with no category guessed.
 */
export function useAbandonText(): { reasonName: (code: string) => string; summary: (code: string | null | undefined, reason: string | null | undefined) => string } {
  const names: Record<string, string> = {
    PRODUCT_UNAVAILABLE: useLabel("daily_work.outcome.reason_code.PRODUCT_UNAVAILABLE"), DEALER_REFUSED: useLabel("daily_work.outcome.reason_code.DEALER_REFUSED"),
    NO_DUES: useLabel("daily_work.outcome.reason_code.NO_DUES"), OTHER: useLabel("daily_work.outcome.reason_code.OTHER"),
  };
  const withName = useLabel("daily_work.outcome.abandoned_with");
  const other = useLabel("daily_work.outcome.abandoned_other");
  const legacy = useLabel("daily_work.outcome.result_abandoned");
  return {
    reasonName: (code) => names[code] ?? code,
    summary: (code, reason) => (!code ? legacy.replace("{reason}", reason ?? "") : code === "OTHER" ? other.replace("{text}", reason ?? "") : withName.replace("{reason}", names[code] ?? code)),
  };
}
