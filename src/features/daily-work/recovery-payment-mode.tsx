"use client";

import { NativeSelect } from "@/components/ui/select";
import { useLabel } from "@/features/labels/label-ui";
import { RECOVERY_PAYMENT_MODES, type RecoveryPaymentMode } from "@/lib/daily-work";

/** Shared Recovery metadata display for the draft, frozen report and read-only review views. */
export function RecoveryPaymentModeField({
  value,
  onChange,
  disabled,
}: {
  value: RecoveryPaymentMode | null;
  onChange?: (value: RecoveryPaymentMode | null) => void;
  disabled?: boolean;
}) {
  const labels: Record<RecoveryPaymentMode, string> = {
    CHEQUE: useLabel("daily_work.payment_mode.cheque"),
    UPI: useLabel("daily_work.payment_mode.upi"),
    NEFT_RTGS: useLabel("daily_work.payment_mode.neft_rtgs"),
    CASH: useLabel("daily_work.payment_mode.cash"),
  };
  const placeholder = useLabel("daily_work.placeholder.payment_mode");
  const title = useLabel("daily_work.col.payment_mode");
  if (!onChange) return <span title={title}>{value == null ? "—" : labels[value]}</span>;
  return (
    <NativeSelect
      aria-label={title}
      className="h-8 w-full px-2"
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      options={RECOVERY_PAYMENT_MODES.map((mode) => ({ value: mode, label: labels[mode] }))}
      onChange={(event) =>
        onChange(event.target.value === "" ? null : (event.target.value as RecoveryPaymentMode))
      }
    />
  );
}

/** Preserve configurable header text, breaking after the first word (Monthly / Recovery Plan by default). */
export function MonthlyRecoveryPlanHeader({ label }: { label: string }) {
  const [first, ...rest] = label.trim().split(/\s+/);
  return (
    <>
      {first}
      {rest.length > 0 && (
        <>
          <br />
          <span className="whitespace-nowrap">{rest.join(" ")}</span>
        </>
      )}
    </>
  );
}
