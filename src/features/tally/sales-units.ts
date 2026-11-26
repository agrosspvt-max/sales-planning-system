/** Normalize unit spelling only; never convert quantities or alter original bill units. */
export function salesUnit(unit: string) {
  const key = unit.trim().toLowerCase().replace(/\./g, "");
  if (["kg", "kgs", "kilogram", "kilograms"].includes(key)) return "kg";
  if (["l", "ltr", "ltrs", "litre", "litres", "liter", "liters"].includes(key)) return "litre";
  return key;
}
