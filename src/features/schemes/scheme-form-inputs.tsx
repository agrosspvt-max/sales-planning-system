"use client";
import { useState, useEffect, useRef, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { formatSchemeDate, parseSchemeDate } from "@/lib/utils";
/** Keep the value passed to the API unchanged while making amounts and quantities easy to scan in India. */
function formatIndianNumber(value: string | number) {
  const raw = String(value ?? "").replace(/,/g, "");
  if (raw === "") return "";
  const match = raw.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match) return raw;
  const [, sign, integerPart, decimalPart] = match;
  const integer = integerPart || "0";
  const tail = integer.slice(-3);
  const head = integer.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${sign}${head ? `${head},` : ""}${tail}${decimalPart === undefined ? "" : `.${decimalPart}`}`;
}

function numericValue(value: string) {
  const unformatted = value.replace(/,/g, "").replace(/[^\d.]/g, "");
  const [integer = "", ...decimals] = unformatted.split(".");
  return decimals.length ? `${integer}.${decimals.join("")}` : integer;
}

function integerValue(value: string) {
  return value.replace(/,/g, "").replace(/\D/g, "");
}

export function FormattedNumberInput({
  value,
  onValueChange,
  integerOnly = false,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: string | number;
  onValueChange: (value: string) => void;
  integerOnly?: boolean;
}) {
  return (
    <Input
      {...props}
      type="text"
      inputMode={integerOnly ? "numeric" : "decimal"}
      value={formatIndianNumber(value)}
      onChange={(e) => onValueChange(integerOnly ? integerValue(e.target.value) : numericValue(e.target.value))}
    />
  );
}

export function SchemeDateInput({
  value,
  onValueChange,
  ...props
}: { value: string; onValueChange: (value: string) => void } & Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type"
>) {
  const dateInput = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = useState(() => (value ? formatSchemeDate(value) : ""));
  useEffect(() => setDisplayValue(value ? formatSchemeDate(value) : ""), [value]);
  const commit = () => {
    if (!displayValue.trim()) return onValueChange("");
    const parsed = parseSchemeDate(displayValue.trim());
    if (
      parsed &&
      (!props.min || parsed >= String(props.min)) &&
      (!props.max || parsed <= String(props.max))
    )
      onValueChange(parsed);
    else setDisplayValue(value ? formatSchemeDate(value) : "");
  };
  const openPicker = () => {
    try {
      dateInput.current?.showPicker?.();
    } catch {
      /* Keep manual entry available if the browser blocks the picker. */
    }
  };
  return (
    <div className="relative">
      <Input
        {...props}
        type="text"
        inputMode="numeric"
        value={displayValue}
        onClick={openPicker}
        onChange={(e) => setDisplayValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openPicker();
          }
        }}
        placeholder="DD/MM/YYYY"
      />
      <input
        ref={dateInput}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        value={value}
        onChange={(e) => {
          setDisplayValue(formatSchemeDate(e.target.value));
          onValueChange(e.target.value);
        }}
      />
    </div>
  );
}
