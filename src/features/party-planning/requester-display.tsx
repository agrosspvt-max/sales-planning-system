import { TableCell } from "@/components/ui/table";

/** Display only: full territory names remain available to filtering and on hover. */
export function requesterTerritoryPreview(territory: string): string {
  const words = territory.trim().split(/\s+/);
  return words.length > 4 ? words.slice(0, 4).join(" ").replace(/[,;]+$/, "") + "…" : territory;
}

/** The "Requested by" cell everywhere in Territory Mapping: territory (truncated, full text on hover) above the requester's name in smaller muted text. */
export function RequesterCell({ territory, name, fallback }: { territory: string | null; name: string; fallback: string }) {
  const label = territory ?? fallback;
  return (
    <TableCell data-testid="requested-by">
      <div className="font-medium leading-tight"><span className="block max-w-72 truncate" title={label} aria-label={label}>{requesterTerritoryPreview(label)}</span></div>
      <div className="text-xs leading-tight text-muted-foreground">{name}</div>
    </TableCell>
  );
}

/** The Requested-by filter options: territory first (same truncation + tooltip), requester's name below, identity = the unique user id. */
export function requesterFilterOptions(choices: readonly { id: string; name: string; territory: string | null }[], fallback: string) {
  return choices.map((r) => {
    const label = r.territory ?? fallback;
    const preview = requesterTerritoryPreview(label);
    return { value: r.id, label, displayLabel: preview === label ? undefined : preview, secondary: r.name };
  });
}
